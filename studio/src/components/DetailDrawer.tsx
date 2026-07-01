// DetailDrawer — premium floating image modal (Linear/Raycast + Claritas feel).
// Tall glass panel: a header bar with an "ad / variation / prompt" breadcrumb + close,
// a two-column body — large image stage (left) + a scrollable rail (right) holding
// REFERENCE / PROMPT / REVISE / ACTIONS sections. Actions live as a proper row under Revise.
// Keeps all functionality, Radix Dialog primitives, and the z 100/101 + isolation fix.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { useStore } from '../store';
import { api } from '../api';
import { buildDownloadFilename } from '../paths';
import type { AdNode, VariationNode, PromptNode, Slot, PromptInfo } from '../types';
import s from './DetailDrawer.module.css';

interface Located {
  ad: AdNode;
  variation: VariationNode;
  prompt: PromptNode;
  slot: Slot;
}

// Minimal caret-position measurement for the @ mention dropdown — mirrors the textarea's text into
// an off-screen div with identical box/font metrics, then reads the offset of a span placed at the
// caret. Trimmed-down version of the well-known "textarea-caret-position" technique; returns
// coordinates relative to the textarea's own border box (so they can be used directly as
// position:absolute top/left on a wrapper that exactly contains the textarea).
const MIRROR_STYLE_PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
  'tabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
] as const;

function getCaretCoordinates(el: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const style = window.getComputedStyle(el);
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  document.body.appendChild(div);
  for (const prop of MIRROR_STYLE_PROPS) {
    (div.style as unknown as Record<string, string>)[prop] = (style as unknown as Record<string, string>)[prop];
  }
  div.textContent = el.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = el.value.slice(position) || '.';
  div.appendChild(span);
  const top = span.offsetTop - el.scrollTop;
  const left = span.offsetLeft;
  const height = parseFloat(style.lineHeight || '16') || 16;
  document.body.removeChild(div);
  return { top, left, height };
}

function locate(ads: AdNode[], relPath: string): Located | null {
  for (const ad of ads) {
    for (const variation of ad.variations) {
      for (const prompt of variation.prompts) {
        const slot = prompt.slots.find((sl) => sl.relPath === relPath);
        if (slot) return { ad, variation, prompt, slot };
      }
    }
  }
  return null;
}

