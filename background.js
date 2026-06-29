// ImageGen background worker: controlled parallel generation across a small pool of ChatGPT tabs.
importScripts('logic.js');

const BRIDGE = 'http://localhost:8787';
// Controlled parallelism: default lanes, never more than the hard cap. Tab spawning is
// strictly bounded by this so we never flood the user's window with tabs.
// Capped at 2: never more than 2 background ChatGPT tabs / 2 concurrent chats at once.
// 2 lanes finishes cleanly and trips the image rate limit far less than flooding more chats.
const MAX_PARALLEL = 2;
const HARD_CAP = 2;
// Stagger the start of each parallel job to avoid tripping ChatGPT rate limits.
const STAGGER_MS = 1500;

let running = false;
let stopFlag = false;
let bridgeBusy = false;

// ---------------------------------------------------------------------------
// AUTO-RESUME AFTER IMAGE CAP
//
// When ChatGPT trips its image rate-limit / cap, generation must stop (each
// fresh job would just fail the same way). Instead of leaving the batch dead
// until the user notices, we schedule an automatic resume after the cap window
// (~4h30m). The schedule survives BOTH service-worker eviction AND a full
// computer restart: the wake is a chrome.alarms alarm (persists across restart)
// AND the target time is mirrored to chrome.storage.local so onStartup can
// re-arm (belt-and-suspenders) or fire immediately if the time already passed.
// A manual Continue cancels the pending auto-resume and resumes now.
// ---------------------------------------------------------------------------
const AUTO_RESUME_MS = 4.5 * 60 * 60 * 1000; // 4h30m: ChatGPT image-cap reset window
// Number of bridge lanes currently in flight (kept <= concurrency()).
let bridgeInFlight = 0;
// Tab ids of every pool tab currently in use (foreground queue or bridge). Stop aborts ALL of
// them, so a parallel lane in another window is never missed.
const activePoolTabs = new Set();
// Tab ids of background chatgpt.com tabs THIS extension opened for work. We reuse these across
// sweeps and NEVER hijack the user's own foreground ChatGPT tab. Persisted only in memory; a
// dead/closed tab is pruned on next use.
const ownedTabs = new Set();
// Id of the DEDICATED background window THIS extension hosts its worker tabs in. Hidden tabs
// inside the user's focused window get throttled/frozen by Chrome and clutter the user's window;
// a separate non-minimized window keeps the worker tabs less throttled and out of the way. null
// until created. If the user closes it, chrome.windows.get throws and we recreate on next use.
let ownedWindowId = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

// Foreground pause: the panel can pause/continue a panel run without losing its tabs. The worker
// loop waits between jobs while paused (the in-flight job always finishes). Bridge runs use the
// bridge's own pause/resume; the panel toggles both so one Continue button covers either path.
let pauseFlag = false;

// ---- Live per-tab status (emit-only; never blocks a lane) -------------------------------------
// Keyed by tab id so the panel shows one row per ChatGPT tab: what it is doing now, image i of N,
// elapsed. State lives in chrome.storage.session (survives SW eviction / panel reopen) and is
// pushed live to the panel as { type:'lane-status', record }. Hi-freq updates are coalesced.
const _laneMem = {};
const _laneFlush = {};
const _laneClear = {};
const LANE_TERMINAL = new Set(['done', 'error', 'refusal', 'rate-limited', 'aborted']);
function laneStatus(tabId, patch) {
  if (tabId == null || !patch) return;
  const id = String(tabId);
  const prev = _laneMem[id] || {};
  const now = Date.now();
  const startedAt = (patch.jobId && patch.jobId !== prev.jobId) ? now : (prev.startedAt || now);
  const rec = { ...prev, ...patch, tabId: id, laneId: id, startedAt, updatedAt: now };
  _laneMem[id] = rec;
  const commit = () => { try { chrome.storage.session.set({ laneStatus: _laneMem }); } catch {} send({ type: 'lane-status', record: rec }); };
  if (LANE_TERMINAL.has(rec.state)) {
    if (_laneFlush[id]) { clearTimeout(_laneFlush[id]); delete _laneFlush[id]; }
    commit();
    clearTimeout(_laneClear[id]);
    _laneClear[id] = setTimeout(() => {
      delete _laneMem[id];
      try { chrome.storage.session.set({ laneStatus: _laneMem }); } catch {}
      send({ type: 'lane-status', record: { laneId: id, tabId: id, _cleared: true } });
    }, 7000);
    return;
  }
  if (_laneFlush[id]) return; // a flush is already pending; coalesce
  _laneFlush[id] = setTimeout(() => { delete _laneFlush[id]; commit(); }, 250);
}
function laneRec(state, job, extra) {
  const v = job ? ImageGenLogic.normalizeRunCount(job.variants, 1) : 1;
  return { state, jobId: job && (job.id || job.name), adId: job && (job.adId || job.id || job.name), name: job && job.name, imageTotal: v, ...(extra || {}) };
}
function laneErrState(err) {
  const e = String(err || '');
  if (/refus/i.test(e)) return 'refusal';
  if (/image limit|too many requests|rate limit|quota/i.test(e)) return 'rate-limited';
  return 'error';
}
try { chrome.storage.session.set({ laneStatus: {} }); } catch {}

// Persist a generated preview INDEPENDENTLY of whether the side panel is open, keyed by its stable
// relative path ('preview:<brand>/<batch>/ads/<ad>/<var>/<prompt>/run-N.png'). The panel only gets
// live progress messages WHILE it is open, so during a long auto-resumed run (panel closed for
// hours) those previews were never cached and vanished on reload/restart. Writing them here, one
// tiny independent entry per image (no giant blob, no race), means every generated image survives
// the panel being closed, an extension reload, and a computer restart. unlimitedStorage covers it.
// The panel merges these on load. Never deletes anything.
function persistPreview(relPath, dataUrl) {
  if (!relPath || !dataUrl) return;
  try { chrome.storage.local.set({ ['preview:' + relPath]: dataUrl }); } catch {}
}

// ---------------------------------------------------------------------------
// CODEX RESULT INGEST (full sync)
//
// The codex batch driver renders images on a SEPARATE ChatGPT quota and relays
// each finished image to the local bridge at /codex-results. Those images never
// pass through this worker's generate path, so without ingest they would never
// appear in the panel. We pull them every poll and feed them through the EXACT
// SAME channels web images use:
//   1. persistPreview(relPath, dataUrl) -> the preview survives reload/restart
//      like every web image (one tiny independent chrome.storage.local entry).
//   2. A { type:'bridge', status:'done', ... } message whose variantIndex is
//      (run - 1), so the panel's handleProgress drops the dataURL into the
//      correct run slot/tile. The latest version arrives last and wins.
// Best-effort and non-fatal: every step is wrapped, a parse miss is skipped, and
// a missing bridge / bad response simply returns. Never blocks a sweep, never
// throws. parseRelPath lives in logic.js (imported via importScripts).
async function ingestCodexResults() {
  let payload;
  try {
    payload = await (await fetch(`${BRIDGE}/codex-results`)).json();
  } catch { return; } // bridge unreachable or bad JSON: nothing to ingest this tick
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  for (const result of results) {
    try {
      if (!result || !result.relPath || !result.dataUrl) continue;
      // 1. Persist exactly like a web image so it survives reload/restart.
      persistPreview(result.relPath, result.dataUrl);
      // 2. Parse the stable path into its run slot coordinates. A null parse (unexpected
      //    path shape) is skipped rather than fed into the panel with a bad index.
      const parsed = ImageGenLogic.parseRelPath(result.relPath);
      if (!parsed) continue;
      send({
        type: 'bridge',
        status: 'done',
        variantIndex: (parsed.run - 1),
        path: result.relPath,
        thumb: result.dataUrl,
        job: {
          name: result.name,
          adId: parsed.ad,
          variationId: parsed.variation,
          promptId: parsed.prompt,
          kind: 'final',
          variants: parsed.run,
          variantPaths: [],
        },
      });
    } catch { /* one bad result never blocks the rest */ }
  }
}

