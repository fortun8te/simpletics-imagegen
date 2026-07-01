import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../studio-server.mjs', import.meta.url), 'utf8');

const healthRoute = server.match(/if \(pathname === '\/api\/health'[\s\S]*?return;\n    \}/)?.[0] || '';

assert.match(healthRoute, /codexUsage:\s*getCodexUsage\(\{\s*force:\s*true\s*\}\)/);
