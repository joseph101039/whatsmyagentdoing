'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// watcher.js resolves its directories at require time.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-bg-'));
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, 'claude');
process.env.CODEX_HOME = path.join(BASE, 'codex');
process.env.GEMINI_CLI_HOME = path.join(BASE, 'gemini');
const { Watcher } = require('../src/watcher');
const { pendingBackground } = require('../src/parsers');
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function log(id, padBytes, { resultInTail = false } = {}) {
  const now = Date.now();
  const ts = (ago) => new Date(now - ago).toISOString();
  const lines = [
    { type: 'user', timestamp: ts(60_000), cwd: '/p/demo', sessionId: id, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: ts(59_000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }] } },
  ];
  const result = { type: 'user', timestamp: ts(2000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'running' }] }, toolUseResult: { backgroundTaskId: 'bhead' } };
  if (!resultInTail) lines.push(result);
  // filler the size of the skipped middle, where the task's completion would be
  const filler = { type: 'progress', timestamp: ts(30_000), data: 'x'.repeat(1000) };
  for (let n = 0; n < padBytes; n += 1100) lines.push(filler);
  if (resultInTail) lines.push(result);
  lines.push({ type: 'assistant', timestamp: ts(1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } });
  const file = path.join(BASE, 'claude', 'projects', '-p-demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('a task seen only in the head of a big log is not counted', () => {
  log('small', 0);
  log('big', 1024 * 1024);
  log('split', 1024 * 1024, { resultInTail: true });
  const w = new Watcher({ hours: 24 });
  w.tick();
  const by = Object.fromEntries(w.sessions().map((s) => [s.id, s]));
  assert.equal(pendingBackground(by.small), 1);
  assert.equal(pendingBackground(by.big), 0);
  assert.equal(by.big.cwd, '/p/demo');
  // a call in the head whose result (a timed-out command) lands in the tail
  assert.equal(pendingBackground(by.split), 1);
});
