import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { json, now, type AppDatabase } from '../db/database.js';
import { LLMProvider } from '../llm/provider.js';
import { AgentPlanSchema, type HealthReport, type ToolName, type ToolResult } from '../../../shared/src/types.js';
import { TOOL_REGISTRY } from '../tools/registry.js';
import { ToolRunner } from '../tools/runner.js';
import { createConfirmation } from './confirmations.js';
import { rejectPromptInjection } from '../../../shared/src/validation.js';

type StreamEvent = { content: string; done: boolean; error?: string };
export const streamEvents = new Map<string, StreamEvent>();

export class Orchestrator {
  constructor(private readonly db: AppDatabase, private readonly runner: ToolRunner, private readonly llm: LLMProvider) {}

  async chat(userId: string, prompt: string, requestId: string = randomUUID()): Promise<{ requestId: string; content: string; confirmation?: ReturnType<typeof createConfirmation>; tools: ToolResult[] }> {
    const cleanPrompt = rejectPromptInjection(prompt).trim();
    let response: { content: string; tools: ToolResult[]; confirmation?: ReturnType<typeof createConfirmation> };
    if (/\b(is|how)\b.*\b(server|system)\b.*\b(healthy|health)\b|server health|health check/i.test(cleanPrompt)) response = await this.health(userId, requestId);
    else if (/website|site|webpage|domain|down|502|503|nginx/i.test(cleanPrompt)) response = await this.diagnose(userId, requestId, cleanPrompt);
    else response = await this.llmChat(userId, requestId, cleanPrompt);
    streamEvents.set(requestId, { content: response.content, done: true });
    setTimeout(() => streamEvents.delete(requestId), 60_000);
    return { requestId, ...response, tools: response.tools };
  }

  private async run(userId: string, requestId: string, tool: ToolName, args: Record<string, unknown>): Promise<ToolResult> { return this.runner.run(userId, requestId, tool, args); }

  async health(userId: string, requestId: string = randomUUID()): Promise<{ content: string; tools: ToolResult[] }> {
    const specs: Array<[ToolName, Record<string, unknown>]> = [
      ['system.getResources', {}], ['system.getLoad', {}], ['system.getUptime', {}], ['disk.getUsage', {}], ['memory.getUsage', {}],
      ['docker.getStatus', {}], ['docker.getContainers', {}], ['docker.getDiskUsage', {}], ['pm2.getStatus', {}], ['nginx.getStatus', {}],
      ['nginx.testConfig', {}], ['network.getListeningPorts', {}], ['systemd.getFailedServices', {}], ['logs.getCritical', { lines: 50 }]
    ];
    const tools = await Promise.all(specs.map(([tool, args]) => this.run(userId, requestId, tool, args)));
    const resources = dataOf(tools, 'system.getResources') as Record<string, unknown> | undefined;
    const load = dataOf(tools, 'system.getLoad') as Record<string, unknown> | undefined;
    const warnings: string[] = []; const criticalIssues: string[] = [];
    const cpu = numberValue(resources?.cpuPercent); const ram = numberValue(resources?.ramPercent); const swap = numberValue(resources?.swapPercent); const load1 = numberValue(load?.load1);
    if (cpu >= config.CPU_CRITICAL_PERCENT) criticalIssues.push(`CPU usage is ${cpu}%`); else if (cpu >= config.CPU_WARNING_PERCENT) warnings.push(`CPU usage is ${cpu}%`);
    if (ram >= config.RAM_CRITICAL_PERCENT) criticalIssues.push(`RAM usage is ${ram}%`); else if (ram >= config.RAM_WARNING_PERCENT) warnings.push(`RAM usage is ${ram}%`);
    const diskText = String((dataOf(tools, 'disk.getUsage') as Record<string, unknown> | undefined)?.stdout ?? ''); const diskPercents = [...diskText.matchAll(/\s(\d+)%\s/g)].map((m) => Number(m[1])); const disk = Math.max(0, ...diskPercents);
    if (disk >= config.DISK_CRITICAL_PERCENT) criticalIssues.push(`Disk usage is ${disk}%`); else if (disk >= config.DISK_WARNING_PERCENT) warnings.push(`Disk usage is ${disk}%`);
    if (load1 > (load?.cpuCount ? numberValue(load.cpuCount) * config.LOAD_WARNING_MULTIPLIER : Infinity)) warnings.push(`Load average is ${load1}`);
    const check = (tool: ToolName, label: string): void => { const r = tools.find((v) => v.tool === tool); const payload = r?.data as Record<string, unknown> | undefined; const text = `${payload?.stdout ?? ''} ${payload?.stderr ?? ''}`.toLowerCase(); if (!r?.ok || (payload?.exitCode !== undefined && payload.exitCode !== 0)) warnings.push(`${label} is unavailable or reported a non-zero status`); };
    check('docker.getStatus', 'Docker'); check('pm2.getStatus', 'PM2'); check('nginx.getStatus', 'Nginx'); check('nginx.testConfig', 'Nginx configuration');
    const failed = String((dataOf(tools, 'systemd.getFailedServices') as Record<string, unknown> | undefined)?.stdout ?? '').trim(); if (failed) warnings.push('Failed systemd services were reported');
    const criticalLogs = String((dataOf(tools, 'logs.getCritical') as Record<string, unknown> | undefined)?.stdout ?? '').trim(); if (criticalLogs) warnings.push('Recent critical system logs were found');
    const health: HealthReport['health'] = criticalIssues.length ? 'CRITICAL' : warnings.length ? 'WARNING' : 'GOOD';
    const lines = [`HEALTH: ${health}`, '', `CPU: ${format(cpu)}%`, `RAM: ${format(ram)}%`, `SWAP: ${format(swap)}%`, `DISK: ${disk || 'unknown'}%`, `LOAD: ${format(load1)}`, `DOCKER: ${status(tools, 'docker.getStatus')}`, `PM2: ${status(tools, 'pm2.getStatus')}`, `NGINX: ${status(tools, 'nginx.getStatus')}`, `PORTS: ${status(tools, 'network.getListeningPorts')}`, `SYSTEMD: ${failed ? 'WARNING' : 'OK'}`, `CRITICAL LOGS: ${criticalLogs ? 'FOUND' : 'NONE'}`, '', 'Warnings:', ...(warnings.length ? warnings.map((v) => `- ${v}`) : ['- None']), '', 'Critical issues:', ...(criticalIssues.length ? criticalIssues.map((v) => `- ${v}`) : ['- None']), '', 'Evidence:', `- Collected at ${now()}`, `- ${tools.filter((v) => v.ok).length}/${tools.length} deterministic tools returned successfully`];
    return { content: lines.join('\n'), tools };
  }

