# Telegram Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Telegram observe and control the ImageGen bridge queue.

**Architecture:** The bridge remains the queue owner. A small Telegram polling helper converts approved chat commands into bridge commands and sends milestone summaries back through the existing notification setup.

**Tech Stack:** Node.js built-ins, Telegram Bot API, existing local bridge.

---

### Task 1: Command parsing

**Files:**
- Create: `telegram-control.mjs`
- Create: `tests/telegram-control.test.js`

- [ ] Write failing tests for `/status`, `/pause`, `/resume`, `/skip`, `/retry`, and `/runs` parsing.
- [ ] Implement pure command parsing with a 1–10 run limit.
- [ ] Run `node --test tests/telegram-control.test.js`.

### Task 2: Bridge controls

**Files:**
- Modify: `bridge.mjs`

- [ ] Add pause, resume, skip, retry, and run-count commands to the local bridge.
- [ ] Return a compact queue snapshot to Telegram and the side panel.
- [ ] Run the complete test suite.

### Task 3: Bot relay

**Files:**
- Modify: `telegram-control.mjs`
- Modify: `bridge.mjs`

- [ ] Poll Telegram only when the existing bot token and approved chat id are configured.
- [ ] Reject every other chat without exposing queue data.
- [ ] Send milestone messages, not per-image spam.
