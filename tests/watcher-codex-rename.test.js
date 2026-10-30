'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// watcher.js resolves its directories at require time.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-rename-'));
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, 'claude');
process.env.CODEX_HOME = path.join(BASE, 'codex');
process.env.GEMINI_CLI_HOME = path.join(BASE, 'gemini');
const { Watcher } = require('../src/watcher');
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const INDEX = path.join(BASE, 'codex', 'session_index.jsonl');

function rename(id, name, at) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.appendFileSync(INDEX, JSON.stringify({ id, thread_name: name, updated_at: new Date(at).toISOString() }) + '\n');
  // the watcher re-reads the index only when its mtime moves
  fs.utimesSync(INDEX, new Date(at), new Date(at));
}

test('a renamed codex session shows its latest name', () => {
  const id = '01a185c7-9657-7472-b346-4cdd7651fd5a';
  const now = new Date();
  const dir = path.join(BASE, 'codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-10-29T00-00-00-${id}.jsonl`),
    JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id, cwd: '/p/codex' } }) + '\n');

  const title = (w) => w.sessions().find((s) => s.id === id).title;
  rename(id, 'first name', Date.now() - 2000);
  const w = new Watcher({ hours: 24 });
  w.tick();
  assert.equal(title(w), 'first name');
  rename(id, 'second name', Date.now() - 1000);
  w.tick();
  assert.equal(title(w), 'second name');
});