function concurrency() {
  return Math.max(1, Math.min(MAX_PARALLEL, HARD_CAP));
}

// ---------------------------------------------------------------------------
// SW LIFECYCLE KEEPALIVE
//
// MV3 evicts the service worker after ~30s idle. A single generation `await`
// runs ~2min, far longer than that lifetime, so without intervention the SW
// dies mid-await: the job sits "running" on the bridge forever, polling stops,
// and the batch silently stalls. setInterval does not survive eviction and the
// chrome.alarms floor is ~30s (one missed wake = a dead lane).
//
// Robust fix, two layers:
//   1. A self-connected runtime port that we re-ping every KEEPALIVE_MS (< the
//      30s idle window). An active port + recurring message traffic keeps the
//      SW classified as "in use", so it is not evicted while real work is in
//      flight. We only run this while busy (queue OR bridge sweep) so an idle
//      extension still suspends normally.
//   2. A short-period watchdog alarm that, on every wake, RE-DRIVES the bridge
//      (pollBridge). If the SW ever was evicted despite (1), the next alarm
//      wake reconnects the keepalive and re-pulls work, so the batch resumes
//      itself with no user babysitting. The watchdog also reconnects cleanly
//      after a reload because onStartup/onInstalled re-arm the alarm.
// ---------------------------------------------------------------------------
const KEEPALIVE_MS = 20000; // < the ~30s MV3 idle eviction window
let keepAlivePort = null;
let keepAliveTimer = null;

// ---------------------------------------------------------------------------
// WORKER-TAB FREEZE FIGHT (heartbeat)
//
// macOS Chrome FREEZES tabs whose window is fully occluded or minimized. The SW
// itself stays alive (keepalive port), but the worker chatgpt.com tabs can stall
// mid-generation. A small corner window helps, yet a fully covered window still
// freezes. So while work is active we ALSO inject cheap renderer activity into
// each active worker tab on a timer. The injection runs from the unthrottled SW,
// which helps reset the tab inactivity timer even when the tab is hidden.
// ---------------------------------------------------------------------------
const HEARTBEAT_MS = 22000; // ~every 22s while work is active
let heartbeatTimer = null;

// Injected INTO the worker tab. Pokes the renderer to fight the freeze/inactivity
// timer: touches timing and focus state, dispatches synthetic input and a
// visibility event, nudges scroll by 0px, and re-triggers the content script's
// audio keepalive if it exposed one. All best-effort, never throws.
function keepTabAwake() {
  try {
    void performance.now();
    void document.hasFocus();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
    window.scrollBy(0, 0);
    if (typeof window.__imageGenKeepAwake === 'function') window.__imageGenKeepAwake();
  } catch (e) { /* tab not ready or restricted: ignore */ }
}

// One heartbeat tick: inject keepTabAwake into every active worker tab. Each
// executeScript is wrapped so a missing or closed tab never throws. Gated on
// workActive() so we never keep the SW alive just for the heartbeat.
function heartbeatTick() {
  if (!workActive()) { stopHeartbeat(); return; }
  for (const tabId of [...activePoolTabs]) {
    try {
      chrome.scripting.executeScript({ target: { tabId }, func: keepTabAwake }).catch(() => {});
    } catch { /* tab gone or not injectable: skip */ }
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTick();
  heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
// True while a foreground queue OR a bridge sweep is active. Drives keepalive.
function workActive() { return running || bridgeBusy; }

// ---------------------------------------------------------------------------
// OWNED-TAB IDLE CLEANUP
//
// We do not want to litter the user's window with leftover chatgpt.com tabs.
// After work stops and the bridge queue is empty, close the background tabs
// THIS extension opened (only ones in ownedTabs, never a user tab). An idle
// delay lets a quick follow-up job reuse a warm tab instead of churning.
// Policy chosen: keep at most ONE warm owned tab, close the rest after the idle
// window. The check is driven by the existing low-frequency alarm, so we never
// keep the SW alive just to run cleanup.
// ---------------------------------------------------------------------------
const OWNED_IDLE_MS = 120000; // ~2 min idle before we reclaim owned tabs
// Timestamp of the last moment work was active. Updated whenever workActive()
// is observed true (alarm tick) so the idle window is measured from real idle.
let lastWorkAt = Date.now();

// Close idle owned tabs when no queue is running and the bridge has 0 pending
// and 0 running. Keeps one warm owned tab to absorb a quick follow-up job. Only
// ever removes ids in ownedTabs; non-owned tabs are never touched. Prunes ids
// whose tab no longer exists. Best-effort: every remove is wrapped in try/catch.
async function cleanupOwnedTabs() {
  if (workActive()) { lastWorkAt = Date.now(); return; }
  if (!ownedTabs.size) return;
  // Respect the idle delay so a fast follow-up job reuses the warm tab.
  if (Date.now() - lastWorkAt < OWNED_IDLE_MS) return;
  // Confirm the bridge is truly idle (0 pending, 0 running) before reclaiming.
  try {
    const s = await (await fetch(`${BRIDGE}/status`)).json();
    if ((s.pending || 0) > 0 || (s.running || 0) > 0) { lastWorkAt = Date.now(); return; }
  } catch { return; } // bridge unreachable: leave tabs alone, try again next tick
  // Work may have started while we awaited /status; bail if so.
  if (workActive()) { lastWorkAt = Date.now(); return; }
  // Prune dead ids and collect the live owned tabs.
  const live = [];
  for (const id of [...ownedTabs]) {
    try { await chrome.tabs.get(id); live.push(id); }
    catch { ownedTabs.delete(id); }
  }
  // Fully idle: close the ENTIRE dedicated worker window in one shot so we leave nothing warm
  // behind. A fresh window spins up fast on the next job, and a separate window costs nothing while
  // idle. We only ever close OUR OWN worker window, never a user window. If the worker window is
  // gone (user closed it) or empty / only owned tabs remain, removing it reclaims everything.
  if (ownedWindowId != null) {
    try {
      const win = await chrome.windows.get(ownedWindowId, { populate: true });
      const tabs = win.tabs || [];
      const onlyOwned = tabs.every((t) => ownedTabs.has(t.id));
      if (!tabs.length || onlyOwned) {
        try { await chrome.windows.remove(ownedWindowId); } catch {}
        for (const id of live) ownedTabs.delete(id);
        ownedWindowId = null;
        return;
      }
    } catch { ownedWindowId = null; } // worker window already gone: forget it
  }
  // Worker window still holds a user tab (unexpected) or no worker window: just close owned tabs.
  for (const id of live) {
    try { await chrome.tabs.remove(id); } catch {}
    ownedTabs.delete(id);
  }
}

function connectKeepAlivePort() {
  try {
    // A port the SW opens to ITSELF. The onConnect handler below accepts it;
    // an open port with periodic messages resets the idle-eviction timer.
    keepAlivePort = chrome.runtime.connect({ name: 'imagegen-keepalive' });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
      // If work is still in flight, immediately re-establish so we never leave
      // a generation await unprotected.
      if (workActive()) connectKeepAlivePort();
    });
  } catch { keepAlivePort = null; }
}

