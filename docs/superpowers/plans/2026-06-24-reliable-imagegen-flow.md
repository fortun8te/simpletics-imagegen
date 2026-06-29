# Reliable ImageGen Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ImageGen create or select the requested ChatGPT project before work begins, capture only finished generated images, place every file and preview in its correct slot, and provide dependable retry/reset controls.

**Architecture:** Keep a durable panel-side record for every model and final-image run. Give each run a unique key and relative download path, so the background worker, ChatGPT content script, bridge, panel preview, retry, and reset actions all refer to the same item. The content script will use the current conversation rather than the first sidebar chat, and it will only capture images exposed as ChatGPT-generated output.

**Tech Stack:** Manifest V3 Chrome extension, browser DOM APIs, Chrome storage/downloads, Node built-in test runner.

---

### Task 1: Add testable job identity and path rules

**Files:**
- Create: `logic.js`
- Create: `tests/logic.test.js`
- Modify: `manifest.json`
- Modify: `sidepanel.html`
- Modify: `background.js`
- Modify: `sidepanel.js`

- [ ] Write failing tests for stable model and final-image keys, two runs per prompt, and brand/batch/ad folder paths.
- [ ] Run `node --test tests/logic.test.js` and confirm the missing logic module fails.
- [ ] Implement `ImageGenLogic` helpers which build job keys, filenames, and `brand/batch/models/...` or `brand/batch/ads/...` relative paths.
- [ ] Load the helper in the extension surfaces and use it for every job instead of an ad-only filename.
- [ ] Run `node --test tests/logic.test.js` and confirm it passes.

### Task 2: Make project setup and chat filing real

**Files:**
- Create: `tests/project-flow.test.js`
- Modify: `content.js`
- Modify: `background.js`

- [ ] Write failing tests for waiting on an enabled create button and choosing a sidebar entry matching the active conversation path.
- [ ] Run `node --test tests/project-flow.test.js` and confirm the missing project helpers fail.
- [ ] Add content-script helpers to find or create the named project, verify it appears, wait for the composer after navigation, and target the active chat rather than the first recent chat.
- [ ] Make the background worker prepare the project before it dispatches the first generation and return to ChatGPT before a job starts.
- [ ] Run the project-flow tests and confirm they pass.

### Task 3: Capture finished output only

**Files:**
- Create: `tests/output-capture.test.js`
- Modify: `content.js`

- [ ] Write failing tests for filtering an uploaded-reference image out of a page containing both a reference and a generated image.
- [ ] Run `node --test tests/output-capture.test.js` and confirm it fails because the output matcher does not exist.
- [ ] Capture only fresh images inside ChatGPT's generated-image control, wait for a stable final URL, and preserve the newly created chat path for filing.
- [ ] Run the output-capture test and confirm it passes.

### Task 4: Persist slot state and make reset/retry usable

**Files:**
- Create: `tests/panel-state.test.js`
- Modify: `logic.js`
- Modify: `sidepanel.js`
- Modify: `sidepanel.html`

- [ ] Write failing tests for resetting one model and clearing final runs that depend on it without deleting unrelated slots.
- [ ] Run `node --test tests/panel-state.test.js` and confirm it fails because the reset helper is missing.
- [ ] Persist model/run states in local extension storage; restore thumbnails and statuses after a panel rerender; add one-model retry plus reset actions for a model, a variation, and the current batch.
- [ ] Render two prompt groups per A/B/C variation, with two independently tracked runs in each group.
- [ ] Run the panel-state test and confirm it passes.

### Task 5: Improve the side-panel review experience

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`

- [ ] Replace the unlabeled top selectors with clear brand and batch controls, and show the exact destination for the selected work.
- [ ] Turn reference, model, and final-result thumbnails into an expanded preview with a close action.
- [ ] Give each slot a readable current state and a small, direct action instead of relying on a whole-ad re-run.
- [ ] Manually inspect the loaded side panel after reloading the extension.

### Task 6: Verify the shipped extension

**Files:**
- Modify: `README.md`

- [ ] Run all Node tests with `node --test tests/*.test.js`.
- [ ] Verify JavaScript syntax with `node --check background.js`, `node --check content.js`, `node --check sidepanel.js`, and `node --check logic.js`.
- [ ] Reload the unpacked extension and verify project-first startup, a reference thumbnail expansion, a model reset, and generated-output detection against the live ChatGPT DOM without submitting a new image request.
- [ ] Update the README to describe the folder layout and reset behavior.

**Note:** This folder is not a Git repository, so there is no safe commit step to perform.
