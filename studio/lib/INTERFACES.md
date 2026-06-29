# Studio backend — module interface contract (build to these EXACTLY)

Zero-dep Node ESM (node:* only). Shapes per `../PLAN.md` §2–3 and `../src/types.ts`.
Paths injected by the server: `RENDERS = <HOME>/Downloads/static-factory-b1/renders`,
`REPO = <repo dir>` (the dir containing codexbatch.mjs, logic.js, config.json — i.e. studio/..),
`STATE_DIR = <repo>/studio/.state`. Reuse `logic.js`'s `versionedRelPath` via
`createRequire(import.meta.url)(path.join(REPO,'logic.js'))` for never-overwrite. Sanitize each path
segment with `String(s).replace(/[^a-zA-Z0-9_-]+/g,'-')`.

## lib/gen.mjs  — single-slot codex generation (the proven codexbatch core, factored to one slot)
`export async function generateSlot(job, { renders, repoDir }) -> { ok, relPath?, error? }`
- `job = { brand, batch, ad, variation, prompt, run, promptText, size, ref }`.
- `baseRel = '<brand>/<batch>/ads/<ad>/<variation>/<prompt>/run-<run>.png'` (segments sanitized).
- `finalRel = versionedRelPath(baseRel, rel => existsSync(join(renders, rel)))` — NEVER overwrite.
- `TOOL = process.env.CHATGPT_IMAGEGEN || join(HOME,'Downloads/chatgpt-unlimited/tools/chatgpt-imagegen.py')`.
- spawn `python3 [TOOL, job.promptText, '-o', join(renders, finalRel), '--backend','codex','--size', job.size||'1024x1024', ...(job.ref?['-i',job.ref]:[])]`
  with env `{ ...process.env, CHATGPT_IMAGEGEN_EFFORT:'low', CHATGPT_IMAGEGEN_VERBOSITY:'low', SSL_CERT_FILE: process.env.SSL_CERT_FILE||'/etc/ssl/cert.pem', REQUESTS_CA_BUNDLE: process.env.SSL_CERT_FILE||'/etc/ssl/cert.pem' }`.
- Capture stdout+stderr. close: `code===0 && existsSync(out)` → `{ok:true, relPath:finalRel}`; else `error` = last ~4 lines.
- If `error` matches `/HTTP 429|usage limit|too many requests|rate.?limit|quota|exceeded/i`, PREFIX it with `'RATE_LIMIT: '` so the worker cools down.
- READ `../../codexbatch.mjs` (its `generate()` + CA_BUNDLE + isTubeShot) — copy that proven logic.

## lib/jobstore.mjs  — queue + history + archive, persisted
`export function createJobStore({ stateDir }) -> store`
- Persist jobs → `stateDir/jobs.json` (keep last 500), archive set → `stateDir/archive.json`. Load on create; save atomically after each mutation (mkdir -p stateDir). Job shape per PLAN §2; `id = '<ad>_<variation>_<prompt>_r<run>_<n++>'`.
- Methods: `enqueue(spec)→job` (spec `{brand,batch,ad,variation,prompt,run,variants,promptText,size,ref}`, status 'queued', enqueuedAt) · `nextQueued()→job|null` (oldest queued; atomically set status 'running'+startedAt) · `complete(id,{relPath})` · `fail(id,error)` (attempts++) · `requeue(id)` (→'queued') · `cancel({jobId?,all?})` (queued/running→'canceled') · `get(id)` · `list()` (recent) · `forBatch(brand,batch)→job[]` · `counts()→{running,queued,done,failed}` · `isArchived(relPath)→bool` · `setArchived(relPath,bool)` · `archivedCount(brand,batch)→int` · `on('change',cb)`/`off('change',cb)` (emit 'change' after EVERY mutation — drives SSE).

## lib/state.mjs  — build the /api/state response
`export function buildState({ brand, batch, config, store, renders, codex }) -> BatchState`
- Walk config → the batch's ads → variations → prompts (id/label/title/type from config).
- Per prompt: scan `renders/<brand>/<batch>/ads/<ad>/<var>/<prompt>/run-*.png` → done slots: parse run + version (`run-2-v3.png`→run2,v3; bare→v1), group by run, keep newest version per run; `relPath`, `thumbUrl='/img?path='+encodeURIComponent(relPath)`, status 'done' (or 'archived' if `store.isArchived(relPath)`).
- Merge `store.forBatch(brand,batch)`: queued→slot{status:'queued',job} · running→{status:'generating',job} · failed→{status:'failed',job} (keyed by run; don't duplicate a run that already has a done file unless it's a newer in-flight run).
- Prompt with no done files + no jobs → one slot `{run:1,status:'empty'}`.
- `codex` and `queue:store.counts()` and `archivedCount` filled (server passes `codex`).

## lib/worker.mjs  — the generation engine (backend-owned; replaces terminal runs)
`export function createWorker({ store, renders, repoDir, concurrency=3, cooldownMin=30, onChange }) -> { start, stop, status, busy }`
- Tick on: enqueue (store 'change'), each job finish, and a 1s safety interval. While `running < concurrency` and `store.nextQueued()` yields a job: `import('./gen.mjs').generateSlot(job,{renders,repoDir})`.
- ok → `store.complete(id,{relPath})`. Error starting `RATE_LIMIT:` → `store.requeue(id)` + PAUSE worker `cooldownMin` min (setTimeout) then resume. Other error → attempts<3 `store.requeue(id)` else `store.fail(id,error)`. Call `onChange()` after each transition.
- `status()→{running,paused,resumeAt}` · `busy()→running>0||paused`.

## studio-server.mjs  — http + SSE + static + wiring
- Wire `createJobStore`, `createWorker({onChange:broadcast})`, `buildState`. `worker.start()`.
- Routes per PLAN §3. `/api/generate`: read config; for each targeted slot, `run = (#done renders for that prompt) + (#queued/running jobs for it) + 1`; resolve `promptText` (config variation.prompts[].prompt — use prompt id), `size` (batch.aspect), `ref` (if the prompt is a tube shot, the assets/nanox.png path); enqueue `variants` jobs per slot. `/api/regenerate`: relPath→coords→enqueue 1 at next run. `/api/cancel`, `/api/archive`, `/api/state` (buildState + codex={alive:worker.busy()||pgrep, progress: bridge /status codexProgress}), `/api/health`, `/img?path=` (serve full PNG, path-traversal-guarded; `?w` accepted but may be ignored — serve full for v1), `/events` (SSE: Set of res; broadcast `state`+`queue` on store/worker change; `hello` on connect; `:heartbeat` comment every 20s).
- Static: serve `studio/dist` (SPA fallback to index.html) for non-API GETs. Listen :8788, log startup.

DECISION: thumbnails — `/img` serves the full PNG for v1 (browser scales in fixed-aspect boxes). `thumbUrl` = the full `/img` URL. (sharp-based real thumbs are a later optimization.)