  private async diagnose(userId: string, requestId: string, prompt: string): Promise<{ content: string; tools: ToolResult[] }> {
    const domain = extractDomain(prompt) ?? process.env.SITE_DOMAIN;
    if (!domain) return { content: 'Which domain should I inspect? Multiple websites may be configured, and I will investigate the selected domain before proposing any action.', tools: [] };
    const url = /https?:\/\//i.test(prompt) ? (prompt.match(/https?:\/\/[^\s]+/i)?.[0] ?? `https://${domain}`) : `https://${domain}`;
    const specs: Array<[ToolName, Record<string, unknown>]> = [['nginx.getStatus', {}], ['nginx.testConfig', {}], ['network.getListeningPorts', {}], ['pm2.getStatus', {}], ['docker.getContainers', {}], ['logs.getApplicationErrors', { lines: 80 }], ['logs.getCritical', { lines: 50 }], ['system.getResources', {}], ['http.checkWebsite', { url }], ['dns.resolveConfiguredDomain', { domain }]];
    if (url.startsWith('https://')) specs.push(['ssl.checkCertificate', { domain, port: 443 }]);
    const tools = await Promise.all(specs.map(([tool, args]) => this.run(userId, requestId, tool, args)));
    const site = dataOf(tools, 'http.checkWebsite') as Record<string, unknown> | undefined; const nginx = dataOf(tools, 'nginx.getStatus') as Record<string, unknown> | undefined; const nginxTest = dataOf(tools, 'nginx.testConfig') as Record<string, unknown> | undefined; const errors = dataOf(tools, 'logs.getApplicationErrors') as Record<string, unknown> | undefined;
    const httpStatus = numberValue(site?.status); const nginxDown = String(nginx?.stdout ?? '').trim() !== 'active'; const configBad = Number(nginxTest?.exitCode) !== 0; const diagnosis = httpStatus >= 500 ? `The configured domain ${domain} is returning HTTP ${httpStatus}.` : nginxDown ? `Nginx is not active for ${domain}.` : configBad ? `Nginx configuration validation failed while investigating ${domain}.` : site?.error ? `The local HTTP check could not reach ${domain}.` : `No single outage cause was proven for ${domain}; the collected evidence is inconclusive.`;
    const exact = nginxDown ? 'systemctl start nginx' : configBad ? 'nginx -t, then review the reported configuration error' : httpStatus >= 500 ? 'Inspect the application process/container logs and restart only the affected allowlisted workload after confirmation' : 'No change recommended until the evidence is reviewed';
    return { content: [`PROBLEM:`, diagnosis, '', 'EVIDENCE:', `- Domain: ${domain}`, `- HTTP: ${site?.status ?? site?.error ?? 'unknown'}${site?.latencyMs ? ` (${site.latencyMs}ms)` : ''}`, `- Nginx: ${nginx?.stdout ?? 'unknown'}`, `- Nginx config test: ${nginxTest?.exitCode === 0 ? 'passed' : 'failed'}`, `- Application errors: ${errors?.stdout ? 'present' : 'none returned'}`, `- Evidence collected at ${now()}`, '', 'RECOMMENDED FIX:', 'Review the evidence and apply the smallest allowlisted change only after confirmation.', '', 'EXACT ACTION:', exact, '', 'RISK:', nginxDown || configBad ? 'MEDIUM' : 'LOW', '', 'No action was performed automatically.'].join('\n'), tools };
  }

