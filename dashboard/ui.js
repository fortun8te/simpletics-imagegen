// ui.js — PURE rendering from data passed in. Classic script (no module syntax).
// Does NOT fetch; that is app.js's job. It MAY call window.DASH.api.imgUrl(relPath)
// to build image src URLs. One global namespace: window.DASH.
window.DASH = window.DASH || {};

(function () {
  'use strict';

  // --- helpers ---------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : (dflt || 0);
  }

  // Prettify a codex shot id like "AD-ART-04_b2_A_p1_r1" → "b2 AD-ART-04/A".
  // Tolerant: pulls an ad token, a batch token (bN), and a variation token.
  function prettyShot(current) {
    if (!current) return '';
    var raw = String(current);
    // Strip any path / extension noise.
    var base = raw.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    var parts = base.split('_');
    if (parts.length < 2) return base;

    var ad = parts[0];
    var batch = '';
    var variation = '';

    for (var i = 1; i < parts.length; i++) {
      var p = parts[i];
      if (!batch && /^b\d+$/i.test(p)) { batch = p; continue; }
      // First short alpha(-num) token after the ad that isn't a prompt/run/batch
      // marker is treated as the variation label (e.g. "A", "B2").
      if (!variation && !/^[pr]\d+$/i.test(p) && !/^b\d+$/i.test(p)) {
        variation = p;
      }
    }

    var out = '';
    if (batch) out += batch + ' ';
    out += ad;
    if (variation) out += '/' + variation;
    return out.trim();
  }

  // --- selectors -------------------------------------------------------------

  function populateSelectors(config) {
    var brandSel = $('brandSel');
    var batchSel = $('batchSel');
    if (!brandSel || !batchSel) return;

    var brands = (config && config.brands) || [];

    // (Re)build brand options only if they don't already match, so we don't
    // clobber a user's current selection on every refresh.
    var wantBrandHtml = brands.map(function (b) {
      return '<option value="' + esc(b.id) + '">' + esc(b.name || b.id) + '</option>';
    }).join('');

    if (brandSel.getAttribute('data-built') !== '1' || brandSel.children.length !== brands.length) {
      var prevBrand = brandSel.value;
      brandSel.innerHTML = wantBrandHtml;
      brandSel.setAttribute('data-built', '1');
      // Restore prior selection if still valid.
      if (prevBrand) {
        for (var i = 0; i < brandSel.options.length; i++) {
          if (brandSel.options[i].value === prevBrand) { brandSel.value = prevBrand; break; }
        }
      }
    }

    renderBatchOptions(config);
  }

  // Fill #batchSel to reflect the currently selected brand in #brandSel.
  function renderBatchOptions(config) {
    var brandSel = $('brandSel');
    var batchSel = $('batchSel');
    if (!brandSel || !batchSel) return;

    var brands = (config && config.brands) || [];
    var brandId = brandSel.value;
    var brand = null;
    for (var i = 0; i < brands.length; i++) {
      if (brands[i].id === brandId) { brand = brands[i]; break; }
    }
    if (!brand && brands.length) brand = brands[0];

    var batches = (brand && brand.batches) || [];
    var prevBatch = batchSel.value;

    batchSel.innerHTML = batches.map(function (bt) {
      var code = bt.code != null ? bt.code : bt.id;
      return '<option value="' + esc(code) + '">' + esc(bt.name || code) + '</option>';
    }).join('');

    if (prevBatch) {
      for (var j = 0; j < batchSel.options.length; j++) {
        if (batchSel.options[j].value === prevBatch) { batchSel.value = prevBatch; break; }
      }
    }
  }

  // --- activity --------------------------------------------------------------

  function renderActivity(state) {
    var el = $('activity');
    if (!el) return;

    state = state || {};
    var cp = state.codexProgress || null;
    var queue = state.queue || null;
    var running = !!(state.runner && state.runner.alive);

    var html = '';

    // Codex lane ------------------------------------------------------------
    var total = cp ? num(cp.total, 0) : 0;
    var done = cp ? num(cp.done, 0) : 0;
    var skipped = cp ? num(cp.skipped, 0) : 0;
    var failed = cp ? num(cp.failed, 0) : 0;
    var completed = done + skipped;
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;

    var hasFresh = !!cp && total > 0;
    var laneState;
    if (hasFresh && failed > 0) laneState = 'error';
    else if (hasFresh && completed >= total) laneState = 'done';
    else if (hasFresh) laneState = 'active';
    else laneState = 'idle';

    var laneClasses = 'lane lane-' + laneState;

    html += '<div class="' + laneClasses + '">';
    html += '<span class="lane-dot lane-dot-' + laneState + '"></span>';
    html += '<div class="lane-body">';
    html += '<div class="lane-head">';
    html += '<span class="lane-label">Codex · separate quota</span>';

    if (hasFresh) {
      html += '<span class="lane-count">' + esc(completed) + '/' + esc(total) + '</span>';
    } else {
      html += '<span class="lane-count">' + (running ? 'starting…' : 'idle') + '</span>';
    }
    html += '</div>'; // lane-head

    // Mini progress bar
    html += '<div class="lane-bar"><div class="lane-bar-fill" style="width:' + (hasFresh ? pct : 0) + '%"></div></div>';

    // Current shot + failures
    var sub = '';
    if (hasFresh) {
      var shot = prettyShot(cp.current);
      if (shot) sub += esc(shot);
      if (failed > 0) {
        if (sub) sub += ' · ';
        sub += '<span class="lane-failed">' + esc(failed) + ' failed</span>';
      }
      if (!shot && !failed) sub = (completed >= total) ? 'complete' : 'working…';
    } else {
      sub = running ? 'runner starting…' : 'runner stopped';
    }
    html += '<div class="lane-sub">' + sub + '</div>';

    html += '</div>'; // lane-body
    html += '</div>'; // lane

    // Queue summary line ----------------------------------------------------
    if (queue) {
      var pending = num(queue.pending, 0);
      var qrunning = num(queue.running, 0);
      var qdone = num(queue.done, 0);
      var qtotal = num(queue.total, 0);
      if (pending > 0 || qrunning > 0 || qtotal > 0) {
        var bits = [];
        if (qrunning > 0) bits.push(esc(qrunning) + ' running');
        if (pending > 0) bits.push(esc(pending) + ' pending');
        if (qdone > 0 && qtotal > 0) bits.push(esc(qdone) + '/' + esc(qtotal) + ' done');
        if (bits.length) {
          html += '<div class="queue-summary">Queue: ' + bits.join(' · ') + '</div>';
        }
      }
    }

    el.innerHTML = html;
  }

  // --- grid ------------------------------------------------------------------

  // Signature of the grid-relevant data. The poll loop calls renderGrid every ~1.5s; rebuilding the
  // innerHTML each time recreates every <img> and aborts its in-flight load, so images (multi-MB
  // local PNGs) never finish painting. We only rebuild when this signature changes.
  var lastGridSig = null;
  function gridSignature(ads) {
    var s = [];
    for (var a = 0; a < ads.length; a++) {
      var ad = ads[a] || {};
      var vs = ad.variations || [];
      for (var v = 0; v < vs.length; v++) {
        var ps = (vs[v] || {}).prompts || [];
        for (var p = 0; p < ps.length; p++) {
          var rs = (ps[p] || {}).runs || [];
          for (var r = 0; r < rs.length; r++) s.push((rs[r].relPath || '') + ':' + (rs[r].version || ''));
        }
      }
    }
    return (ads.map(function (x) { return x.id; }).join('|')) + '#' + s.join(',');
  }

  function renderGrid(state, onOpen) {
    var el = $('grid');
    if (!el) return;

    state = state || {};
    var ads = state.ads || [];

    // Skip the rebuild when nothing changed, so loaded <img>s are not torn down every poll.
    var sig = gridSignature(ads);
    if (sig === lastGridSig && el.children.length) return;
    lastGridSig = sig;

    if (!ads.length) {
      el.innerHTML = '<div class="grid-empty">No renders yet.</div>';
      return;
    }

    var api = window.DASH && window.DASH.api;
    var parts = [];

    for (var a = 0; a < ads.length; a++) {
      var ad = ads[a] || {};
      var adTitle = ad.title || ad.id || 'Ad';

      var adHtml = '<div class="ad">';
      adHtml += '<div class="ad-title">' + esc(adTitle);
      if (ad.type) adHtml += ' <span class="ad-type">' + esc(ad.type) + '</span>';
      adHtml += '</div>';

      var variations = ad.variations || [];
      for (var v = 0; v < variations.length; v++) {
        var varn = variations[v] || {};
        var varLabel = varn.label || varn.id || '';

        adHtml += '<div class="variation">';
        if (varLabel) {
          adHtml += '<div class="variation-label">' + esc(varn.id || '') +
            (varn.label ? ' — ' + esc(varn.label) : '') + '</div>';
        }
        adHtml += '<div class="tiles">';

        var prompts = varn.prompts || [];
        for (var pr = 0; pr < prompts.length; pr++) {
          var prompt = prompts[pr] || {};
          var runs = (prompt.runs || []).slice();

          // Newest version first.
          runs.sort(function (x, y) {
            return num(y.version, 0) - num(x.version, 0);
          });

          for (var r = 0; r < runs.length; r++) {
            var run = runs[r] || {};
            if (!run.relPath) continue;
            var src = api && api.imgUrl ? api.imgUrl(run.relPath) : run.relPath;
            var ver = num(run.version, 1);

            adHtml += '<div class="tile" data-rel="' + esc(run.relPath) + '">';
            adHtml += '<img decoding="async" src="' + esc(src) +
              '" alt="' + esc(adTitle + ' ' + (varn.id || '') + ' v' + ver) + '">';
            adHtml += '<span class="badge">v' + esc(ver) + '</span>';
            adHtml += '</div>';
          }
        }

        adHtml += '</div>'; // tiles
        adHtml += '</div>'; // variation
      }

      adHtml += '</div>'; // ad
      parts.push(adHtml);
    }

    el.innerHTML = parts.join('');

    // Wire tile clicks → onOpen(relPath). One delegated listener.
    if (typeof onOpen === 'function') {
      el.onclick = function (ev) {
        var t = ev.target;
        while (t && t !== el && !(t.classList && t.classList.contains('tile'))) {
          t = t.parentNode;
        }
        if (t && t !== el && t.classList && t.classList.contains('tile')) {
          var rel = t.getAttribute('data-rel');
          if (rel) onOpen(rel);
        }
      };
    } else {
      el.onclick = null;
    }
  }

  // --- runner state ----------------------------------------------------------

  function setRunnerState(alive) {
    var stateEl = $('runnerState');
    var runBtn = $('runBtn');
    var stopBtn = $('stopBtn');

    var isAlive = !!alive;

    if (stateEl) {
      stateEl.textContent = isAlive ? 'Codex running' : 'Codex idle';
      stateEl.className = 'runner-state' + (isAlive ? ' is-running' : ' is-idle');
    }
    if (runBtn) runBtn.disabled = isAlive;
    if (stopBtn) stopBtn.disabled = !isAlive;
  }

  // --- lightbox --------------------------------------------------------------

  function openLightbox(relPath) {
    var box = $('lightbox');
    if (!box) return;

    var api = window.DASH && window.DASH.api;
    var src = api && api.imgUrl ? api.imgUrl(relPath) : relPath;

    box.innerHTML = '<img class="lightbox-img" src="' + esc(src) + '" alt="">';
    box.hidden = false;
    box.classList.add('is-open');

    // Clicking the backdrop (not the image) closes it.
    box.onclick = function (ev) {
      if (ev.target === box) closeLightbox();
    };
  }

  function closeLightbox() {
    var box = $('lightbox');
    if (!box) return;
    box.hidden = true;
    box.classList.remove('is-open');
    box.innerHTML = '';
    box.onclick = null;
  }

  // --- bridge state ----------------------------------------------------------

  function setBridgeState(health) {
    var el = $('bridgeState');
    if (!el) return;

    health = health || {};
    var bridge = !!health.bridge;
    var runner = !!health.runner;

    var cls, text;
    if (bridge) {
      cls = 'bridge-ok';
      text = 'Bridge connected' + (runner ? ' · runner alive' : '');
    } else {
      cls = 'bridge-err';
      text = 'Bridge offline';
    }

    el.textContent = text;
    el.className = 'bridge-state ' + cls;
  }

  // ------------------------------------------------------------------- Codex Usage Panel
  // Renders a live panel showing per-model tokens used vs limit, weekly progress bars,
  // the active backend indicator (Codex/ChatGPT), and a fallback status banner.

  function renderCodexUsage(data) {
    var el = $('codexUsagePanel');
    if (!el) return;

    data = data || {};
    var overall = data.overall || {};
    var models = Array.isArray(data.models) ? data.models : [];
    var backendInfo = data.backendIndicator || null;
    var fallbackBanner = data.fallbackStatus || null;
    var updatedAt = (overall && overall.updatedAt) || new Date().toISOString();

    // Backend indicator.
    var backendCls, backendText;
    if (backendInfo === true || backendInfo === 'codex') {
      backendCls = 'codex-active';
      backendText = 'Using: Codex';
    } else if (backendInfo === false || backendInfo === 'chatgpt') {
      backendCls = 'chatgpt-active';
      backendText = 'Using: ChatGPT';
    } else if (backendInfo === null) {
      backendCls = 'offline';
      backendText = 'Backend: unknown';
    } else {
      backendCls = 'chatgpt-active';
      backendText = 'Using: ChatGPT';
    }

    // Fallback banner.
    var bannerHtml = '';
    if (fallbackBanner && fallbackBanner.fallback) {
      bannerHtml = '<div class="fallback-banner is-visible">' +
        '<strong>Fallback active</strong> — Codex exhausted (' + esc(fallbackBanner.percentage || '?') + '%). ' +
        'Switched to ChatGPT backend. Reset at: ' + (esc(fallbackBanner.resetAt) || 'unknown').replace(/T.*Z$/g, '').replace(/\..+$/, '') + '.' +
      '</div>';
    } else if (!fallbackBanner && !backendInfo) {
      bannerHtml = '<div class="fallback-banner">' + esc(overall.totalUsed || 0) + ' tokens used / ' + (Number(overall.weeklyLimit) || 2_550_000).toLocaleString() + '</div>';
    }

    // Per-model rows.
    var modelRows = '';
    for (var i = 0; i < models.length; i++) {
      var m = models[i] || {};
      var pct = Number(m.percentage) || 0;
      var cls = pct >= 85 ? ' is-high' : (pct > 30 ? ' is-low' : '');

      // Format the reset date.
      var resetAt = m.resetAt || null;
      var resetDisplay = '';
      if (resetAt) {
        try {
          resetDisplay = new Date(resetAt).toLocaleString();
        } catch {}
      }

      modelRows += '<div class="usage-row">';
      modelRows += '<span class="model-name-col">' + esc(m.model || '—') + '</span>';
      modelRows += '<span class="model-info">';
      if (m.used !== undefined && m.limit) {
        var usedStr = Number(m.used).toLocaleString();
        var limitStr = Number(m.limit).toLocaleString();
        modelRows += '<div class="model-usage">' + usedStr + ' / ' + limitStr + '</div>';
      } else if (m.backend === 'gemini') {
        modelRows += '<div class="model-usage">Gemini · quota managed by Google</div>';
      } else {
        modelRows += '<div class="model-usage">' + esc(m.backend || '?') + '</div>';
      }
      modelRows += '<div class="model-progress"><div class="model-bar-fill' + cls + '" style="width:' + (pct >= 100 ? 100 : pct) + '%"></div></div>';
      modelRows += '</span>';
      modelRows += '<span class="model-reset">' + (resetDisplay || '—') + '</span>';
      modelRows += '</div>';
    }

    var html = '';
    html += '<section class="usage-panel">';
    html += '<div class="usage-header">';
    html += '<span class="usage-title"><span class="dot" id="usageDot"></span>Codex Quota</span>';
    html += '<span class="backend-indicator ' + esc(backendCls) + '">' + esc(backendText) + '</span>';
    html += '</div>';

    // Overall bar.
    var overallPct = Number(overall.percentage) || 0;
    var overallCls = overallPct >= 85 ? ' is-high' : '';
    html += '<div class="usage-overall">';
    html += '<span class="overall-label">' + esc((Number(overall.totalUsed) || 0).toLocaleString()) + ' tokens / ' + (Number(overall.weeklyLimit) || 2_550_000).toLocaleString() + '</span>';
    html += '<div class="overall-bar-track"><div class="overall-bar-fill' + overallCls + '" style="width:' + (overallPct >= 100 ? 100 : overallPct) + '%"></div></div>';
    html += '<span class="pct">' + (Number(overall.percentage) || 0).toFixed(1) + '%</span>';
    html += '</div>';

    if (modelRows) {
      for (var j = 0; j < models.length; j++) {
        var m2 = models[j] || {};
        var rowPct = Number(m2.percentage) || 0;
        var rowCls = rowPct >= 85 ? ' is-high' : (rowPct > 30 ? ' is-low' : '');
        html += '<div class="usage-row">';
        html += '<span class="model-name-col">' + esc(m2.model || '—') + '</span>';
        html += '<span class="model-info">';
        if (m2.used !== undefined && m2.limit) {
          var usedStr = Number(m2.used).toLocaleString();
          var limitStr = Number(m2.limit).toLocaleString();
          html += '<div class="model-usage">' + usedStr + ' / ' + limitStr + '</div>';
        } else if (m2.backend === 'gemini') {
          html += '<div class="model-usage">Gemini · quota managed by Google</div>';
        } else {
          html += '<div class="model-usage">' + esc(m2.backend || '?') + '</div>';
        }
        html += '<div class="model-progress"><div class="model-bar-fill' + rowCls + '" style="width:' + (rowPct >= 100 ? 100 : rowPct) + '%"></div></div>';
        html += '</span>';
        var resetDisplay = m2.resetAt ? new Date(m2.resetAt).toLocaleString() : '—';
        html += '<span class="model-reset">' + esc(resetDisplay) + '</span>';
        html += '</div>';
      }
    }

    if (bannerHtml) {
      html += bannerHtml;
    } else {
      var usageText = overall.totalUsed ? (Number(overall.totalUsed).toLocaleString() + ' tokens / ' + (Number(overall.weeklyLimit) || 2_550_000).toLocaleString()) : 'No data';
      html += '<div class="fallback-banner">' + esc(usageText) + '</div>';
    }

    if (!backendInfo && !fallbackBanner) {
      var now = new Date(updatedAt);
      html += '<div style="padding:8px 15px;font-size:10px;color:var(--faint)">Updated ' + now.toLocaleTimeString() + '</div>';
    }

    // Dot indicator — reflects overall health.
    var dotEl = $('usageDot');
    if (dotEl) {
      if (backendInfo === true || backendInfo === 'codex') dotEl.className = 'dot is-healthy';
      else if (backendCls === 'chatgpt-active' && !fallbackBanner) dotEl.className = 'dot is-warning';
      else dotEl.className = 'dot is-exhausted';
    }

    el.innerHTML = html;
  }

  // ------------------------------------------------------------------- export

  window.DASH.ui = {
    populateSelectors: populateSelectors,
    renderActivity: renderActivity,
    renderGrid: renderGrid,
    setRunnerState: setRunnerState,
    openLightbox: openLightbox,
    closeLightbox: closeLightbox,
    setBridgeState: setBridgeState,
    renderCodexUsage: renderCodexUsage
  };
})();
