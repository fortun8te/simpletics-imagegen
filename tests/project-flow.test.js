const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../logic.js');

test('a project is only ready to submit after its create button is enabled', () => {
  assert.equal(Logic.canSubmitProject({ disabled: true }), false);
  assert.equal(Logic.canSubmitProject({ disabled: false }), true);
});

test('the active conversation matcher uses the current chat path', () => {
  assert.equal(Logic.conversationHrefMatch('/c/current-chat', '/c/current-chat?messageId=abc'), true);
  assert.equal(Logic.conversationHrefMatch('/c/current-chat', '/c/older-chat'), false);
});

test('page-port errors are retried while ChatGPT changes pages', () => {
  assert.equal(Logic.isTransientPortError('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'), true);
  assert.equal(Logic.isTransientPortError('Could not establish connection. Receiving end does not exist.'), true);
  assert.equal(Logic.isTransientPortError('the project name was not accepted'), false);
});

test('a route is only ready after the destination pathname matches', () => {
  assert.equal(Logic.sameRoute('https://chatgpt.com/projects?tab=all', 'https://chatgpt.com/projects'), true);
  assert.equal(Logic.sameRoute('https://chatgpt.com/', 'https://chatgpt.com/projects'), false);
});

test('a project page can confirm its name from the project composer label', () => {
  assert.equal(Logic.projectNameFromComposerLabel('New chat in Simpletics · Batch 1'), 'Simpletics · Batch 1');
  assert.equal(Logic.projectNameFromComposerLabel('New chat'), null);
  assert.equal(Logic.projectNameMatches(' Simpletics · Batch 1 ', 'Simpletics · Batch 1'), true);
});
