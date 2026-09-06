import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { type AppDatabase } from '../db/database.js';
import { LLMProvider, type ChatMessage } from '../llm/provider.js';
import { createConfirmation, type Confirmation } from './confirmations.js';
import { getToolDefinition, LLM_TOOL_DEFINITIONS, validateToolArgs } from '../tools/registry.js';
import { ToolRunner } from '../tools/runner.js';
import { rejectPromptInjection } from '../../../shared/src/validation.js';
import { ToolName, type ToolResult, type User } from '../../../shared/src/types.js';

export type IntentHint = 'hiddify' | 'server_health' | 'website_diagnosis' | 'logs' | 'configuration' | 'file_inspection' | 'service_troubleshooting' | 'deployment' | 'general' | 'ambiguous';
export type AgentRuntimeInput = { userId: string; prompt: string; requestId?: string; context?: ChatMessage[]; userRole?: User['role'] };
export type AgentRuntimeResult = { requestId: string; content: string; tools: ToolResult[]; confirmation?: Confirmation };
export type DeterministicWorkflows = { health: (userId: string, requestId: string) => Promise<{ content: string; tools: ToolResult[] }>; diagnose: (userId: string, requestId: string, prompt: string) => Promise<{ content: string; tools: ToolResult[] }> };

const INVALID_PROVIDER_RESPONSE = 'The AI reasoning provider returned an invalid response. Deterministic server tools remain available. No change was performed.';