function pingKeepAlive() {
  if (!workActive()) { stopKeepAlive(); return; }
  if (!keepAlivePort) connectKeepAlivePort();
  try { keepAlivePort && keepAlivePort.postMessage({ t: Date.now() }); } catch { keepAlivePort = null; }
  // Touch a cheap async API too: an in-flight extension API call is another
  // signal that keeps the worker alive across the interval.
  try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch {}
}

// Begin holding the SW alive. Idempotent: safe to call at the start of every
// queue run and every bridge sweep.
function startKeepAlive() {
  // Mark work as active NOW so the owned-tab idle window starts only after this
  // run ends, even if no alarm ticks in between.
  lastWorkAt = Date.now();
  if (keepAliveTimer) return;
  connectKeepAlivePort();
  pingKeepAlive();
  keepAliveTimer = setInterval(pingKeepAlive, KEEPALIVE_MS);
  // Also start the worker-tab freeze fight for the duration of this work.
  startHeartbeat();
}

// Release the SW so an idle extension suspends normally. Only stops once NO
// work is active.
function stopKeepAlive() {
  if (workActive()) return;
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  stopHeartbeat();
  try { keepAlivePort && keepAlivePort.disconnect(); } catch {}
  keepAlivePort = null;
}

// Accept the SW's own keepalive port (and ignore any other connectors). Holding
// a reference keeps the port open across the worker's event loop turns.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'imagegen-keepalive') return;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);
});

async function openPanel(windowId, tabId) {
  if (tabId !== undefined) await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
  await chrome.sidePanel.open({ windowId });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.action.onClicked.addListener((tab) => openPanel(tab.windowId, tab.id).catch(() => {}));

async function reinjectContentScript() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'] });
    for (const tab of tabs) chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['logic.js', 'content.js'] }).catch(() => {});
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  reinjectContentScript();
});
chrome.runtime.onStartup.addListener(reinjectContentScript);
reinjectContentScript();

// Abort EVERY ChatGPT tab that could be running a lane: the tracked pool tabs (across any window)
// plus every chatgpt.com tab we can find. Idempotent and best-effort; a missing tab is ignored.
async function abortAllTabs() {
  const ids = new Set(activePoolTabs);
  try {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'] });
    for (const tab of tabs) ids.add(tab.id);
  } catch {}
  for (const id of ids) {
    try { chrome.tabs.sendMessage(id, { type: 'abort' }, () => void chrome.runtime.lastError); } catch {}
  }
}

async function chatgptTab() {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'] });
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

// Find existing chatgpt.com tabs in the user's current window. We never touch non-chatgpt tabs.
async function chatgptTabsInWindow() {
  let windowId;
  try { windowId = (await chrome.windows.getLastFocused()).id; } catch { windowId = undefined; }
  let tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'], windowId });
  // Fall back to any window if the focused window has none (e.g. side panel focus quirks).
  if (!tabs.length) tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'] });
  // Active tab first so single-tab behaviour matches today exactly.
  return tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
}

// Ensure content.js is injected and the tab has pinged ready. Returns true on success.
async function ensureTabReady(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['logic.js', 'content.js'] }); } catch {}
  const ready = await waitForContent(tabId, false);
  return ready.ok;
}

// Return a usable id for the dedicated background worker window, creating it if needed. Reuse the
// existing one if it is still open (chrome.windows.get succeeds); if the user closed it, get throws
// and we create a fresh one. focused:false means it NEVER steals the user's focus; state:'normal'
// (not minimized) keeps its tabs less throttled than hidden tabs in the user's window. The window's
// initial chatgpt.com tab is registered in ownedTabs so it joins the reusable pool. Returns the
// window id, or null if a window could not be created at all (caller falls back).
async function ensureWorkerWindow() {
  if (ownedWindowId != null) {
    try { await chrome.windows.get(ownedWindowId); return ownedWindowId; }
    catch { ownedWindowId = null; } // user closed it: drop the stale id and recreate below
  }
  try {
    // Corner-positioned worker window. macOS Chrome FREEZES tabs whose window is fully
    // occluded or minimized, stalling a long generation. A window pinned to the top-left
    // corner usually peeks out from behind the user's window, and a partially visible window is
    // NOT occluded, so its tabs stay unfrozen. focused:false so it never steals the user's focus.
    // Sized wide enough (>=1024) that ChatGPT renders its full DESKTOP layout: at narrow widths
    // ChatGPT collapses the composer/attach controls and the content script misfires (half-typed
    // prompts, the reference echoed back instead of a render).
    const win = await chrome.windows.create({
      url: 'https://chatgpt.com/', focused: false, type: 'normal',
      width: 1100, height: 900, top: 24, left: 24,
    });
    ownedWindowId = win.id;
    // Register the window's initial tab so it is reused as a worker tab, not left idle.
    const initial = win.tabs && win.tabs[0];
    if (initial && initial.id != null) ownedTabs.add(initial.id);
    return ownedWindowId;
  } catch { ownedWindowId = null; return null; }
}

// Build a controlled pool of up to `size` ready chatgpt.com tabs that the extension OWNS.
// Agentic-control rule: never hijack the user's own foreground ChatGPT tab. We reuse our own
// previously-opened background tabs first, then open new background tabs only as needed, never
// beyond the pool size (capped by HARD_CAP). Each entry tracks which project is already prepared
// on that tab to skip redundant setup. Only if we cannot open ANY background tab do we fall back
// to reusing an existing tab so generation still works rather than failing outright.
async function buildTabPool(size) {
  const limit = Math.max(1, Math.min(size, HARD_CAP));
  const pool = [];

  // OWNED-TAB MODE (default, per DESIGN.md): NEVER hijack the user's foreground ChatGPT tab. Reuse
  // our own previously-opened background tabs first, then open new background tabs in the dedicated
  // corner worker window (non-minimized, never focused, so macOS Chrome does not freeze them).
  for (const id of [...ownedTabs]) {
    if (pool.length >= limit) break;
    try { await chrome.tabs.get(id); } catch { ownedTabs.delete(id); continue; }
    if (await ensureTabReady(id)) pool.push({ id, preparedProject: null, owned: true });
    else ownedTabs.delete(id);
  }
  const workerWindowId = await ensureWorkerWindow();
  while (workerWindowId != null && pool.length < limit) {
    let created;
    try { created = await chrome.tabs.create({ windowId: workerWindowId, url: 'https://chatgpt.com/', active: false }); }
    catch (error) { break; }
    ownedTabs.add(created.id);
    try { await waitForTabRoute(created.id, 'https://chatgpt.com/'); } catch {}
    if (await ensureTabReady(created.id)) pool.push({ id: created.id, preparedProject: null, owned: true });
    else break;
  }

  // LAST-RESORT fallback only if we could not open ANY background tab (Chrome refused): reuse an
  // existing chatgpt.com tab so a job still runs rather than failing outright.
  if (!pool.length) {
    for (const tab of await chatgptTabsInWindow()) {
      if (pool.length >= limit) break;
      if (await ensureTabReady(tab.id)) pool.push({ id: tab.id, preparedProject: null, owned: false });
    }
  }

  // Track these tabs so a stop can abort every lane immediately, even across windows.
  for (const entry of pool) activePoolTabs.add(entry.id);
  return pool;
}

