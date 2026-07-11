// lib/semantics.mjs — S10 semantics: the ONE model call in the copy pipeline (COPY-ENGINE-V2
// §3.7, contracts "S10 — semantics call"). The model labels roles/groups/order/flags for facts
// we already measured — it NEVER produces geometry or text content, so the worst failure mode
// is a mislabeled role, not a broken layout.
//
// Invariants:
//   • buildFactsPayload is deterministic: same input → same payload, same reduction order
//     (regions dropped first, then text truncated harder), hard-capped at ~2000 tokens.
//   • labelFacts never throws; on any failure (endpoint down, parse failure after one retry,
//     timeout) it returns { ok:false } WITH role='other' defaults so the pipeline proceeds.
//   • validateSemantics is pure (no model, no IO) and enforces every contract rule: unknown
//     ids dropped, missing ids defaulted to 'other', roles coerced to the enum, `order` kept
//     only as a permutation of the caller-declared ambiguous ids, groups ≥2 known members,
//     flag notes ≤120 chars.
//   • Model routing rides lib/llm.mjs llmVision (do not duplicate provider logic here);
//     SEMANTICS_MODEL env pins a specific model id, otherwise llm.mjs config resolves.
//
// Called by: the S0 copy-pipeline orchestrator (design-agent runCopyReference, assembler-v2);
// tests exercise buildFactsPayload/validateSemantics without a model.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmVision } from './llm.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = join(STUDIO, '.state', 'semantics-tmp');

// ── contract enums ───────────────────────────────────────────────────────────────────────────
export const TEXT_ROLES = ['headline', 'subhead', 'body', 'cta', 'price', 'badge', 'logo', 'caption', 'legal', 'other'];
export const ELEMENT_ROLES = ['product', 'logo', 'icon', 'decoration', 'person', 'ui-chrome', 'other'];

const FACTS_TOKEN_CAP = 2000;   // hard cap for the facts JSON (~4 chars/token heuristic)
const FLAG_NOTE_MAX = 120;
const GROUP_NAME_MAX = 60;

const estTokens = (s) => Math.ceil(String(s).length / 4);

// ── fills → short strings ('flat #101010' / 'linear #000→#333 172°') ─────────────────────────
function shortHex(color) {
  const c = String(color || '').trim();
  const m = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (!m) return c;
  const h = m[1].toLowerCase();
  if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) return `#${h[0]}${h[2]}${h[4]}`;
  return `#${h}`;
}

/** Compact one-line description of an S5 fill fit (or pass a string through unchanged). */
export function fillToString(fill) {
  if (fill == null) return 'photo';
  if (typeof fill === 'string') return fill.slice(0, 48);
  const kind = String(fill.kind || 'photo');
  if (kind === 'flat') return `flat ${shortHex(fill.color || '#000000')}`;
  if (kind === 'linear' || kind === 'radial') {
    const stops = (Array.isArray(fill.stops) ? fill.stops : []).map((s) => shortHex(s?.color || '#000000')).join('→') || '#000';
    const angle = kind === 'linear' && Number.isFinite(Number(fill.angleDeg)) ? ` ${Math.round(Number(fill.angleDeg))}°` : '';
    return `${kind} ${stops}${angle}`;
  }
  return kind;
}

const intBox = (b) => ({
  x: Math.round(Number(b?.x) || 0), y: Math.round(Number(b?.y) || 0),
  w: Math.round(Number(b?.w) || 0), h: Math.round(Number(b?.h) || 0),
});

// ── buildFactsPayload ────────────────────────────────────────────────────────────────────────
/**
 * Compact facts per the S10 contract schema. Deterministic reduction to stay under
 * ~2000 tokens: text truncated at 80 chars; if over cap drop `regions` first, then truncate
 * text harder (40 → 24 chars). Returns:
 *   { imageBudget, factsJson, facts, tokens, dropped }
 * imageBudget = tokens left under the cap after the facts (informational, for the image +
 * instructions side of the request); dropped = human-readable log of what reduction removed.
 */
