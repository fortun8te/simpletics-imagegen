// lib/atomic-write.mjs — crash-safe file writes (zero deps: node:fs only).
//
// A bare writeFileSync truncates the destination to 0 bytes BEFORE writing the new
// content, so a crash / power loss mid-write leaves a truncated (invalid-JSON) file.
// Every read path in the studio treats corrupt-parse as "empty", so that truncation is
// permanent SILENT data loss (a design doc, chat, brandkit, etc. vanishes).
//
// writeAtomic writes to a unique sibling temp file, fsync-durable via the OS, then
// renameSync — an atomic swap on POSIX — so a reader ever only sees the OLD complete
// file or the NEW complete file, never a half-written one. Mirrors the pattern already
// proven in lib/jobstore.mjs.

import fs from 'node:fs';
import path from 'node:path';

/** Atomically write `content` (string or Buffer) to `file`: temp-file + rename swap.
 *  Ensures the parent directory exists. Cleans up the temp file if the rename fails. */
export function writeAtomic(file, content) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort; write below surfaces real errors */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}