// Serialize project prep per project name so two parallel lanes never race to CREATE the same
// project (which would spawn duplicates). Lanes chain off the same promise: the first lane runs
// prepareProject (creates the project); later lanes wait, then reuse the cached URL and just open
// it on their own tab WITHOUT creating again.
const projectPrepChains = new Map();
function withProjectLock(project, task) {
  const prev = projectPrepChains.get(project) || Promise.resolve();
  // Swallow the prior result/error so one lane's failure does not reject the next lane's turn.
  const run = prev.catch(() => {}).then(task);
  // Keep the chain pointed at this run; clean the map entry once it is the tail.
  projectPrepChains.set(project, run);
  run.catch(() => {}).finally(() => { if (projectPrepChains.get(project) === run) projectPrepChains.delete(project); });
  return run;
}

// Shared, MODULE-LEVEL cache of projects this extension has already created/located in this
// session, keyed by the exact project name -> its /g/ URL. This is the single source of truth that
// guarantees a batch creates its project AT MOST ONCE: every lane (and every later run/bridge
// sweep) checks here BEFORE creating, so 48 jobs across 5 tabs converge on one project instead of
// each tab spawning its own. It outlives the per-run `projectUrls` object so a panel run and a
// follow-up bridge run for the same name still reuse the one project.
const createdProjects = new Map();

// Canonical project name: collapse runs of whitespace to a single space and trim. The panel and
// runbatch build names with DOUBLE spaces ("Brand Batch  v1  stamp"), but ChatGPT stores/renders
// the name with collapsed whitespace, so the un-normalized name would never match what we read
// back (projectNameMatches is an exact ===). Normalizing once, at the source in this worker, keeps
// the create, the find, the shared-cache key, and the in-page move all agreeing on ONE name.
function canonicalProjectName(name) {
  return name == null ? name : String(name).replace(/\s+/g, ' ').trim();
}
// Return the job with its project name canonicalized so every downstream step uses one name.
function withCanonicalProject(job) {
  if (!job || !job.project) return job;
  const project = canonicalProjectName(job.project);
  return project === job.project ? job : { ...job, project };
}

// Open an already-known project URL on this tab and mark the tab prepared, NO create. Used when the
// project was created/found by an earlier lane so duplicate lanes never re-run the create flow.
async function openKnownProject(entry, project, url, projectUrls) {
  const inProject = await openRoute(entry.id, url);
  if (inProject.ok) {
    entry.preparedProject = project;
    projectUrls[project] = url;
    send({ type: 'project', project, status: 'ready' });
    return { ok: true, projectUrl: url };
  }
  // Could not open the cached URL on this tab; fall through to a real prep so the lane still runs.
  return null;
}

// Prepare a project on a pool tab, skipping the work if it is already prepared there OR already
// created/located anywhere in this session. Returns { ok, projectUrl }.
//
// Duplicate-proofing is layered:
//   1. per-tab cache (entry.preparedProject): this tab is already sitting in the project.
//   2. shared cache check BEFORE the lock: a sibling lane already has the URL -> just open it.
//   3. shared cache RE-check INSIDE the lock (double-checked locking): the lock holder may have
//      finished creating while we waited our turn, so re-check before doing any create.
//   4. only the very first lane that finds the cache empty inside the lock runs prepareProject,
//      then publishes the URL to the shared cache for everyone else.
async function ensureProjectOnTab(entry, project, projectUrls) {
  if (!project) return { ok: true };
  if (entry.preparedProject === project) {
    return { ok: true, projectUrl: projectUrls[project] || createdProjects.get(project) };
  }
  // 2. Fast path: the project already exists in this session. Just open it on this tab.
  const known = createdProjects.get(project);
  if (known) {
    const opened = await openKnownProject(entry, project, known, projectUrls);
    if (opened) return opened;
  }
  // 3 + 4. Serialize the create so exactly one lane ever creates this project.
  return withProjectLock(project, async () => {
    // Re-check inside the lock: a lane ahead of us may have just created it.
    const cached = createdProjects.get(project);
    if (cached) {
      const opened = await openKnownProject(entry, project, cached, projectUrls);
      if (opened) return opened;
    }
    const prepared = await prepareProject({ id: entry.id }, project);
    if (prepared.ok) {
      entry.preparedProject = project;
      if (prepared.projectUrl) {
        projectUrls[project] = prepared.projectUrl;
        // Publish to the shared cache so every other lane/sweep reuses this exact project.
        createdProjects.set(project, prepared.projectUrl);
      }
    }
    return prepared;
  });
}

function ask(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'no response from ChatGPT tab' });
    });
  });
}

async function askUntilReply(tabId, message, attempts = 20) {
  let last = { ok: false, error: 'ChatGPT did not reply' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await ask(tabId, message);
    if (last.ok) return last;
    if (!ImageGenLogic.isTransientPortError(last.error)) return last;
    await wait(350);
  }
  return last;
}

// Dispatch a generate (or other heavy) message with resilience to transient "receiving end does not
// exist" failures: the content script can be torn down by a ChatGPT SPA route swap or an SW respawn
// right as we send. On such a transient port error, re-ensure the content script is injected/ready
// and retry. A refusal, rate limit, or any non-port error returns immediately (never retried here).
async function askGenerate(tabId, message, attempts = 6) {
  let last = { ok: false, error: 'ChatGPT did not reply' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await ask(tabId, message);
    if (last.ok || !ImageGenLogic.isTransientPortError(last.error)) return last;
    await ensureTabReady(tabId);
    await wait(400);
  }
  return last;
}

async function waitForContent(tabId, requireComposer = true, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await askUntilReply(tabId, { type: 'ping' }, 1);
    if (response.ok && (!requireComposer || response.loggedIn)) return response;
    await wait(500);
  }
  return { ok: false, error: 'ChatGPT did not become ready' };
}

async function waitForTabRoute(tabId, route) {
  const target = new URL(route);
  const current = await chrome.tabs.get(tabId);
  if (ImageGenLogic.sameRoute(current.url, route) && current.status === 'complete') return current;
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (value, error) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(value);
    };
    const listener = (updatedId, changeInfo, updatedTab) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete' || !ImageGenLogic.sameRoute(updatedTab.url, route)) return;
      finish(updatedTab);
    };
    const timeout = setTimeout(() => finish(null, new Error(`ChatGPT did not finish opening ${target.pathname}`)), 30000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(async (latest) => {
      if (ImageGenLogic.sameRoute(latest.url, route) && latest.status === 'complete') return finish(latest);
      if (!ImageGenLogic.sameRoute(latest.url, route)) await chrome.tabs.update(tabId, { url: route });
    }).catch((error) => finish(null, error));
  });
}

