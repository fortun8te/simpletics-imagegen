import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSlot } from '../lib/gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..'); // studio/test -> studio -> NEUEGEN (has logic.js)
const FAKE_TOOL = join(HERE, 'fixtures', 'fake-imagegen.py');

function job(overrides = {}) {
  return { brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p', run: 1, promptText: 'hello', size: '1024x1024', ...overrides };
}

test('generateSlot succeeds against the fake tool', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'success';
  try {
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    assert.equal(res.ok, true);
    assert.ok(res.relPath.includes('run-1'));
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
  }
});

test('generateSlot classifies a dead-credential error as FATAL', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'fail';
  process.env.FAKE_IMAGEGEN_ERROR = 'token refresh failed: HTTP 401';
  try {
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    assert.equal(res.ok, false);
    assert.match(res.error, /^FATAL:/);
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.FAKE_IMAGEGEN_ERROR;
  }
});

test('generateSlot times out a hung subprocess instead of waiting forever', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'hang';
  process.env.CHATGPT_IMAGEGEN_TIMEOUT_MS = '500';
  try {
    const started = Date.now();
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.match(res.error, /^TIMEOUT:/);
    assert.ok(elapsed < 4000, `expected the timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.CHATGPT_IMAGEGEN_TIMEOUT_MS;
  }
});
