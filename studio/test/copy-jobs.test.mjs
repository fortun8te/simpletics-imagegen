// test/copy-jobs.test.mjs — job artifact directories: content-hash ids, collision suffixes,
// atomic writes, debug/ subdir support, traversal rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { openJob } from '../lib/copy-jobs.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'copy-jobs-'));
const root = join(scratch, 'jobs-root');
const imgPath = join(scratch, 'ref.png');
// content doesn't need to be a real PNG — openJob hashes bytes, never decodes
writeFileSync(imgPath, Buffer.from('not-actually-a-png-but-stable-bytes'));
const expectedHash = createHash('sha256').update(readFileSync(imgPath)).digest('hex').slice(0, 12);

test('openJob: id is the 12-hex content hash, dir exists under root', () => {
  const job = openJob(imgPath, { root });
  assert.equal(job.id, expectedHash);
  assert.match(job.id, /^[0-9a-f]{12}$/);
  assert.equal(job.dir, join(root, job.id));
  assert.ok(statSync(job.dir).isDirectory());
  // provenance stamp written on open
  const meta = JSON.parse(readFileSync(join(job.dir, 'job.json'), 'utf8'));
  assert.equal(meta.id, job.id);
  assert.equal(meta.source, imgPath);
});

test('openJob: collision gets a monotonic suffix (fresh dir per call)', () => {
  const j2 = openJob(imgPath, { root });
  const j3 = openJob(imgPath, { root });
  assert.equal(j2.id, `${expectedHash}-2`);
  assert.equal(j3.id, `${expectedHash}-3`);
  assert.notEqual(j2.dir, j3.dir);
  assert.ok(existsSync(j2.dir) && existsSync(j3.dir));
});

test('write/writeJson: atomic writes land, JSON round-trips, paths returned', () => {
  const job = openJob(imgPath, { root });
  const p = job.write('render.txt', 'hello');
  assert.equal(readFileSync(p, 'utf8'), 'hello');
  assert.equal(basename(p), 'render.txt');
  const q = job.writeJson('result.json', { score: 91.7, layers: [1, 2, 3] });
  const back = JSON.parse(readFileSync(q, 'utf8'));
  assert.deepEqual(back, { score: 91.7, layers: [1, 2, 3] });
  // no leftover .tmp files from the atomic swap
  assert.ok(readdirSync(job.dir).every((f) => !f.endsWith('.tmp')));
});

test('write: nested names like debug/overlay.png create the subdir', () => {
  const job = openJob(imgPath, { root });
  const p = job.write('debug/overlay.png', Buffer.from([1, 2, 3]));
  assert.equal(p, join(job.dir, 'debug', 'overlay.png'));
  assert.deepEqual([...readFileSync(p)], [1, 2, 3]);
});

test('write: traversal and absolute names are rejected', () => {
  const job = openJob(imgPath, { root });
  assert.throws(() => job.write('../escape.json', '{}'), /unsafe artifact name/);
  assert.throws(() => job.write('debug/../../escape.json', '{}'), /unsafe artifact name/);
  assert.throws(() => job.write('/tmp/abs.json', '{}'), /unsafe artifact name/);
  assert.throws(() => job.write('', '{}'), /unsafe artifact name/);
});

test('openJob: unreadable source still opens a job (path-hash fallback)', () => {
  const job = openJob(join(scratch, 'does-not-exist.png'), { root });
  assert.match(job.id, /^[0-9a-f]{12}/);
  assert.ok(existsSync(job.dir));
});