async function openRoute(tabId, route, requireComposer = true) {
  await waitForTabRoute(tabId, route);
  return waitForContent(tabId, requireComposer);
}

async function prepareProject(tab, project) {
  if (!project) return { ok: true };
  send({ type: 'project', project, status: 'opening' });
  const ready = await openRoute(tab.id, 'https://chatgpt.com/projects', false);
  if (!ready.ok) return ready;
  send({ type: 'project', project, status: 'checking' });
  const projectResult = await askUntilReply(tab.id, { type: 'ensureProject', project });
  if (!projectResult.ok) return projectResult;
  send({ type: 'project', project, status: projectResult.created ? 'created' : 'ready' });
  // Leave the tab on the project's new-chat composer so chats are created INSIDE the project
  // (no slow move-after). Fall back to home only if we could not get the project URL.
  if (projectResult.projectUrl) {
    const inProject = await openRoute(tab.id, projectResult.projectUrl);
    if (inProject.ok) { send({ type: 'project', project, status: 'ready' }); return { ok: true, projectUrl: projectResult.projectUrl }; }
  }
  const home = await openRoute(tab.id, 'https://chatgpt.com/');
  if (home.ok) send({ type: 'project', project, status: 'ready' });
  return { ...home, projectUrl: projectResult.projectUrl };
}

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    // overwrite (not uniquify): we always want the EXACT intended path on disk. A re-run of the
    // same job rewrites its own deliverable instead of spilling "name (1).png". Chrome may still
    // uniquify on a true filesystem conflict it cannot overwrite, but that is the last resort,
    // not our default, so two distinct variant paths never silently merge into one name.
    chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

function fallbackPath(job, folder) {
  const base = folder ? `${folder.replace(/\/$/, '')}/` : '';
  return `${base}${job.name}.png`;
}

// Append "-N" before the extension so an index-derived path never collides with another.
function suffixPath(base, index) {
  return base.replace(/(\.[a-z0-9]+)?$/i, `-${index + 1}$1`);
}

// Per-variant download path. Prefer the UI-supplied variantPaths[i]; otherwise fall back to the
// job's relativePath/name path with an index suffix so variants never overwrite each other.
// We also harden against two variants resolving to the SAME path: if the path we computed for
// index i is identical to the path of any earlier variant, we suffix it with the index so
// variant 0 and variant i can never write to (and overwrite) the same file.
function variantPath(job, folder, index) {
  const base = job.relativePath || fallbackPath(job, folder);
  const explicit = job.variantPaths && job.variantPaths[index];
  let path = explicit ? explicit : (index === 0 ? base : suffixPath(base, index));
  if (index > 0) {
    // Collision guard: compare against every earlier variant's resolved path. If this path is
    // not strictly distinct, force an index suffix so it cannot overwrite an earlier write.
    for (let prior = 0; prior < index; prior++) {
      const priorExplicit = job.variantPaths && job.variantPaths[prior];
      const priorPath = priorExplicit ? priorExplicit : (prior === 0 ? base : suffixPath(base, prior));
      if (priorPath === path) { path = suffixPath(path, index); break; }
    }
  }
  return path;
}