export function buildFactsPayload({ canvas, blocks, texts, elements, regions } = {}) {
  const dropped = [];
  const blocksIn = Array.isArray(blocks) ? blocks : (Array.isArray(texts) ? texts : []); // accept S2.5 `blocks` or facts-shaped `texts`
  const texts0 = blocksIn.map((b, i) => ({
    id: String(b?.id ?? `B${i}`),
    text: String(b?.text ?? ''),
    box: intBox(b?.box || b),
    fontSizePx: Math.round(Number(b?.fontSizePx) || 0),
  }));
  const els = (Array.isArray(elements) ? elements : []).map((e, i) => ({
    id: String(e?.id ?? `E${i}`),
    box: intBox(e?.box || e),
    kind: String(e?.kind ?? 'shape'),
  }));
  const regs = (Array.isArray(regions) ? regions : []).map((r, i) => ({
    id: String(r?.id ?? `R${i}`),
    box: intBox(r?.box || r),
    fill: fillToString(r?.fill),
  }));

  const build = (textCap, withRegions) => {
    const facts = {
      canvas: { w: Math.round(Number(canvas?.w) || 0), h: Math.round(Number(canvas?.h) || 0) },
      texts: texts0.map((t) => ({ ...t, text: t.text.slice(0, textCap) })),
      elements: els,
    };
    if (withRegions) facts.regions = regs;
    return facts;
  };

  // Deterministic reduction ladder: 80-char text → drop regions → 40-char → 24-char text.
  let facts = build(80, true);
  let json = JSON.stringify(facts);
  if (estTokens(json) > FACTS_TOKEN_CAP && regs.length) {
    dropped.push(`regions (${regs.length})`);
    facts = build(80, false);
    json = JSON.stringify(facts);
  }
  for (const cap of [40, 24]) {
    if (estTokens(json) <= FACTS_TOKEN_CAP) break;
    dropped.push(`text truncated to ${cap} chars`);
    facts = build(cap, facts.regions !== undefined);
    json = JSON.stringify(facts);
  }
  if (dropped.length) {
    try { console.warn(`[semantics] facts payload reduced: ${dropped.join('; ')}`); } catch { /* logging is best-effort */ }
  }
  const tokens = estTokens(json);
  return { imageBudget: Math.max(0, FACTS_TOKEN_CAP - tokens), factsJson: json, facts, tokens, dropped };
}

// ── tolerant JSON parse (layout-extract extractJson pattern, generalized) ────────────────────
/** Parse a model reply that may be fenced, prefixed/suffixed with prose, or plain JSON.
 *  Returns the object or null — never throws. */
export function tolerantParseJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const attempts = [s];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) attempts.push(fence[1].trim());
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(s.slice(first, last + 1));
  // balanced-brace scan from the first '{' (survives trailing prose that contains braces)
  if (first !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = first; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { attempts.push(s.slice(first, i + 1)); break; }
    }
  }
  for (const a of attempts) {
    try {
      const obj = JSON.parse(a);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch { /* try the next salvage */ }
  }
  return null;
}

// ── validateSemantics (pure — enforces every contract rule) ──────────────────────────────────
const normToken = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
// small typo/synonym map on top of exact enum matching (normalized keys)
const TEXT_SYNONYMS = { title: 'headline', heading: 'headline', header: 'headline', subtitle: 'subhead', subheading: 'subhead', button: 'cta', calltoaction: 'cta', disclaimer: 'legal', fineprint: 'legal', paragraph: 'body', text: 'body' };
const ELEMENT_SYNONYMS = { image: 'other', photo: 'other', brand: 'logo', ui: 'ui-chrome', chrome: 'ui-chrome', shape: 'decoration', graphic: 'decoration', human: 'person', model: 'person' };

function coerceRole(raw, roles, synonyms) {
  const n = normToken(raw);
  if (!n) return 'other';
  for (const r of roles) if (normToken(r) === n) return r;
  if (synonyms[n]) return synonyms[n];
  return 'other';
}

