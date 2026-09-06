import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentRuntime, classifyIntent } from '../backend/src/agent/runtime.js';
import { LLMProvider, LLMProviderError, type Completion } from '../backend/src/llm/provider.js';
import { AppDatabase } from '../backend/src/db/database.js';
import { createAdmin } from '../backend/src/auth/auth.js';
import { HostAgentClient } from '../backend/src/tools/host-client.js';
import { ToolRunner } from '../backend/src/tools/runner.js';
import type { ToolResult } from '../shared/src/types.js';

const result = (tool: ToolResult['tool'], data?: unknown, ok = true): ToolResult => ({ ok, tool, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, ...(data === undefined ? {} : { data }) });
const completion = (message: Completion['message'], toolCalls: Completion['toolCalls'] = []): Completion => ({ content: typeof message.content === 'string' ? message.content : '', model: 'test-model', message, toolCalls });

class ScriptedProvider extends LLMProvider {
  readonly calls: Array<Parameters<LLMProvider['complete']>[0]> = [];
  constructor(private readonly responses: Completion[] | Error[]) { super(); }
  override async complete(...args: Parameters<LLMProvider['complete']>): Promise<Completion> { this.calls.push(args[0]); const next = this.responses.shift(); if (!next) throw new Error('script exhausted'); if (next instanceof Error) throw next; return next; }
}

describe('AgentRuntime', () => {
  let db: AppDatabase | undefined; let file = '';
  afterEach(() => { db?.close(); if (file) { try { unlinkSync(file); } catch { /* best effort */ } } });

  it('executes multiple tool turns and appends tool messages', async () => {
    file = join(tmpdir(), `sentinel-runtime-${randomUUID()}.sqlite`); db = new AppDatabase(file); const user = await createAdmin(db, 'runtime-multi', 'a sufficiently long test password');
    const calls = [{ id: 'call-1', type: 'function' as const, function: { name: 'system_resources', arguments: '{}' } }];
    const provider = new ScriptedProvider([completion({ role: 'assistant', content: null, tool_calls: calls }, calls), completion({ role: 'assistant', content: 'CPU and memory evidence collected.' })]);
    const runner = { run: vi.fn(async (_user: string, _request: string, tool: ToolResult['tool']) => result(tool, { cpuPercent: 12 })) } as unknown as ToolRunner;
    const runtime = new AgentRuntime(db, runner, provider);
    const output = await runtime.run({ userId: user.id, prompt: 'Inspect resources and summarize them.' });
    expect(output.content).toContain('CPU and memory'); expect(runner.run).toHaveBeenCalledTimes(1); expect(provider.calls[1]?.some((message) => message.role === 'tool')).toBe(true);
  });

  it('does not crash on invalid provider output', async () => {
    file = join(tmpdir(), `sentinel-runtime-invalid-${randomUUID()}.sqlite`); db = new AppDatabase(file); const user = await createAdmin(db, 'runtime-invalid', 'a sufficiently long test password');
    const provider = new ScriptedProvider([new LLMProviderError('invalid_json', 'bad response')]); const runner = { run: vi.fn() } as unknown as ToolRunner; const runtime = new AgentRuntime(db, runner, provider);
    await expect(runtime.run({ userId: user.id, prompt: 'Explain the server network.' })).resolves.toMatchObject({ content: 'The AI reasoning provider returned an invalid response. Deterministic server tools remain available. No change was performed.' });
  });

  it('prioritizes Hiddify and never substitutes SITE_DOMAIN', async () => {
    file = join(tmpdir(), `sentinel-runtime-hiddify-${randomUUID()}.sqlite`); db = new AppDatabase(file); const user = await createAdmin(db, 'runtime-hiddify', 'a sufficiently long test password'); process.env.SITE_DOMAIN = 'unrelated.example';
    const provider = new ScriptedProvider([]); const runner = { run: vi.fn(async (_user: string, _request: string, tool: ToolResult['tool']) => tool === 'hiddify_inventory' ? result(tool, { findings: [{ kind: 'nginx_reference', identifier: '/etc/nginx/sites-enabled/hiddify', classification: 'definite', evidence: 'hiddify proxy_pass' }] }) : result(tool)) } as unknown as ToolRunner; const runtime = new AgentRuntime(db, runner, provider);
    const output = await runtime.run({ userId: user.id, prompt: 'Remove Hiddify and clean its Nginx configuration.' });
    expect(output.confirmation?.toolName).toBe('remove_hiddify_artifact'); expect(runner.run).toHaveBeenCalledWith(user.id, expect.any(String), 'hiddify_inventory', {}); expect(provider.calls).toHaveLength(0); expect(output.content).not.toContain('unrelated.example'); delete process.env.SITE_DOMAIN;
  });

  it('asks one concise clarification for ambiguous requests and confirms API restart', async () => {
    expect(classifyIntent('check it')).toBe('ambiguous');
    file = join(tmpdir(), `sentinel-runtime-confirm-${randomUUID()}.sqlite`); db = new AppDatabase(file); const user = await createAdmin(db, 'runtime-confirm', 'a sufficiently long test password'); const provider = new ScriptedProvider([]); const runner = { run: vi.fn() } as unknown as ToolRunner; const runtime = new AgentRuntime(db, runner, provider);
    await expect(runtime.run({ userId: user.id, prompt: 'check it' })).resolves.toMatchObject({ content: 'What should I inspect or change—server health, a website/domain, Hiddify, logs, files, or a service?' });
    const restart = await runtime.run({ userId: user.id, prompt: 'Restart the API.' }); expect(restart.confirmation?.toolName).toBe('restart_service'); expect(runner.run).not.toHaveBeenCalled();
    const realRunner = new ToolRunner(db, new HostAgentClient()); await expect(realRunner.run(user.id, randomUUID(), 'delete_file', { path: '/etc/server-manager/allowlisted/example.conf' })).rejects.toThrow('CONFIRMATION_REQUIRED');
  });
});