/** The runtime is the workflow controller. Intent is only an initial hint and policy guard. */
export class AgentRuntime {
  constructor(private readonly db: AppDatabase, private readonly runner: ToolRunner, private readonly llm: LLMProvider, private readonly deterministic?: DeterministicWorkflows) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const requestId = input.requestId ?? randomUUID();
    const prompt = rejectPromptInjection(input.prompt).trim();
    const intent = classifyIntent(prompt);
    if (intent === 'ambiguous') return { requestId, content: 'What should I inspect or change—server health, a website/domain, Hiddify, logs, files, or a service?', tools: [] };
    // Hiddify is a safety-critical workflow guard. It wins even when the prompt also mentions sites, Docker, VPN, or Nginx.
    if (intent === 'hiddify') return this.hiddifyWorkflow(input.userId, requestId, prompt);
    // Deterministic workflows are a degraded-mode fallback for an unconfigured provider. When a provider is available,
    // even health and website requests go through the same LLM/tool loop below.
    if ((!config.LLM_ENABLED || !config.LLM_API_KEY) && this.deterministic?.health && intent === 'server_health') return { requestId, ...(await this.deterministic.health(input.userId, requestId)) };
    if ((!config.LLM_ENABLED || !config.LLM_API_KEY) && this.deterministic?.diagnose && intent === 'website_diagnosis') return { requestId, ...(await this.deterministic.diagnose(input.userId, requestId, prompt)) };
    const deterministic = await this.deterministicWorkflow(input.userId, requestId, prompt, intent);
    if (deterministic) return deterministic;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemInstructions(intent) },
      ...(input.context ?? []).slice(-20),
      { role: 'user', content: prompt }
    ];
    const tools: ToolResult[] = [];
    try {
      for (let step = 0; step < config.LLM_MAX_AGENT_STEPS; step += 1) {
        const completion = await this.llm.complete(messages, requestId, false, LLM_TOOL_DEFINITIONS);
        messages.push(completion.message);
        if (!completion.toolCalls.length) return { requestId, content: completion.content.trim(), tools };

        // Validate every requested call before executing any of them. This prevents a later invalid call from
        // being hidden behind a partially executed assistant turn.
        const calls: Array<{ call: (typeof completion.toolCalls)[number]; name: import('../../../shared/src/types.js').ToolName; args: Record<string, unknown>; definition: NonNullable<ReturnType<typeof getToolDefinition>> }> = [];
        for (const call of completion.toolCalls) {
          const parsedName = ToolName.safeParse(call.function.name);
          if (!parsedName.success) { messages.push({ role: 'tool', tool_call_id: call.id, content: safeJson({ ok: false, error: 'Unknown tool' }) }); continue; }
          const definition = getToolDefinition(parsedName.data);
          if (!definition || !definition.canonical) { messages.push({ role: 'tool', tool_call_id: call.id, content: safeJson({ ok: false, error: 'Tool is not available to the agent' }) }); continue; }
          try {
            const args = validateToolArgs(parsedName.data, JSON.parse(call.function.arguments));
            calls.push({ call, name: parsedName.data, args, definition });
          } catch { messages.push({ role: 'tool', tool_call_id: call.id, content: safeJson({ ok: false, error: 'Tool arguments failed validation' }) }); }
        }

        for (const planned of calls) {
          if (planned.definition.requiresConfirmation) {
            if (input.userRole === 'viewer' || this.roleFor(input.userId) === 'viewer') return { requestId, content: 'You have permission to inspect the server, but modifying operations require an operator or administrator account.', tools };
            const confirmation = createConfirmation(this.db, input.userId, planned.name, planned.args, `${planned.definition.description} Exact target: ${confirmationTarget(planned.args)}`);
            return { requestId, content: confirmationText(confirmation, planned.definition.description), tools, confirmation };
          }
          const result = await this.runner.run(input.userId, requestId, planned.name, planned.args);
          tools.push(result);
          messages.push({ role: 'tool', tool_call_id: planned.call.id, content: safeJson(result) });
        }
      }
      return { requestId, content: 'The agent reached its investigation step limit before producing a final answer. No unconfirmed change was performed.', tools };
    } catch (error) {
      return { requestId, content: error instanceof Error && /permission/i.test(error.message) ? 'This account is not permitted to perform that operation.' : INVALID_PROVIDER_RESPONSE, tools };
    }
  }

  private async deterministicWorkflow(userId: string, requestId: string, prompt: string, intent: IntentHint): Promise<AgentRuntimeResult | null> {
    if (intent === 'logs' && /\b(?:backend|api|server-manager)\b/i.test(prompt)) {
      const tool = await this.runner.run(userId, requestId, 'journal_logs', { service: 'server-manager-api', lines: 80 });
      return { requestId, content: `Backend logs (server-manager-api):\n\n${tool.ok ? 'Collected successfully.' : `The log tool failed: ${tool.error?.message ?? 'unavailable'}`}\n\nEvidence was collected by the bounded journal_logs tool.`, tools: [tool] };
    }
    if ((!config.LLM_ENABLED || !config.LLM_API_KEY) && intent === 'service_troubleshooting') {
      const requestedTool = /\b(?:docker|container)\b.*\b(?:status|running|healthy|health)\b/i.test(prompt) ? 'docker_status' : /\bpm2\b.*\b(?:status|process|running|healthy)\b/i.test(prompt) ? 'pm2_status' : /\bnginx\b.*\b(?:status|config|configuration|test|healthy)\b/i.test(prompt) ? 'nginx_test' : /\bport(?:s|\s+listening)?\b/i.test(prompt) ? 'listening_ports' : null;
      if (requestedTool) { const tool = await this.runner.run(userId, requestId, requestedTool, {}); return { requestId, content: `${requestedTool} evidence was collected.`, tools: [tool] }; }
    }
    if (intent === 'configuration' && /^\s*(?:please\s+)?(?:restart|reload)\s+(?:the\s+)?api\s*[?.!]?\s*$/i.test(prompt)) {
      if (this.roleFor(userId) === 'viewer') return { requestId, content: 'You have permission to inspect the server, but modifying operations require an operator or administrator account.', tools: [] };
      const confirmation = createConfirmation(this.db, userId, 'restart_service', { service: 'server-manager-api' }, 'Restart the exact allowlisted server-manager-api service.');
      return { requestId, content: confirmationText(confirmation, 'Restart server-manager-api'), tools: [], confirmation };
    }
    if (intent === 'configuration' && /^\s*(?:please\s+)?reload\s+(?:the\s+)?nginx\s*[?.!]?\s*$/i.test(prompt)) {
      if (this.roleFor(userId) === 'viewer') return { requestId, content: 'You have permission to inspect the server, but modifying operations require an operator or administrator account.', tools: [] };
      const confirmation = createConfirmation(this.db, userId, 'reload_nginx', {}, 'Validate Nginx, then reload the Nginx service.');
      return { requestId, content: confirmationText(confirmation, 'Validate and reload Nginx'), tools: [], confirmation };
    }
    return null;
  }

  private async hiddifyWorkflow(userId: string, requestId: string, prompt: string): Promise<AgentRuntimeResult> {
    const inventory = await this.runner.run(userId, requestId, 'hiddify_inventory', {});
    const findings = extractFindings(inventory);
    const unrelated = extractUnrelated(inventory);
    const lines = ['HIDDIFY INVENTORY', '', 'Inventory completed without modifying the server.', '', 'Findings:'];
    if (!findings.length) lines.push('- No definite Hiddify artifacts were returned by the Host Agent.');
    else for (const finding of findings) lines.push(`- ${finding.classification.toUpperCase()} ${finding.kind}: ${finding.identifier}\n  Evidence: ${finding.evidence}`);
    if (unrelated.length) lines.push('', `Unrelated infrastructure excluded: ${unrelated.join(', ')}.`);
    lines.push('', 'Impact: deleting an artifact can stop Hiddify, alter traffic routing, or remove persistent data. Unrelated services and websites are excluded.');
    const wantsChange = /\b(remove|delete|clean(?:up)?|uninstall|purge)\b/i.test(prompt);
    if (wantsChange && this.roleFor(userId) === 'viewer') { lines.push('', 'This account may inventory Hiddify but cannot approve modifying operations.'); return { requestId, content: lines.join('\n'), tools: [inventory] }; }
    const removable = findings.find((finding) => finding.classification === 'definite' && ['file', 'directory', 'service', 'container', 'volume', 'cron', 'nginx_reference'].includes(finding.kind));
    if (wantsChange && removable) {
      const kind = removable.kind as 'file' | 'directory' | 'service' | 'container' | 'volume' | 'cron' | 'nginx_reference';
      const confirmation = createConfirmation(this.db, userId, 'remove_hiddify_artifact', { kind, path: removable.identifier }, `Remove this exact Hiddify artifact after inventory review: ${removable.identifier}. No other artifact will be touched.`);
      lines.push('', 'Explicit YES confirmation is required before deletion.');
      return { requestId, content: `${lines.join('\n')}\n\n${confirmationText(confirmation, 'Remove one exact inventory-confirmed Hiddify artifact')}`, tools: [inventory], confirmation };
    }
    if (wantsChange) lines.push('', 'No deletion was proposed because no exact, definite, removable Hiddify artifact was identified.');
    return { requestId, content: lines.join('\n'), tools: [inventory] };
  }

  private roleFor(userId: string): User['role'] | undefined { const row = this.db.db.prepare('SELECT role FROM users WHERE id=?').get(userId) as { role?: User['role'] } | undefined; return row?.role; }
}

