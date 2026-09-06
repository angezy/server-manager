import { config } from '../config.js';
import { log } from '../logging/logger.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
type Completion = { content: string; model: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export class LLMProvider {
  async complete(messages: ChatMessage[], requestId: string, structured = true, tools: unknown[] = []): Promise<Completion> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) throw new Error('LLM_UNAVAILABLE');
    const models = [config.LLM_MODEL, ...config.LLM_FALLBACK_MODELS]; let lastError = 'LLM request failed';
    for (const model of models) {
      for (let attempt = 0; attempt <= config.LLM_MAX_RETRIES; attempt++) {
        const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
        try {
          const response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${config.LLM_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Ubuntu Server Manager' }, body: JSON.stringify({ model, messages, temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS, ...(structured ? { response_format: { type: 'json_object' } } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }) });
          const raw = await response.text(); if (!response.ok) { if (response.status === 429 || response.status >= 500) { lastError = `provider ${response.status}`; await delay(Math.min(1000 * 2 ** attempt, 5000)); continue; } throw new Error(`provider ${response.status}`); }
          const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }>; usage?: Completion['usage'] }; const content = body.choices?.[0]?.message?.content; if (!content) throw new Error('Provider returned no content');
          await log('ai', 'llm.complete', { requestId, provider: config.LLM_PROVIDER, model, latencyMs: Date.now() - started, usage: body.usage, status: 'ok' }); const completion: Completion = { content, model }; if (body.usage) completion.usage = body.usage; return completion;
        } catch (error) { lastError = error instanceof Error ? error.message : 'LLM request failed'; await log('ai', 'llm.error', { requestId, provider: config.LLM_PROVIDER, model, attempt, error: lastError }); if (attempt < config.LLM_MAX_RETRIES) await delay(Math.min(1000 * 2 ** attempt, 5000)); }
        finally { clearTimeout(timer); }
      }
    }
    throw new Error(lastError);
  }

  async stream(messages: ChatMessage[], requestId: string, onDelta: (delta: string) => void, tools: unknown[] = []): Promise<void> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) throw new Error('LLM_UNAVAILABLE');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${config.LLM_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.LLM_MODEL, messages, temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS, stream: true, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }) });
      if (!response.ok || !response.body) throw new Error(`provider ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data:')) continue; const payload = line.slice(5).trim(); if (payload === '[DONE]') continue; try { const value = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }; const delta = value.choices?.[0]?.delta?.content; if (delta) onDelta(delta); } catch { /* ignore incomplete provider frames */ } } }
      await log('ai', 'llm.stream.complete', { requestId, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, status: 'ok' });
    } finally { clearTimeout(timer); }
  }

  async health(): Promise<{ configured: boolean; provider: string; model: string; reachable: boolean; error?: string }> {
    if (!config.LLM_ENABLED || !config.LLM_API_KEY) return { configured: false, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: false, error: 'API key is not configured' };
    try { const response = await fetch(`${config.LLM_BASE_URL.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${config.LLM_API_KEY}` }, signal: AbortSignal.timeout(Math.min(config.LLM_TIMEOUT_MS, 10000)) }); return { configured: true, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: response.ok, ...(response.ok ? {} : { error: `provider ${response.status}` }) }; } catch (error) { return { configured: true, provider: config.LLM_PROVIDER, model: config.LLM_MODEL, reachable: false, error: error instanceof Error ? error.message : 'unreachable' }; }
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
