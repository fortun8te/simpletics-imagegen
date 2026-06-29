// app.js — bootstrap + the ONLY polling loop.
// Classic script (no module syntax). Assumes api.js and ui.js already loaded.
// One global namespace: window.DASH.
(function () {
  'use strict';

  var config = null;

  // Read the current selection straight off the live DOM.
  function readSelection() {
    var brandSel = document.getElementById('brandSel');
    var batchSel = document.getElementById('batchSel');
    var variantEl = document.getElementById('variantCount');
    var variants = parseInt(variantEl && variantEl.value, 10);
    if (!(variants >= 1)) { variants = 1; }
    return {
      brand: brandSel ? brandSel.value : '',
      batch: batchSel ? batchSel.value : '',
      variants: variants
    };
  }

  // ---- Main state poll (every 1500ms) -------------------------------------
  var stateInFlight = false;

  function pollState() {
    if (stateInFlight) { return Promise.resolve(); }
    stateInFlight = true;
    var sel = readSelection();
    return window.DASH.api.getState(sel.brand, sel.batch)
      .then(function (state) {
        window.DASH.ui.renderActivity(state);
        window.DASH.ui.renderGrid(state, window.DASH.ui.openLightbox);
        window.DASH.ui.setRunnerState(state && state.runner && state.runner.alive);
      })
      .catch(function (err) { console.error('[app] state poll failed', err); })
      .then(function () { stateInFlight = false; });
  }

  // Trigger an immediate refresh outside the regular cadence.
  function refresh() { return pollState(); }

  // ---- Codex log poll (every 3s) ------------------------------------------
  var logInFlight = false;

  function pollLog() {
    if (logInFlight) { return; }
    logInFlight = true;
    window.DASH.api.getLog()
      .then(function (text) {
        var logEl = document.getElementById('log');
        if (logEl) { logEl.textContent = text || ''; }
      })
      .catch(function (err) { console.error('[app] log poll failed', err); })
      .then(function () { logInFlight = false; });
  }

  // ---- Health poll (every 4s) ---------------------------------------------
  var healthInFlight = false;

  function pollHealth() {
    if (healthInFlight) { return; }
    healthInFlight = true;
    window.DASH.api.getHealth()
      .then(function (health) {
        window.DASH.ui.setBridgeState(health);
      })
      .catch(function (err) { console.error('[app] health poll failed', err); })
      .then(function () { healthInFlight = false; });
  }

  // ---- Wiring -------------------------------------------------------------
  function wire() {
    var brandSel = document.getElementById('brandSel');
    var batchSel = document.getElementById('batchSel');
    var runBtn = document.getElementById('runBtn');
    var stopBtn = document.getElementById('stopBtn');

    if (brandSel) {
      brandSel.addEventListener('change', function () {
        // Re-render the batch options for the newly selected brand, then refresh.
        try { window.DASH.ui.populateSelectors(config); }
        catch (err) { console.error('[app] populateSelectors failed', err); }
        refresh();
      });
    }

    if (batchSel) {
      batchSel.addEventListener('change', function () {
        refresh();
      });
    }

    if (runBtn) {
      runBtn.addEventListener('click', function () {
        var sel = readSelection();
        window.DASH.api.runCodex(sel.batch, sel.variants)
          .catch(function (err) { console.error('[app] runCodex failed', err); })
          .then(function () { refresh(); });
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        window.DASH.api.stopCodex()
          .catch(function (err) { console.error('[app] stopCodex failed', err); })
          .then(function () { refresh(); });
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        window.DASH.ui.closeLightbox();
      }
    });
  }

  // ---- Bootstrap ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    Promise.resolve()
      .then(function () { return window.DASH.api.getConfig(); })
      .then(function (cfg) {
        config = cfg;
        window.DASH.ui.populateSelectors(config);
      })
      .catch(function (err) { console.error('[app] bootstrap failed', err); })
      .then(function () {
        wire();

        // Kick everything off once, then start the loops.
        pollState();
        pollLog();
        pollHealth();

        setInterval(pollState, 1500);
        setInterval(pollLog, 3000);
        setInterval(pollHealth, 4000);
      });
  });
})();