export function classifyIntent(prompt: string): IntentHint {
  const value = prompt.trim().toLowerCase();
  if (!value || /^(help|what can you do|check it|fix it|clean it up|do it)$/i.test(value)) return 'ambiguous';
  if (/\bhiddify\b/i.test(value)) return 'hiddify';
  if (/(?:server|system)\s+(?:health|status|healthy|okay|ok)|(?:is|are)\s+(?:my|the)\s+server\s+(?:healthy|okay|ok|up)/i.test(value)) return 'server_health';
  if (/(?:website|web\s*site|site|webpage|domain).*(?:down|unreachable|offline|broken|fail|502|503|diagnos|inspect|check|why)|(?:down|unreachable|offline|502|503).*(?:website|web\s*site|site|webpage|domain)/i.test(value)) return 'website_diagnosis';
  if (/\b(?:log|logs|journal|traceback|stack trace)\b/i.test(value)) return 'logs';
  if (/\b(?:delete|remove|write|edit|change|configure|restart|reload|enable|disable)\b/i.test(value)) return 'configuration';
  if (/\b(?:find|search|read|inspect|list|show)\b.*\b(?:file|files|directory|directories|git|diff|config|configuration)\b/i.test(value)) return 'file_inspection';
  if (/\b(?:service|systemd|daemon|process|pm2|docker|nginx)\b/i.test(value)) return 'service_troubleshooting';
  if (/\b(?:deploy|deployment|build|compile|release|ci|pipeline)\b/i.test(value)) return 'deployment';
  if (value.length < 8) return 'ambiguous';
  return 'general';
}

function systemInstructions(intent: IntentHint): string {
  return `You are Sentinel, a cautious infrastructure assistant. Initial intent hint: ${intent}. Use the typed tools to gather evidence, then reason over tool results. Never emit or execute shell commands. Never invent tool results. Read-only tools may run without confirmation; every modifying tool requires confirmation and the exact arguments must be reviewed. Respect path, service, container, and risk allowlists. Do not read or reveal secrets, .env files, API keys, passwords, or private keys. Do not use SITE_DOMAIN unless the user explicitly asks about a website or domain. Return a concise final answer with evidence, uncertainty, and whether any action was performed.`;
}

function confirmationText(confirmation: Confirmation, description: string): string { return `Confirmation required before this action:\n- Action: ${description}\n- Tool: ${confirmation.toolName}\n- Risk: ${confirmation.risk}\n- Impact: ${confirmation.impact}\n- Exact action hash: ${confirmation.actionHash}\n- Expires: ${confirmation.expiresAt}\n\nApprove this exact action only after review (explicit YES).`; }
function safeJson(value: unknown): string { try { return JSON.stringify(value, (_key, current) => typeof current === 'string' ? current.slice(0, 12000) : current); } catch { return '{"error":"unserializable tool result"}'; } }
function confirmationTarget(args: Record<string, unknown>): string { const target = args.path ?? args.service ?? args.unit ?? args.name; if (typeof args.content === 'string') return `${String(target ?? 'exact target')} (${args.content.length} bytes; content is held server-side and is not shown here)`; return typeof target === 'string' ? target : safeJson(args); }
function extractFindings(inventory: ToolResult): Array<{ kind: string; identifier: string; classification: string; evidence: string }> { const data = inventory.data as { findings?: Array<{ kind?: string; identifier?: string; classification?: string; evidence?: string }> } | undefined; return (data?.findings ?? []).filter((item) => item.kind && item.identifier && item.classification && item.evidence).map((item) => ({ kind: String(item.kind), identifier: String(item.identifier), classification: String(item.classification), evidence: String(item.evidence) })); }
function extractUnrelated(inventory: ToolResult): string[] { const data = inventory.data as { unrelated?: Array<{ source?: string; classification?: string }> } | undefined; return (data?.unrelated ?? []).filter((item) => item.classification === 'unrelated' && item.source).map((item) => String(item.source)); }