/**
 * Clean a model reply against the facts it was asked about. Pure; never throws; accepts any
 * garbage (null, prose, wrong shapes). opts.ambiguousIds = the ids the CALLER flagged as
 * z-order-ambiguous — `order` is accepted only as an exact permutation of that set.
 * Returns { texts, elements, groups, order, flags } with every facts id covered.
 */
export function validateSemantics(reply, facts, { ambiguousIds = [] } = {}) {
  const r = (reply && typeof reply === 'object' && !Array.isArray(reply)) ? reply : {};
  const f = (facts && typeof facts === 'object') ? facts : {};
  const textIds = (Array.isArray(f.texts) ? f.texts : []).map((t) => String(t?.id ?? ''));
  const elementIds = (Array.isArray(f.elements) ? f.elements : []).map((e) => String(e?.id ?? ''));
  const regionIds = (Array.isArray(f.regions) ? f.regions : []).map((x) => String(x?.id ?? ''));
  const known = new Set([...textIds, ...elementIds, ...regionIds].filter(Boolean));

  const pickRoles = (arr, ids, roles, synonyms) => {
    const byId = new Map();
    for (const item of (Array.isArray(arr) ? arr : [])) {
      const id = String(item?.id ?? '');
      if (!ids.includes(id) || byId.has(id)) continue;   // unknown ids dropped; first label wins
      byId.set(id, coerceRole(item?.role, roles, synonyms));
    }
    // missing ids defaulted to 'other'; output order = facts order; extra keys stripped
    return ids.map((id) => ({ id, role: byId.get(id) ?? 'other' }));
  };

  const texts = pickRoles(r.texts, textIds, TEXT_ROLES, TEXT_SYNONYMS);
  const elements = pickRoles(r.elements, elementIds, ELEMENT_ROLES, ELEMENT_SYNONYMS);

  // groups: members filtered to known ids, deduped, ≥2 members required
  const groups = [];
  for (const g of (Array.isArray(r.groups) ? r.groups : [])) {
    const members = [...new Set((Array.isArray(g?.members) ? g.members : []).map((m) => String(m ?? '')).filter((m) => known.has(m)))];
    if (members.length < 2) continue;
    const name = String(g?.name ?? 'group').slice(0, GROUP_NAME_MAX) || 'group';
    groups.push({ name, members });
  }

  // order: accepted ONLY as an exact permutation of the caller-declared ambiguous set
  let order = [];
  const amb = [...new Set((Array.isArray(ambiguousIds) ? ambiguousIds : []).map(String))];
  const rawOrder = (Array.isArray(r.order) ? r.order : []).map((x) => String(x ?? ''));
  if (amb.length && rawOrder.length === amb.length
    && new Set(rawOrder).size === rawOrder.length
    && rawOrder.every((id) => amb.includes(id))) {
    order = rawOrder;
  }

  // flags: known ids only, note truncated to 120 chars
  const flags = [];
  for (const fl of (Array.isArray(r.flags) ? r.flags : [])) {
    const id = String(fl?.id ?? '');
    if (!known.has(id)) continue;
    const note = String(fl?.note ?? '').slice(0, FLAG_NOTE_MAX);
    if (!note.trim()) continue;
    flags.push({ id, note });
  }

  return { texts, elements, groups, order, flags };
}