export default function DetailDrawer() {
  const drawerRel = useStore((st) => st.ui.drawerRel);
  const state = useStore((st) => st.state);
  const brand = useStore((st) => st.brand);
  const batch = useStore((st) => st.batch);
  const config = useStore((st) => st.config);
  const setUI = useStore((st) => st.setUI);

  const [promptInfo, setPromptInfo] = useState<PromptInfo | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [revising, setRevising] = useState(false);
  const [revisedOk, setRevisedOk] = useState(false);
  // Revise reference board — uploaded extra reference images (the original image is always included
  // server-side). `copied` drives the click-to-copy toast on the stage image.
  const [boardRefs, setBoardRefs] = useState<{ id: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // @ mention dropdown (Revise textarea) — `mentionQuery` is the in-progress text after an unclosed
  // "@" (null = closed), `mentionIndex` is the keyboard-highlighted row, `mentionPos` is computed
  // caret coordinates for the dropdown's inline position.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPos, setMentionPos] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);

  const found = useMemo(
    () => (drawerRel && state ? locate(state.ads, drawerRel) : null),
    [drawerRel, state],
  );

  const open = drawerRel != null;
  const close = () => setUI({ drawerRel: null });

  const adId = found?.ad.id ?? null;
  const variationId = found?.variation.id ?? null;
  const promptId = found?.prompt.id ?? null;

  useEffect(() => {
    if (!open || !brand || !batch || !adId || !variationId || !promptId) {
      setPromptInfo(null);
      setPromptLoading(false);
      return;
    }
    let alive = true;
    setPromptLoading(true);
    setPromptInfo(null);
    api
      .getPrompt(brand, batch, adId, variationId, promptId)
      .then((info) => { if (alive) setPromptInfo(info); })
      .finally(() => { if (alive) setPromptLoading(false); });
    return () => { alive = false; };
  }, [open, brand, batch, adId, variationId, promptId]);

  useEffect(() => {
    setInstruction('');
    setRevising(false);
    setRevisedOk(false);
    setBoardRefs([]);
    setCopied(false);
    setMentionQuery(null);
  }, [drawerRel]);

  // Ordered list of every slot that has an image, for arrow-key navigation.
  const order = useMemo(() => {
    if (!state) return [];
    const list: string[] = [];
    for (const ad of state.ads)
      for (const v of ad.variations)
        for (const p of v.prompts)
          for (const sl of p.slots)
            if (sl.relPath) list.push(sl.relPath);
    return list;
  }, [state]);

  const go = (dir: -1 | 1) => {
    if (!drawerRel || order.length < 2) return;
    const i = order.indexOf(drawerRel);
    if (i < 0) return;
    const next = order[(i + dir + order.length) % order.length];
    setUI({ drawerRel: next });
  };

  // Arrow keys move between images — but not while typing in the revise field.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, drawerRel, order]);

  // Close the @ mention dropdown on an outside click (the textarea itself handles Escape/Enter/Tab).
  useEffect(() => {
    if (mentionQuery === null) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (textareaRef.current?.contains(t)) return;
      if (mentionRef.current?.contains(t)) return;
      setMentionQuery(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [mentionQuery]);

  // Derived config refs + download filename. These run as hooks on EVERY render, so they MUST sit
  // ABOVE the early `return null` below — a useMemo placed after a conditional return changes the
  // hook count between renders and throws React error #310.
  const brandRef = config.brands.find((b) => b.id === brand);
  const batchRef = brandRef?.batches.find((bt) => bt.code === batch);
  const batchVersion = (batchRef as { version?: string } | undefined)?.version;
  const downloadName = useMemo(() => {
    if (!drawerRel) return undefined;
    return buildDownloadFilename(drawerRel, {
      brandName: brandRef?.name ?? brand ?? undefined,
      batchName: batchRef?.name ?? batch ?? undefined,
      batchVersion,
      adTitle: found?.ad.title || found?.ad.id,
      slotVersion: found?.slot.version,
    });
  }, [drawerRel, brandRef, batchRef, batchVersion, brand, batch, found]);

  if (!open) return null;

  const slot = found?.slot;
  const isArchived = slot?.status === 'archived';
  const refList = promptInfo?.refs?.length
    ? promptInfo.refs
    : promptInfo?.refUrl
      ? [{ role: 'extra' as const, name: promptInfo.refName || 'Reference', url: promptInfo.refUrl }]
      : [];
  const promptText = promptInfo?.text?.trim() || '';

  // Breadcrumb: ad / variation / prompt (falls back to the rel path if not located).
  const crumb = found
    ? [found.ad.title || found.ad.id, found.variation.label || found.variation.id, found.prompt.id].filter(Boolean)
    : [drawerRel ?? '—'];
  const crumbLabel = crumb.join(' / ');

  const doRevise = async () => {
    const text = instruction.trim();
    if (!drawerRel || !text || revising) return;
    setRevising(true);
    setRevisedOk(false);
    const r = await api.revise(drawerRel, text, boardRefs.map((b) => b.id));
    setRevising(false);
    if (r.ok) {
      setRevisedOk(true);
      setInstruction('');
      setMentionQuery(null);
      window.setTimeout(() => setRevisedOk(false), 4000);
    }
  };

  // Click the open image → copy the PNG to the clipboard (with a brief toast).
  const copyImage = async () => {
    if (!drawerRel) return;
    try {
      const blob = await fetch(api.imgUrl(drawerRel)).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be blocked (insecure context / permissions) — fail quietly */
    }
  };

  // Upload a single image file to the Revise board: read as a data URL → upload → append to
  // boardRefs. Shared by the file-picker (addRefs, below) and the textarea's paste handler so both
  // paths funnel through one upload routine.
  const uploadBoardFile = async (file: File): Promise<void> => {
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await api.uploadRef(dataUrl);
      if (r.ok && r.id && r.url) setBoardRefs((prev) => [...prev, { id: r.id as string, url: r.url as string }]);
    } catch { /* skip a failed file */ }
  };

  // Add reference image(s) to the Revise board via the file picker (up to 4 at a time).
  const addRefs = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    for (const file of Array.from(files).slice(0, 4)) {
      await uploadBoardFile(file);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Scan the textarea's text up to the caret for an in-progress "@token" and, if the board has any
  // extras to mention, open/update the dropdown with its position; otherwise close it.
  const updateMentionState = (ta: HTMLTextAreaElement) => {
    if (!boardRefs.length) { setMentionQuery(null); return; }
    const cursor = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cursor);
    const m = /@([a-zA-Z0-9]*)$/.exec(before);
    if (!m) { setMentionQuery(null); return; }
    setMentionQuery(m[1]);
    setMentionIndex(0);
    const caret = getCaretCoordinates(ta, cursor);
    setMentionPos({ top: caret.top + caret.height, left: caret.left });
  };

  // Insert "@imgN " at the caret, replacing the in-progress "@..." token, then close the dropdown.
  const insertMention = (boardIndex: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const label = `@img${boardIndex + 1} `;
    const cursor = ta.selectionStart ?? instruction.length;
    const before = instruction.slice(0, cursor);
    const m = /@([a-zA-Z0-9]*)$/.exec(before);
    const start = m ? cursor - m[0].length : cursor;
    const next = instruction.slice(0, start) + label + instruction.slice(cursor);
    setInstruction(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = start + label.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  // Extras currently attached to the board, filtered by the in-progress mention query (substring
  // match against "imgN"). Empty when the dropdown is closed or has no attached extras.
  const mentionItems = mentionQuery !== null
    ? boardRefs
        .map((b, i) => ({ id: b.id, url: b.url, index: i, label: `img${i + 1}` }))
        .filter((it) => it.label.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];
  const mentionActiveIndex = mentionItems.length ? Math.min(mentionIndex, mentionItems.length - 1) : 0;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          {/* Header — breadcrumb left, close right, thin divider under */}
          <header className={s.head}>
            <Dialog.Title className={s.crumb} aria-label={crumbLabel}>
              {crumb.map((c, i) => (
                <span key={i} className={s.crumbRow}>
                  {i > 0 && <span className={s.sep} aria-hidden="true">/</span>}
                  <span className={i === crumb.length - 1 ? s.crumbNow : s.crumbItem}>{c}</span>
                </span>
              ))}
            </Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </header>

          {/* Body — image stage + info rail */}
          <div className={s.body}>
            <div className={s.stage}>
              {drawerRel ? (
                <img
                  className={s.stageImg}
                  src={api.imgUrl(drawerRel)}
                  alt={crumbLabel || drawerRel}
                  decoding="async"
                  onClick={copyImage}
                  title="Click to copy image to clipboard"
                  role="button"
                />
              ) : (
                <div className={s.stageEmpty}>
                  <Icon name="photo" size={24} />
                  <span>No image found.</span>
                </div>
              )}

              {order.length > 1 && drawerRel && (
                <>
                  <button
                    type="button"
                    className={`${s.navBtn} ${s.navPrev}`}
                    onClick={() => go(-1)}
                    aria-label="Previous image"
                    title="Previous (←)"
                  >
                    <Icon name="chevron-right" size={20} />
                  </button>
                  <button
                    type="button"
                    className={`${s.navBtn} ${s.navNext}`}
                    onClick={() => go(1)}
                    aria-label="Next image"
                    title="Next (→)"
                  >
                    <Icon name="chevron-right" size={20} />
                  </button>
                  <span className={s.position}>
                    {Math.max(0, order.indexOf(drawerRel)) + 1} / {order.length}
                  </span>
                </>
              )}

              {copied && <span className={s.copied}>Copied to clipboard</span>}
            </div>

            <aside className={s.rail}>
              <div className={s.railScroll}>
                {refList.length > 0 ? (
                  <section className={s.section}>
                    <div className={s.sectionHead}>
                      <span className={s.label}>References</span>
                    </div>
                    {refList.map((ref) => (
                      <div key={`${ref.role}-${ref.url}`} className={s.refCard}>
                        <div className={s.refThumb}>
                          <img src={ref.url} alt={ref.name} decoding="async" />
                        </div>
                        <div className={s.refMeta}>
                          <span className={s.refName}>{ref.name}</span>
                          <span className={s.refSub}>{ref.role}</span>
                        </div>
                      </div>
                    ))}
                  </section>
                ) : null}

                <section className={s.section}>
                  <div className={s.sectionHead}>
                    <span className={s.label}>Prompt</span>
                  </div>
                  {promptLoading ? (
                    <div className={`${s.promptBox} ${s.promptLoading}`} aria-busy="true">
                      <span className={s.skel} /><span className={s.skel} /><span className={`${s.skel} ${s.skelShort}`} />
                    </div>
                  ) : promptText ? (
                    <div className={s.promptBox}>{promptText}</div>
                  ) : (
                    <div className={`${s.promptBox} ${s.promptEmpty}`}>No prompt text for this slot.</div>
                  )}
                </section>

                <section className={s.section}>
                  <div className={s.sectionHead}>
                    <span className={s.label}>Revise</span>
                    <span className={s.sectionHint}>queues a new version</span>
                  </div>

                  {/* Reference board — the original image is always used; add more to steer the revision. */}
                  <div className={s.board}>
                    {drawerRel && (
                      <div className={`${s.boardThumb} ${s.boardOriginal}`} title="The original image — always used as a reference">
                        <img src={api.imgUrl(drawerRel, 120)} alt="Original" decoding="async" />
                        <span className={s.boardTag}>Original</span>
                      </div>
                    )}
                    {boardRefs.map((b, i) => (
                      <div key={b.id} className={s.boardThumb} title={`@img${i + 1} — mention it in the instruction below`}>
                        <img src={b.url} alt={`Reference @img${i + 1}`} decoding="async" />
                        <span className={s.boardIndexTag}>{`@img${i + 1}`}</span>
                        <button
                          type="button"
                          className={s.boardRemove}
                          onClick={() => setBoardRefs((prev) => prev.filter((x) => x.id !== b.id))}
                          aria-label="Remove reference"
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className={s.boardAdd}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      title="Add a reference image"
                    >
                      <Icon name={uploading ? 'loader' : 'plus'} size={16} />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => addRefs(e.target.files)}
                    />
                  </div>

                  <div className={s.reviseInputWrap}>
                    <textarea
                      ref={textareaRef}
                      className={s.reviseInput}
                      value={instruction}
                      onChange={(e) => { setInstruction(e.target.value); updateMentionState(e.target); }}
                      onSelect={(e) => updateMentionState(e.currentTarget)}
                      onPaste={async (e) => {
                        const items = e.clipboardData?.items;
                        if (!items || !items.length) return; // nothing on the clipboard — let it paste normally
                        const imageItem = Array.from(items).find(
                          (it) => it.kind === 'file' && it.type.startsWith('image/'),
                        );
                        if (!imageItem) return; // plain text only — let the browser paste it as usual
                        e.preventDefault();
                        const file = imageItem.getAsFile();
                        if (!file) return;
                        setUploading(true);
                        await uploadBoardFile(file);
                        setUploading(false);
                      }}
                      onKeyDown={(e) => {
                        if (mentionQuery !== null) {
                          if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
                          if (mentionItems.length) {
                            if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionItems.length - 1)); return; }
                            if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
                            if (e.key === 'Enter' || e.key === 'Tab') {
                              e.preventDefault();
                              insertMention(mentionItems[mentionActiveIndex].index);
                              return;
                            }
                          }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doRevise(); }
                      }}
                      placeholder="What should change? e.g. brighter lighting, show the tube label — paste an image or type @ to mention one"
                      disabled={revising}
                      autoComplete="off"
                      rows={3}
                    />
                    {mentionQuery !== null && mentionItems.length > 0 && (
                      <div
                        ref={mentionRef}
                        className={s.mentionDropdown}
                        style={{ top: mentionPos.top, left: mentionPos.left }}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {mentionItems.map((it, i) => (
                          <button
                            key={it.id}
                            type="button"
                            className={s.mentionItem}
                            data-active={i === mentionActiveIndex ? 'true' : undefined}
                            onMouseEnter={() => setMentionIndex(i)}
                            onClick={() => insertMention(it.index)}
                          >
                            <span className={s.mentionThumb}>
                              <img src={it.url} alt="" decoding="async" />
                            </span>
                            <span className={s.mentionLabel}>{`@${it.label}`}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${s.reviseBtn} ${revisedOk ? s.reviseBtnDone : ''}`}
                    onClick={doRevise}
                    disabled={revising || (!revisedOk && !instruction.trim())}
                  >
                    <Icon name={revisedOk ? 'check' : 'sparkles'} size={15} />
                    <span>{revising ? 'Queuing…' : revisedOk ? 'Queued — new version on the way' : 'Revise'}</span>
                  </button>
                  <p className={s.hint} aria-live="polite">
                    {revisedOk ? 'Added to the generation queue.' : ''}
                  </p>
                </section>

                {/* Actions — proper section under Revise */}
                <section className={s.section}>
                  <div className={s.sectionHead}>
                    <span className={s.label}>Actions</span>
                  </div>
                  <div className={s.actionRow}>
                    <a
                      className={s.actBtn}
                      href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                      target="_blank"
                      rel="noreferrer"
                      title="Open original in a new tab"
                    >
                      <Icon name="expand" size={15} />
                      <span>Open</span>
                    </a>
                    <button
                      type="button"
                      className={s.actBtn}
                      onClick={() => drawerRel && api.regenerate(drawerRel)}
                      title="Regenerate this image"
                    >
                      <Icon name="refresh" size={15} />
                      <span>Regenerate</span>
                    </button>
                    <button
                      type="button"
                      className={s.actBtn}
                      onClick={() => drawerRel && slot && api.archive(drawerRel, !isArchived)}
                      disabled={!slot}
                      title={isArchived ? 'Restore from archive' : 'Archive this image'}
                    >
                      <Icon name={isArchived ? 'restore' : 'archive'} size={15} />
                      <span>{isArchived ? 'Restore' : 'Archive'}</span>
                    </button>
                    <a
                      className={`${s.actBtn} ${s.actPrimary}`}
                      href={drawerRel ? api.imgUrl(drawerRel, undefined, downloadName) : undefined}
                      download={downloadName}
                      title="Download image"
                    >
                      <Icon name="download" size={15} />
                      <span>Download</span>
                    </a>
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