// Fire-and-forget Telegram report through the local bridge. Another agent owns /report and
// forwards to Telegram. A failed report must never break generation, so we swallow errors.
function reportToTelegram(payload) {
  try {
    fetch(`${BRIDGE}/report`, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
  } catch {}
}

// Health ping: report the ChatGPT logged-in state to the bridge so its /health endpoint knows
// the extension is alive and signed in. Best-effort and fire-and-forget like reportToTelegram, so
// a failed ping never breaks generation. Throttled to at most one ping per PING_MIN_MS to avoid
// spamming the bridge from every sweep tick.
const PING_MIN_MS = 5000;
let lastPingAt = 0;
function pingHealth(loggedIn) {
  const now = Date.now();
  if (now - lastPingAt < PING_MIN_MS) return; // throttle: skip if we pinged < 5s ago
  lastPingAt = now;
  try {
    fetch(`${BRIDGE}/ping`, { method: 'POST', body: JSON.stringify({ loggedIn: !!loggedIn, at: now }) }).catch(() => {});
  } catch {}
}

async function runQueue(jobs, folder) {
  running = true;
  stopFlag = false;
  // Hold the SW alive for the whole queue: generation awaits run far longer than
  // the MV3 idle window, so without this the worker can die mid-batch.
  startKeepAlive();

  const lanes = Math.min(concurrency(), Math.max(1, jobs.length));
  const pool = await buildTabPool(lanes);
  if (!pool.length) { send({ type: 'done', error: 'Open ChatGPT first.' }); running = false; stopKeepAlive(); return; }

  const projectUrls = {};
  let done = 0;
  let cursor = 0;

  // Shared cursor over the job list; each worker pulls the next job with its index.
  const nextJob = () => {
    if (stopFlag || cursor >= jobs.length) return null;
    const index = cursor++;
    return { index, job: withCanonicalProject(jobs[index]) };
  };

  async function worker(entry, laneNo) {
    // Stagger lane starts so we do not fire every parallel job at the exact same moment.
    if (laneNo > 0) await wait(laneNo * STAGGER_MS);
    for (;;) {
      // Stop check at the TOP of each iteration: a stop halts this lane before pulling a new job.
      if (stopFlag) break;
      // Pause: hold between jobs while the panel paused; the in-flight job (if any) already finished.
      while (pauseFlag && !stopFlag) await wait(500);
      if (stopFlag) break;
      const item = nextJob();
      if (!item) break;
      const { index, job } = item;
      // The job is pulled but the tab has not started yet: it is QUEUED, not generating. Project
      // prep below can wait (serialized per project), so reporting "generating" here would lie to
      // the panel/Telegram while the tab still sits idle. We flip to "generating" only once we are
      // about to actually type+generate in the tab (just before the ask() call).
      send({ type: 'queue', index, total: jobs.length, name: job.name });
      send({ type: 'progress', job, status: 'queued' });
      laneStatus(entry.id, laneRec('queued', job, { detail: 'queued' }));

      // Prepare the project on this tab only if it is not already prepared here. A project hiccup
      // is NON-FATAL: if prep fails we still generate, just in a plain home chat (noProject), so
      // one bad project never blocks the rest of the batch.
      let runJobPayload = job;
      const prepared = await ensureProjectOnTab(entry, job.project, projectUrls);
      if (!prepared.ok) {
        // Surface the skip on the project channel (a flow label, not the run slot) so the run slot
        // is handled by the generate path below and the image still downloads.
        send({ type: 'project', project: job.project, status: 'skipped', error: prepared.error || 'setup failed' });
        runJobPayload = { ...job, noProject: true };
        await openRoute(entry.id, 'https://chatgpt.com/').catch(() => {});
      } else if (job.project && projectUrls[job.project]) {
        // Reopen the project composer so each chat is born inside the project.
        await openRoute(entry.id, projectUrls[job.project]).catch(() => {});
      }

      // Last stop check before firing a generate: project prep can take seconds, so a stop that
      // landed during prep must not start a fresh generation. abortAllTabs already messaged the
      // tab, but bailing here avoids even sending the generate request.
      if (stopFlag) break;
      // NOW the tab actually starts typing+generating: flip to "generating" so the panel and
      // Telegram only report real in-flight work, never a job still waiting on a busy lane.
      send({ type: 'progress', job, status: 'generating' });
      reportToTelegram({ job, status: 'generating' });
      laneStatus(entry.id, laneRec('generating', job, { detail: 'generating' }));
      const result = await askGenerate(entry.id, { type: 'generate', job: runJobPayload });
      // content.js returns images:[...] (one entry per variant). Fall back to [dataUrl] so a
      // single-image result still downloads exactly as before.
      const images = (result.ok && Array.isArray(result.images) && result.images.length)
        ? result.images
        : (result.ok && result.dataUrl ? [result.dataUrl] : []);
      if (images.length) {
        let any = false;
        for (let i = 0; i < images.length; i++) {
          const path = variantPath(job, folder, i);
          try {
            await downloadDataUrl(images[i], path);
            any = true;
            persistPreview((job.variantPaths && job.variantPaths[i]) || job.relativePath, images[i]);
            send({ type: 'progress', job, status: 'done', variantIndex: i, path, thumb: images[i], renamed: result.renamed, moved: result.moved });
            reportToTelegram({ job, status: 'done', dataUrl: images[i] });
          } catch (error) {
            send({ type: 'progress', job, status: 'error', variantIndex: i, error: `download: ${error.message}` });
            reportToTelegram({ job, status: 'error', error: `download: ${error.message}` });
          }
        }
        // ChatGPT often returns fewer images than asked. Clear the run slots that never got an
        // image (M..N-1) so they stop spinning "generating" forever and the user can re-run them.
        const expected = job.variants || (job.variantPaths && job.variantPaths.length) || 1;
        for (let i = images.length; i < expected; i++) {
          send({ type: 'progress', job, status: 'missing', variantIndex: i, path: job.variantPaths && job.variantPaths[i] });
        }
        if (any) done++;
        laneStatus(entry.id, laneRec(any ? 'done' : 'error', job, { detail: any ? 'done' : 'no image saved' }));
      } else {
        // Surface rate-limit and other errors; do not keep hammering this lane is fine, but
        // if ChatGPT reported a hard image cap, stop launching anything new.
        send({ type: 'progress', job, status: 'error', error: result.error || 'generation failed' });
        reportToTelegram({ job, status: 'error', error: result.error || 'generation failed' });
        laneStatus(entry.id, laneRec(laneErrState(result.error), job, { detail: result.error || 'generation failed', error: result.error || 'generation failed' }));
        if (result.error && /image limit|too many requests/i.test(result.error)) { stopFlag = true; scheduleAutoResume(); }
      }
    }
  }

  // One worker per pooled tab, capped by lanes. Each is offset by STAGGER_MS.
  const workers = pool.slice(0, lanes).map((entry, laneNo) => worker(entry, laneNo));
  await Promise.all(workers);

  // Release this run's pool tabs so a future stop does not spuriously abort them.
  for (const entry of pool) activePoolTabs.delete(entry.id);
  // A run that finished its whole list (no leftover jobs) had no cap stop, so wipe any stale
  // auto-resume schedule + alarm. A cap-driven stop leaves jobs unprocessed and keeps its schedule.
  if (cursor >= jobs.length) clearAutoResume();
  if (stopFlag && cursor < jobs.length) send({ type: 'stopped', at: cursor });
  running = false;
  // Let the SW suspend if no bridge sweep is also active.
  stopKeepAlive();
  send({ type: 'done', generated: done, total: jobs.length });
}

async function postResult(id, data) {
  try { await fetch(`${BRIDGE}/result`, { method: 'POST', body: JSON.stringify({ id, ...data }) }); } catch {}
}

// Run a single bridge job on a given pool tab. Keeps per-tab project caching via the entry.
async function runBridgeJob(entry, rawJob, projectUrls) {
  // Canonicalize the project name so the bridge path shares the create-once cache and the
  // exact-match name check with the foreground queue (same normalization, same one project).
  const job = withCanonicalProject(rawJob);
  // Project prep is NON-FATAL here too: if it fails we still generate in a plain home chat
  // (noProject) and post the image back, marking moved:false, instead of failing the job.
  let runJobPayload = job;
  const prepared = await ensureProjectOnTab(entry, job.project, projectUrls);
  if (!prepared.ok) {
    send({ type: 'project', project: job.project, status: 'skipped', error: prepared.error || 'setup failed' });
    runJobPayload = { ...job, noProject: true };
    await openRoute(entry.id, 'https://chatgpt.com/').catch(() => {});
  } else if (job.project && projectUrls[job.project]) {
    await openRoute(entry.id, projectUrls[job.project]).catch(() => {});
  }
  send({ type: 'bridge', job, status: 'generating' });
  reportToTelegram({ job, status: 'generating' });
  laneStatus(entry.id, laneRec('generating', job, { detail: 'generating' }));
  // Per-job heartbeat: re-report 'generating' every 60s so the bridge orphan watchdog can tell a
  // slow-but-live multi-variant render from a dead lane and never re-queues a running job.
  const beatTimer = setInterval(() => reportToTelegram({ job, status: 'generating' }), 60000);
  let result, images;
  try {
    result = await askGenerate(entry.id, { type: 'generate', job: runJobPayload });
    // content.js returns images:[...] (one per variant). Fall back to [dataUrl] for single-image.
    images = imagesFromResult(result);
    // ONE bounded auto-retry on a clearly TRANSIENT failure: re-run the SAME job once on a fresh
    // attempt before posting failure. Never retry a refusal, rate limit, or not-logged-in (those are
    // terminal and must fail immediately). The retry replaces result/images so only the final
    // outcome is acted on below, guaranteeing exactly one /result per job.
    if (!images.length && isTransientError(result.error)) {
      await wait(1500);
      result = await askGenerate(entry.id, { type: 'generate', job: runJobPayload });
      images = imagesFromResult(result);
    }
  } finally { clearInterval(beatTimer); }
  if (images.length) {
    // Trace the chat URL so the caller can find this generation's conversation. The bridge stores
    // job.chatUrl and surfaces it in /status; the panel send carries it too (harmless if unused).
    const chatUrl = result.conversationPath ? ('https://chatgpt.com' + result.conversationPath) : undefined;
    const expected = job.variants || (job.variantPaths && job.variantPaths.length) || 1;
    // Bridge writes EVERY variant to OUT/variantPaths[i] in this one /result. It is the only writer
    // rooted at OUT, so all N land in the right place (chrome.downloads is rooted at ~/Downloads and
    // would misroute variants when OUT is elsewhere). Back-compat: a length-1 array == the old dataUrl.
    await postResult(job.id, { ok: true, images, captured: images.length, expected, partial: images.length < expected, renamed: result.renamed, moved: result.moved, chatUrl });
    for (let i = 0; i < images.length; i++) {
      persistPreview((job.variantPaths && job.variantPaths[i]) || job.relativePath, images[i]);
      send({ type: 'bridge', job, status: 'done', variantIndex: i, path: job.variantPaths && job.variantPaths[i], thumb: images[i], chatUrl });
      reportToTelegram({ job, status: 'done', dataUrl: images[i] });
    }
    laneStatus(entry.id, laneRec('done', job, { detail: images.length < expected ? ('saved ' + images.length + ' of ' + expected) : 'done' }));
    // ChatGPT often returns fewer images than asked. Clear the run slots that never got an image
    // (M..N-1) so they stop spinning "generating" forever and the user can re-run them.
    for (let i = images.length; i < expected; i++) {
      send({ type: 'bridge', job, status: 'missing', variantIndex: i, path: job.variantPaths && job.variantPaths[i] });
    }
  } else {
    await postResult(job.id, { ok: false, error: result.error || 'generation failed' });
    send({ type: 'bridge', job, status: 'error', error: result.error });
    reportToTelegram({ job, status: 'error', error: result.error || 'generation failed' });
    laneStatus(entry.id, laneRec(laneErrState(result.error), job, { detail: result.error || 'generation failed', error: result.error || 'generation failed' }));
    // Signal a rate limit so the caller PAUSES the queue instead of burning every remaining job.
    if (isRateLimitError(result.error)) return { rateLimited: true };
  }
  return {};
}

// A rate-limit / image-cap signal from ChatGPT. When this trips we must stop pulling fresh jobs
// (each would just fail the same way) and pause the bridge so the user can resume after the cap
// resets, instead of cascading errors across the whole batch.
function isRateLimitError(error) {
  return /image limit|too many requests|reached its image limit|rate limit|quota|try again later|please wait a moment/i.test(String(error || ''));
}

// Normalize a content.js generate result into an images array. images:[...] (one per variant) when
// present, else [dataUrl] for single-image, else [] on failure. Shared by the queue and bridge.
function imagesFromResult(result) {
  if (!result || !result.ok) return [];
  if (Array.isArray(result.images) && result.images.length) return result.images;
  return result.dataUrl ? [result.dataUrl] : [];
}

// A clearly TRANSIENT generate failure worth ONE retry: a dropped port, a missed image, a flaky
// upload or network, or a tab that never became ready. Deliberately NOT transient: a refusal, a
// rate limit (isRateLimitError), or not-logged-in, which are terminal and must fail immediately.
function isTransientError(error) {
  const e = String(error || '');
  if (!e) return false;
  if (isRateLimitError(e)) return false;
  if (/refused|not logged in|logged out|sign in/i.test(e)) return false;
  return /no image was generated|message channel|receiving end|back\/forward cache|upload|network|did not become ready/i.test(e);
}

// Clear any pending auto-resume: cancel the alarm AND wipe the stored target time so a stale
// schedule never fires later. Best-effort; safe to call when nothing is scheduled. Called on a
// fresh run, a manual resume, and inside doResume() once the resume actually happens.
async function clearAutoResume() {
  try { await chrome.alarms.clear('auto-resume'); } catch {}
  try { await chrome.storage.local.remove('resumeAt'); } catch {}
}

// Schedule an automatic resume AUTO_RESUME_MS from now. Persists the target time to
// chrome.storage.local (survives a computer restart) AND arms a chrome.alarms alarm (survives SW
// eviction). Emits an 'autoResume' message + a Telegram line so the user can see when it continues.
// Idempotent-ish: a later cap simply pushes the resume time forward.
async function scheduleAutoResume() {
  const resumeAt = Date.now() + AUTO_RESUME_MS;
  try { await chrome.storage.local.set({ resumeAt }); } catch {}
  try { chrome.alarms.create('auto-resume', { when: resumeAt }); } catch {}
  send({ type: 'autoResume', resumeAt });
  reportToTelegram({ status: 'autoResume', resumeAt, error: `Image cap hit. Auto-resume scheduled for ${new Date(resumeAt).toLocaleString()}.` });
}

// Resume generation after a cap (auto via the alarm, or manual via Continue). Clears the pause,
// tells the bridge to resume, wipes the stored schedule + alarm, re-drives the bridge sweep, and
// notifies the panel. Every fetch is wrapped so a missing bridge never throws.
async function doResume() {
  pauseFlag = false;
  try { await fetch(`${BRIDGE}/command`, { method: 'POST', body: JSON.stringify({ type: 'resume' }) }); } catch {}
  await clearAutoResume();
  send({ type: 'resumed' });
  // Re-pull work now so the batch picks up immediately instead of waiting for the next poll tick.
  pollBridge();
}

async function pollBridge() {
  // Ingest any codex-driven images FIRST, every poll, regardless of queue/sweep state. Codex
  // renders on a separate quota and relays to the bridge; this is the only place those images
  // enter the panel. It is cheap and self-guarded (never throws, never blocks), so it runs even
  // when we are about to early-return below (e.g. a foreground queue is running).
  ingestCodexResults();
  // Do not run alongside a foreground queue, never exceed one bridge sweep at a time, and never
  // start a new sweep while stopped (stop must not immediately pull fresh bridge jobs).
  if (running || bridgeBusy || stopFlag) return;
  bridgeBusy = true;
  // Hold the SW alive for the whole sweep: each bridge job awaits a ~2min generation, longer
  // than the MV3 idle window, so the worker would otherwise be evicted mid-await and orphan the
  // running job. Keepalive stays up until bridgeBusy clears in the finally below.
  startKeepAlive();
  let pool = [];
  try {
    // Peek one job first so an empty queue stays cheap (no tab pool, no reload churn).
    let next;
    try { next = await (await fetch(`${BRIDGE}/next`)).json(); } catch { return; }
    if (next.reload) { chrome.runtime.reload(); return; }
    // HTTP-driven abort: the bridge signals { abort:true } once when a cancel was
    // requested. Abort every tab and end this sweep cleanly. We do NOT set a
    // persistent stopFlag: the bridge already cleared its queue, so the next
    // enqueued job runs normally on a later sweep. The finally below releases the
    // (still empty) pool, so no tracked tabs leak.
    if (next.abort) { abortAllTabs(); return; }
    if (!next.job) {
      // Idle poll: queue is empty but the extension is alive. Best-effort report our logged-in
      // state to the bridge /health by pinging an existing chatgpt.com tab (throttled internally).
      try {
        const tab = await chatgptTab();
        if (tab) { const p = await ask(tab.id, { type: 'ping' }); pingHealth(p && p.ok && p.loggedIn); }
      } catch {}
      return;
    }

    // Size the pool to ACTUAL demand, not a fixed full pool. We already peeked one job (now
    // "running"), so lanes = pending-still-waiting + that one, capped by concurrency. A single
    // agentic job therefore opens exactly ONE background tab; a real batch still scales to the cap.
    let pending = 0;
    try { const s = await (await fetch(`${BRIDGE}/status`)).json(); pending = s.pending || 0; } catch {}
    const lanes = Math.max(1, Math.min(concurrency(), pending + 1));
    pool = await buildTabPool(lanes);
    if (!pool.length) return postResult(next.job.id, { ok: false, error: 'no ChatGPT tab open' });
    // A ready pool tab means ChatGPT is reachable and signed in. Report logged-in to the bridge
    // /health at the start of this sweep (throttled internally so back-to-back sweeps do not spam).
    pingHealth(true);

    const projectUrls = {};
    // Sweep-scoped rate-limit latch. The moment ANY lane sees a rate-limit error we stop pulling
    // fresh jobs (every remaining one would just fail the same way and burn the batch) and pause
    // the bridge so the queue holds its remaining pending jobs until the user resumes.
    let rateLimitHit = false;
    // Sweep-scoped abort latch. Set when /next returns { abort:true } mid-sweep. It is NOT the
    // persistent stopFlag: it only halts THIS sweep's lanes. A later enqueued job runs normally.
    let aborted = false;

    // Each lane: handle the job it already holds, then keep pulling /next until the bridge
    // is empty. bridgeInFlight is bounded by the pool size so we never exceed N concurrent.
    async function lane(entry, firstJob, laneNo) {
      if (laneNo > 0) await wait(laneNo * STAGGER_MS);
      let job = firstJob;
      for (;;) {
        // Check stop at the TOP of each iteration so a stop mid-sweep halts before the next job.
        // A rate-limit OR abort latch halts the lane the same way so no lane pulls a doomed job.
        if (!job || stopFlag || rateLimitHit || aborted) break;
        bridgeInFlight++;
        let outcome = {};
        try { outcome = (await runBridgeJob(entry, job, projectUrls)) || {}; }
        finally { bridgeInFlight--; }
        if (outcome.rateLimited && !rateLimitHit) {
          // Latch + pause the bridge once. Pausing makes /next return { paused:true } so no other
          // lane (or a later sweep) pulls work until the user resumes after the cap resets.
          rateLimitHit = true;
          send({ type: 'bridge', status: 'paused', error: 'rate limit reached; queue paused' });
          reportToTelegram({ status: 'error', error: 'Rate limit reached. Queue paused; resume when the cap resets.' });
          try { await fetch(`${BRIDGE}/command`, { method: 'POST', body: JSON.stringify({ type: 'pause' }) }); } catch {}
          // Schedule an automatic resume once the cap window passes (survives SW eviction + restart).
          scheduleAutoResume();
        }
        if (stopFlag || rateLimitHit || aborted) break;
        // Pull the next bridge job for this lane.
        let more;
        try { more = await (await fetch(`${BRIDGE}/next`)).json(); } catch { break; }
        if (more.reload) { chrome.runtime.reload(); return; }
        // HTTP-driven abort mid-sweep: latch + abort every tab once, then break this lane. The
        // outer finally releases all pool tabs from activePoolTabs, so nothing leaks. No persistent
        // stopFlag, so the next enqueued job runs normally on a later sweep.
        if (more.abort) { if (!aborted) { aborted = true; abortAllTabs(); } break; }
        if (more.paused) break; // bridge paused (e.g. by another lane's rate-limit latch)
        job = more.job || null;
      }
    }

    const lanesUsed = pool.slice(0, lanes);
    const tasks = [lane(lanesUsed[0], next.job, 0)];
    // Seed remaining lanes by pulling additional jobs up front; idle lanes simply exit. Stop
    // gating here too so a stop between peeking and seeding does not launch more lanes.
    for (let i = 1; i < lanesUsed.length; i++) {
      if (stopFlag || aborted) { tasks.push(lane(lanesUsed[i], null, i)); continue; }
      let seed = null;
      try {
        const r = await (await fetch(`${BRIDGE}/next`)).json();
        if (r.reload) { chrome.runtime.reload(); return; }
        // Abort during seeding: latch + abort tabs once, then seed remaining lanes empty so they exit.
        if (r.abort) { if (!aborted) { aborted = true; abortAllTabs(); } }
        else seed = r.job || null;
      } catch {}
      tasks.push(lane(lanesUsed[i], seed, i));
    }
    await Promise.all(tasks);
  } finally {
    // Release this sweep's pool tabs so a later stop never spuriously aborts them.
    for (const entry of pool) activePoolTabs.delete(entry.id);
    bridgeBusy = false;
    // Allow the SW to suspend now that this sweep is done (unless a queue is still running).
    stopKeepAlive();
  }
}

setInterval(pollBridge, 3000);
chrome.alarms.create('bridge-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  // Auto-resume fired: the cap window has passed, so resume generation now.
  if (alarm.name === 'auto-resume') { doResume(); return; }
  if (alarm.name !== 'bridge-poll') return;
  // Keep the idle window honest: any active work resets the clock.
  if (workActive()) lastWorkAt = Date.now();
  pollBridge();
  // Piggyback owned-tab cleanup on the same low-frequency wake so we never hold
  // the SW alive just to reclaim tabs. cleanupOwnedTabs no-ops unless truly idle.
  cleanupOwnedTabs();
});