// ── image downscale (≤768px long edge, via sharp; falls back to the original) ────────────────
async function downscaleForVision(imagePath) {
  try {
    const st = statSync(imagePath);
    const key = createHash('sha256').update(`${imagePath}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16);
    const out = join(TMP_DIR, `${basename(imagePath).replace(/\.[^.]+$/, '')}-${key}.png`);
    if (existsSync(out)) return out;
    const sharp = (await import('sharp')).default;
    mkdirSync(TMP_DIR, { recursive: true });
    await sharp(imagePath)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(out);
    return out;
  } catch {
    return imagePath;   // sharp missing/unreadable image → llmVision handles the original
  }
}

// ── the one model call ───────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = 'You label facts about an ad. Reply ONLY the JSON. Never invent ids, geometry, or text.';

function buildUserPrompt(factsJson, ambiguousIds) {
  const orderRule = ambiguousIds.length
    ? `"order": the ids ${JSON.stringify(ambiguousIds)} sorted back-to-front (a permutation of exactly that list).`
    : '"order": must stay [] (no ambiguous z-order in this ad).';
  return `FACTS about the ad image (ids, pixel boxes, extracted text — already measured, do not restate them):
${factsJson}

Label every fact id. Reply with ONLY this JSON shape:
{"texts":[{"id":"B0","role":"headline|subhead|body|cta|price|badge|logo|caption|legal|other"}],
 "elements":[{"id":"E0","role":"product|logo|icon|decoration|person|ui-chrome|other"}],
 "groups":[{"name":"short name","members":["id","id"]}],
 "order":[],
 "flags":[{"id":"E0","note":"short free text, e.g. 'starburst badge'"}]}
Rules: one role per id; use ONLY ids that appear in FACTS; groups need >=2 members; ${orderRule}`;
}

function defaults(facts, extra = {}) {
  const v = validateSemantics(null, facts);
  return { ok: false, ...v, model: null, ms: 0, ...extra };
}

/**
 * labelFacts(imagePath, facts, opts?) -> { ok, texts, elements, groups, order, flags, model, ms, raw? }
 * facts = the object from buildFactsPayload().facts (or contract-shaped equivalent).
 * opts: { ambiguousIds = [], timeoutMs = 90_000, signal, model, includeRaw = false }
 * Never throws. ok:false still carries validated role='other' defaults for every id.
 */
export async function labelFacts(imagePath, facts, {
  ambiguousIds = [],
  timeoutMs = 90_000,
  signal = null,
  model = null,
  includeRaw = false,
} = {}) {
  const started = Date.now();
  const forceModel = String(process.env.SEMANTICS_MODEL || model || '').trim() || null;
  if (!facts || typeof facts !== 'object') return defaults({}, { error: 'no facts', ms: Date.now() - started });
  const factsJson = typeof facts === 'string' ? facts : JSON.stringify(facts);
  const amb = [...new Set((Array.isArray(ambiguousIds) ? ambiguousIds : []).map(String))];

  let img = imagePath;
  try { img = await downscaleForVision(imagePath); } catch { /* keep original */ }

  const ask = (prompt, temperature) => llmVision(prompt, img, {
    system: SYSTEM_PROMPT,
    json: true,
    purpose: 'semantics',
    maxTokens: 3000,
    timeoutMs,
    signal,
    temperature,
    _forceModel: forceModel,
  });

  let usedModel = forceModel;
  let raw = null;
  let parsed = null;
  let error = null;
  try {
    let r = await ask(buildUserPrompt(factsJson, amb), 0);
    usedModel = r?.usage?.model || usedModel;
    if (r.ok) {
      raw = r.text;
      parsed = tolerantParseJson(r.text);
      if (!parsed) {
        // ONE retry with the parse error echoed back (temperature > 0 so the re-ask can differ)
        const retryPrompt = `${buildUserPrompt(factsJson, amb)}\n\nYour previous reply was not parseable JSON (error: could not extract a JSON object from: ${String(r.text).slice(0, 200)}). Reply again with ONLY the JSON object, no prose, no code fences.`;
        r = await ask(retryPrompt, 0.2);
        usedModel = r?.usage?.model || usedModel;
        if (r.ok) {
          raw = r.text;
          parsed = tolerantParseJson(r.text);
          if (!parsed) error = 'unparsable reply after retry';
        } else {
          error = r.error || 'model call failed on retry';
        }
      }
    } else {
      error = r.error || 'model call failed';
    }
  } catch (e) {
    error = String(e?.message || e);   // belt-and-braces: llmVision already never throws
  }

  const ms = Date.now() - started;
  if (!parsed) {
    const out = defaults(facts, { error: error || 'no reply', model: usedModel, ms });
    if (includeRaw && raw != null) out.raw = raw;
    return out;
  }
  const clean = validateSemantics(parsed, facts, { ambiguousIds: amb });
  const out = { ok: true, ...clean, model: usedModel, ms };
  if (includeRaw) out.raw = raw;
  return out;
}