  private async llmChat(userId: string, requestId: string, prompt: string): Promise<{ content: string; tools: ToolResult[]; confirmation?: ReturnType<typeof createConfirmation> }> {
    try {
      const completion = await this.llm.complete([{ role: 'system', content: `You are a cautious Ubuntu infrastructure reasoning layer. Never emit shell commands. Return strict JSON only matching {kind:"answer"|"tool_plan",message:string,tools:[{tool:string,args:object,reason:string}],risk:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL",requiresConfirmation:boolean}. Use only registered tools. Read-only investigation first. ${JSON.stringify(Object.values(TOOL_REGISTRY).map((t) => ({ name: t.name, description: t.description, risk: t.risk })))} ` }, { role: 'user', content: prompt }], requestId, true);
      this.db.db.prepare('INSERT INTO provider_usage (id,provider,model,request_id,input_tokens,output_tokens,latency_ms,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), config.LLM_PROVIDER, completion.model, requestId, completion.usage?.prompt_tokens ?? null, completion.usage?.completion_tokens ?? null, null, 'ok', now());
      const parsed = AgentPlanSchema.parse(JSON.parse(stripJsonFence(completion.content)));
      const tools: ToolResult[] = [];
      for (const planned of parsed.tools.slice(0, config.LLM_MAX_AGENT_STEPS)) {
        const definition = TOOL_REGISTRY[planned.tool]; if (definition.requiresConfirmation) { const confirmation = createConfirmation(this.db, userId, planned.tool, planned.args, planned.reason); return { content: `${parsed.message}\n\nConfirmation required before this action:\n- Tool: ${planned.tool}\n- Risk: ${definition.risk}\n- Impact: ${planned.reason}\n- Action hash: ${confirmation.actionHash}\n- Expires: ${confirmation.expiresAt}`, tools, confirmation }; }
        tools.push(await this.run(userId, requestId, planned.tool, planned.args));
      }
      return { content: parsed.message + (tools.length ? `\n\nEvidence collected from ${tools.length} allowlisted tool(s).` : ''), tools };
    } catch (error) { return { content: `The remote reasoning provider is unavailable or returned invalid data. Deterministic server tools remain available. Error category: ${error instanceof Error ? error.message : 'provider_error'}`, tools: [] }; }
  }
}

function stripJsonFence(text: string): string { return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); }
function dataOf(tools: ToolResult[], tool: ToolName): unknown { return tools.find((v) => v.tool === tool)?.data; }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function format(value: number): string { return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, '') : 'unknown'; }
function status(tools: ToolResult[], tool: ToolName): string { const r = tools.find((v) => v.tool === tool); return r?.ok ? 'OK' : 'UNAVAILABLE'; }
function extractDomain(prompt: string): string | null { const match = prompt.match(/(?:https?:\/\/)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:\/[\w./-]*)?/); return match?.[1]?.toLowerCase() ?? null; }
