import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['backend', 'host-agent', 'shared', 'frontend', 'scripts']; const files: string[] = [];
function walk(path: string): void { for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(ts|tsx|js|sh)$/.test(entry.name)) files.push(full); } }
roots.forEach(walk);
const findings: string[] = [];
for (const file of files) { const text = readFileSync(file, 'utf8'); if (/shell\s*:\s*true|docker\s+exec|child_process\.exec\s*\(|\beval\s*\(/i.test(text)) findings.push(`${file}: forbidden arbitrary execution pattern`); if (/sk-[a-zA-Z0-9]{20,}/.test(text)) findings.push(`${file}: possible hardcoded API key`); }
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`Security scan passed for ${files.length} source files.`);
