// PlannerRail — the Plan mode brain's cockpit (BRIEF Phase 1), docked beside PlanView.
//
// Everything the planner does is visible here: brief input → Run streams every agent step
// (SSE `plan` events → ui.planEvents), ranked TrendTrack refs render as cards with taste
// thumbs (approve/reject feeds the ranking weights), picking refs enables the reverse
// refs→brief flow, and the proposal (hypothesis + prompt drafts) lands at the bottom with
// copy actions. Imports are the ONLY metered action and say so on the button.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { Icon } from './Icon';
import type { PlanProposal, PlanRef } from '../types';
import s from './PlannerRail.module.css';

export default function PlannerRail() {
  const planEvents = useStore((st) => st.ui.planEvents);
  const brand = useStore((st) => st.brand);

  const [brief, setBrief] = useState('');
  const [importBrand, setImportBrand] = useState('');
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [refs, setRefs] = useState<PlanRef[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [votes, setVotes] = useState<Record<string, 1 | -1>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { api.getTaste().then((r) => setVotes(r.votes || {})); }, []);

  // Terminal SSE frame carries the proposal; refresh the local result from it.
  useEffect(() => {
    const last = planEvents[planEvents.length - 1];
    if (last?.done) {
      setRunning(false);
      if (last.result) {
        const res = last.result as PlanProposal;
        setProposal(res);
        if (res.refs?.length) setRefs(res.refs);
      }
    }
  }, [planEvents]);

  const flash = (m: string) => { setNote(m); window.setTimeout(() => setNote(null), 3200); };

  const run = async (mode: 'brief' | 'refs') => {
    if (running) return;
    if (mode === 'brief' && !brief.trim()) { flash('Write a brief first'); return; }
    if (mode === 'refs' && picked.size === 0) { flash('Pick refs first (checkboxes)'); return; }
    setProposal(null);
    setRunning(true);
    const r = await api.planRun({
      mode,
      brief: brief.trim(),
      refIds: [...picked],
      product: 'the product',
      brand: null, // rank across every cached brand
    });
    if (!r.ok) { setRunning(false); flash(r.error || 'run failed'); }
  };

  const doImport = async () => {
    const b = importBrand.trim().toLowerCase();
    if (!b || importing) return;
    setImporting(true);
    const r = await api.trendtrackImport(b, 25);
    setImporting(false);
    if (r.ok) flash(`Imported ${r.cached} ads (${r.images} images) · ${r.creditsRemaining ?? '?'} credits left`);
    else flash(r.error || 'import failed');
  };

  const voteRef = async (id: string, v: 1 | -1) => {
    const key = `ref:${id}`;
    const next = votes[key] === v ? 0 : v; // click again to clear
    const r = await api.voteTaste(key, next as 1 | -1 | 0);
    setVotes(r.votes || {});
  };

  const togglePick = (id: string) => {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  };

  const steps = planEvents.filter((e) => e.step).map((e) => e.step!);

  return (
    <aside className={s.rail} aria-label="Planner">
      <p className={`eyebrow ${s.railLabel}`}>Planner</p>

      <textarea
        className={s.brief}
        placeholder={`Brief — e.g. "morning stiffness angle for arthritis UGC, older hands"`}
        value={brief}
        rows={3}
        spellCheck={false}
        onChange={(e) => setBrief(e.target.value)}
      />
      <div className={s.runRow}>
        <button type="button" className={s.primaryBtn} onClick={() => run('brief')} disabled={running}>
          <Icon name="sparkles" size={13} />
          {running ? 'Running…' : 'Brief → refs'}
        </button>
        <button
          type="button" className={s.ghostBtn} onClick={() => run('refs')} disabled={running || picked.size === 0}
          title="Write a hypothesis + prompts FROM the picked refs"
        >
          Refs → brief{picked.size ? ` (${picked.size})` : ''}
        </button>
      </div>

      {/* metered import — explicit, cost-labeled */}
      <div className={s.importRow}>
        <input
          className={s.importInput}
          placeholder="Import brand… (≤25 credits)"
          value={importBrand}
          spellCheck={false}
          onChange={(e) => setImportBrand(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doImport(); }}
        />
        <button type="button" className={s.ghostBtn} onClick={doImport} disabled={importing || !importBrand.trim()}>
          {importing ? '…' : 'Import'}
        </button>
      </div>

      {note ? <p className={s.note}>{note}</p> : null}

      {/* visible agent stream */}
      {steps.length > 0 ? (
        <div className={s.stream}>
          {steps.map((st) => (
            <div key={`${st.at}-${st.i}`} className={s.step}>
              <span className={s.stepTool}>{st.tool}</span>
              <span className={s.stepSummary}>{st.summary}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ranked refs */}
      {refs.length > 0 ? (
        <>
          <p className={`eyebrow ${s.railLabel}`}>Refs · cached, 0 credits</p>
          <div className={s.refList}>
            {refs.map((r) => {
              const v = votes[`ref:${r.id}`];
              return (
                <div key={r.id} className={s.refCard} data-picked={picked.has(r.id) || undefined}>
                  {r.local_image ? (
                    <button type="button" className={s.refThumb} onClick={() => togglePick(r.id)} title="Pick / unpick">
                      <img src={api.trendtrackImageUrl(r.id)} alt="" loading="lazy" decoding="async" />
                    </button>
                  ) : null}
                  <div className={s.refBody}>
                    <span className={s.refHook}>{r.hook || '(no hook)'}</span>
                    <span className={s.refMeta}>
                      {r.brand} · {r.scaling_verdict}{r.days_running ? ` · ${r.days_running}d` : ''}{r.score != null ? ` · ${r.score}` : ''}
                    </span>
                    <span className={s.refActions}>
                      <button
                        type="button" className={s.voteBtn} data-on={v === 1 || undefined}
                        onClick={() => voteRef(r.id, 1)} title="Approve — boosts similar refs"
                      >
                        <Icon name="check" size={12} />
                      </button>
                      <button
                        type="button" className={s.voteBtn} data-off={v === -1 || undefined}
                        onClick={() => voteRef(r.id, -1)} title="Reject — sinks similar refs"
                      >
                        <Icon name="x" size={12} />
                      </button>
                      <label className={s.pickLabel}>
                        <input type="checkbox" checked={picked.has(r.id)} onChange={() => togglePick(r.id)} />
                        pick
                      </label>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {/* proposal */}
      {proposal ? (
        <>
          <p className={`eyebrow ${s.railLabel}`}>
            Proposal · {proposal.adType} · {proposal.hypothesisSource}
          </p>
          <div className={s.hypothesis}>{proposal.hypothesis}</div>
          <div className={s.drafts}>
            {proposal.prompts.map((p) => (
              <div key={p.id} className={s.draft}>
                <span className={s.draftHook}>{p.hook}</span>
                <button
                  type="button" className={s.ghostBtn}
                  onClick={() => copyText(p.id, p.prompt)}
                  title="Copy the full wrapped generation prompt"
                >
                  {copied === p.id ? 'Copied' : 'Copy prompt'}
                </button>
              </div>
            ))}
          </div>
          {brand ? (
            <p className={s.hint}>Paste a draft into any prompt via its Edit button, then Generate.</p>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
