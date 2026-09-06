import { config } from '../config.js';
import { log } from '../logging/logger.js';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type Completion = { content: string; model: string; message: Extract<ChatMessage, { role: 'assistant' }>; toolCalls: ToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export class LLMProviderError extends Error {
  constructor(readonly category: 'unavailable' | 'timeout' | 'provider' | 'invalid_json' | 'invalid_tool_call', message: string) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

export class LLMProvider {
  async complete(messages: ChatMessage[], requestId: string, structured = false, tools: ChatTool[] = []): Promise<Completion> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) throw new LLMProviderError('unavailable', 'LLM_UNAVAILABLE');
    const models = [config.LLM_MODEL, ...config.LLM_FALLBACK_MODELS].filter((model, index, all) => model && all.indexOf(model) === index);
    let lastError: LLMProviderError = new LLMProviderError('provider', 'LLM request failed');
    for (const model of models) {
      for (let attempt = 0; attempt <= config.LLM_MAX_RETRIES; attempt += 1) {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
        try {
          const body = await this.request(model, messages, requestId, structured, tools, controller.signal);
          const completion = parseCompletion(body, model, structured);
          await log('ai', 'llm.complete', { requestId, provider: config.LLM_PROVIDER, model, latencyMs: Date.now() - started, usage: body.usage, status: 'ok', toolCalls: completion.toolCalls.length });
          return completion;
        } catch (error) {
          lastError = normalizeProviderError(error);
          await log('ai', 'llm.error', { requestId, provider: config.LLM_PROVIDER, model, attempt, category: lastError.category, error: lastError.message });
          if (attempt < config.LLM_MAX_RETRIES) await delay(Math.min(250 * 2 ** attempt, 3000));
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw lastError;
  }

  private async request(model: string, messages: ChatMessage[], requestId: string, structured: boolean, tools: ChatTool[], signal: AbortSignal): Promise<ProviderBody> {
    let response: Response;
    try {
      response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${config.LLM_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Sentinel' },
        body: JSON.stringify({ model, messages, temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS, ...(structured && !tools.length ? { response_format: { type: 'json_object' } } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) })
      });
    } catch (error) {
      if (signal.aborted) throw new LLMProviderError('timeout', 'LLM request timed out');
      throw new LLMProviderError('unavailable', error instanceof Error ? error.message : 'LLM is unreachable');
    }
    const raw = await response.text();
    if (!response.ok) {
      const category = response.status === 408 || response.status === 429 || response.status >= 500 ? 'provider' : 'unavailable';
      throw new LLMProviderError(category, `Provider returned HTTP ${response.status}`);
    }
    try { return JSON.parse(raw) as ProviderBody; } catch { throw new LLMProviderError('invalid_json', 'Provider returned invalid JSON'); }
  }

  async stream(messages: ChatMessage[], requestId: string, onDelta: (delta: string) => void, tools: ChatTool[] = []): Promise<void> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) throw new LLMProviderError('unavailable', 'LLM_UNAVAILABLE');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${config.LLM_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.LLM_MODEL, messages, temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS, stream: true, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }) });
      if (!response.ok || !response.body) throw new LLMProviderError('provider', `Provider returned HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
        for (const line of lines) { if (!line.startsWith('data:')) continue; const payload = line.slice(5).trim(); if (payload === '[DONE]') continue; try { const value = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }; const delta = value.choices?.[0]?.delta?.content; if (delta) onDelta(delta); } catch { /* Ignore one malformed stream frame; the non-streaming agent path remains authoritative. */ } }
      }
      await log('ai', 'llm.stream.complete', { requestId, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, status: 'ok' });
    } catch (error) { if (controller.signal.aborted) throw new LLMProviderError('timeout', 'LLM stream timed out'); throw error; }
    finally { clearTimeout(timer); }
  }

  async health(): Promise<{ configured: boolean; provider: string; model: string; reachable: boolean; error?: string }> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) return { configured: false, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: false, error: 'API key is not configured' };
    try { const response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${config.LLM_API_KEY}` }, signal: AbortSignal.timeout(Math.min(config.LLM_TIMEOUT_MS, 10000)) }); return { configured: true, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: response.ok, ...(response.ok ? {} : { error: `provider ${response.status}` }) }; }
    catch (error) { return { configured: true, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: false, error: error instanceof Error ? error.message : 'unreachable' }; }
  }
}

type ProviderBody = { choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: Completion['usage'] };

function parseCompletion(body: ProviderBody, model: string, structured: boolean): Completion {
  const raw = body.choices?.[0]?.message;
  if (!raw) throw new LLMProviderError('provider', 'Provider returned no assistant message');
  const toolCalls: ToolCall[] = (raw.tool_calls ?? []).map((call) => {
    if (!call.id || call.type !== 'function' || !call.function?.name || typeof call.function.arguments !== 'string') throw new LLMProviderError('invalid_tool_call', 'Provider returned an invalid tool call');
    // Validate the transport envelope here. Argument shape is validated by AgentRuntime with the tool's Zod schema.
    try { JSON.parse(call.function.arguments); } catch { throw new LLMProviderError('invalid_tool_call', 'Provider returned invalid tool arguments'); }
    return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
  });
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!toolCalls.length && !content.trim()) throw new LLMProviderError('provider', 'Provider returned an empty assistant message');
  if (structured && !toolCalls.length) { try { JSON.parse(stripJsonFence(content)); } catch { throw new LLMProviderError('invalid_json', 'Provider returned invalid structured JSON'); } }
  const message: Extract<ChatMessage, { role: 'assistant' }> = toolCalls.length ? { role: 'assistant', content: content || null, tool_calls: toolCalls } : { role: 'assistant', content };
  return { content, model, message, toolCalls, ...(body.usage ? { usage: body.usage } : {}) };
}

function normalizeProviderError(error: unknown): LLMProviderError { return error instanceof LLMProviderError ? error : new LLMProviderError('provider', error instanceof Error ? error.message : 'LLM request failed'); }
function stripJsonFence(text: string): string { return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
