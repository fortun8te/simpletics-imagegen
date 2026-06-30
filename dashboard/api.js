// api.js — thin fetch wrappers, all same-origin (page served from :8788).
// Classic script (no module syntax). One global namespace: window.DASH.
window.DASH = window.DASH || {};

(function () {
  'use strict';

  function getConfig() {
    return fetch('/api/config')
      .then(function (r) { return r.json(); })
      .catch(function () { return { brands: [] }; });
  }

  function getState(brand, batch) {
    var url = '/api/state?brand=' + encodeURIComponent(brand == null ? '' : brand) +
      '&batch=' + encodeURIComponent(batch == null ? '' : batch);
    return fetch(url)
      .then(function (r) { return r.json(); })
      .catch(function () {
        return { ads: [], codexProgress: null, queue: null, runner: { alive: false } };
      });
  }

  function imgUrl(relPath) {
    return '/img?path=' + encodeURIComponent(relPath);
  }

  function getLog() {
    return fetch('/api/codex/log')
      .then(function (r) { return r.text(); })
      .catch(function () { return ''; });
  }

  // Fetch the latest Codex quota status from the tracker.
  function getQuotaUsage() {
    var url = '/api/codex/usage';
    return fetch(url)
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  // Check if Codex is currently healthy enough to use. POST with optional { record: true }.
  function checkFallback() {
    var url = '/api/fallback/check';
    return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:'' })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  // Poll fallback status — the bridge updates this every ~1.5s via /status.
  function getFallbackStatus() {
    var url = '/api/fallback/check';
    return fetch(url, { method:'GET', headers:{'Content-Type':'application/json'} })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  function runCodex(batch, variants) {
    return fetch('/api/codex/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: batch, variants: variants })
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false }; });
  }

  function stopCodex() {
    return fetch('/api/codex/stop', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false }; });
  }

  function getHealth() {
    return fetch('/api/health')
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, bridge: false, runner: false }; });
  }

  window.DASH.api = {
    getConfig: getConfig,
    getState: getState,
    imgUrl: imgUrl,
    getLog: getLog,
    runCodex: runCodex,
    stopCodex: stopCodex,
    getHealth: getHealth,
    getQuotaUsage: getQuotaUsage,
    checkFallback: checkFallback,
    getFallbackStatus: getFallbackStatus
  };
})();