// Re-arm the auto-resume across an SW restart / computer restart (belt-and-suspenders: alarms also
// persist, but re-reading the stored target makes the behavior robust even if the alarm was lost).
// If the stored resumeAt is still in the future, recreate the alarm for that exact time. If it is
// already in the past (e.g. the machine was off when it was due), resume immediately.
async function rearmAutoResume() {
  let resumeAt;
  try { ({ resumeAt } = await chrome.storage.local.get('resumeAt')); } catch { return; }
  if (!resumeAt) return;
  if (resumeAt > Date.now()) {
    try { chrome.alarms.create('auto-resume', { when: resumeAt }); } catch {}
    send({ type: 'autoResume', resumeAt });
  } else {
    doResume();
  }
}
chrome.runtime.onStartup.addListener(rearmAutoResume);
chrome.runtime.onInstalled.addListener(rearmAutoResume);
rearmAutoResume();

// Ingest codex results once on startup too, so images relayed while the SW was evicted show up
// immediately on wake instead of waiting for the first 3s poll. Self-guarded; never throws.
ingestCodexResults();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'run') {
    if (running) { sendResponse({ ok: false, error: 'A generation is already running.' }); return; }
    pauseFlag = false; // a fresh run never starts paused
    // A fresh run cancels any pending auto-resume so a stale schedule never fires mid-batch.
    clearAutoResume();
    runQueue(message.jobs || [], message.folder || '').catch((error) => {
      running = false;
      stopKeepAlive();
      send({ type: 'done', error: error.message || String(error) });
    });
    sendResponse({ ok: true });
  } else if (message.type === 'stop') {
    stopFlag = true;
    pauseFlag = false;
    fetch(`${BRIDGE}/reset`, { method: 'POST' }).catch(() => {});
    abortAllTabs();
    sendResponse({ ok: true });
  } else if (message.type === 'pause') {
    pauseFlag = true;
    fetch(`${BRIDGE}/command`, { method: 'POST', body: JSON.stringify({ type: 'pause' }) }).catch(() => {});
    sendResponse({ ok: true });
  } else if (message.type === 'resume') {
    // Manual Continue: clears the pause, cancels any pending auto-resume alarm + stored resumeAt,
    // tells the bridge to resume, and re-drives the sweep (all via doResume()).
    doResume();
    sendResponse({ ok: true });
  } else if (message.type === 'lane-status') {
    // Per-image granularity pushed from content.js: stamp the sender's tab id, then merge + repush.
    if (sender && sender.tab) laneStatus(sender.tab.id, message.record || {});
    sendResponse({ ok: true });
  } else if (message.type === 'status') {
    sendResponse({ ok: true, running });
  } else if (message.type === 'bridgeTick') {
    pollBridge();
    sendResponse({ ok: true });
  } else if (message.type === 'openPanel') {
    const windowId = sender && sender.tab && sender.tab.windowId;
    const tabId = sender && sender.tab && sender.tab.id;
    openPanel(windowId, tabId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  }
  return true;
});
