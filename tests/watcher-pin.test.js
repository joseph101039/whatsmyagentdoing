'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// watcher.js resolves its directories at require time.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-pin-'));
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, 'claude');
process.env.CODEX_HOME = path.join(BASE, 'codex');
process.env.GEMINI_CLI_HOME = path.join(BASE, 'gemini');
const { Watcher } = require('../src/watcher');
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const DAY = 86400000;

function write(file, lines, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

function claudeLog(id, ageMs) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  write(path.join(BASE, 'claude', 'projects', '-p-demo', `${id}.jsonl`), [
    { type: 'user', timestamp: ts, cwd: '/p/demo', sessionId: id, message: { role: 'user', content: 'hello' } },
  ], ageMs);
}

const ids = (w) => w.sessions().map((s) => `${s.agent}:${s.id}`).sort();

test('pinned file outside window is tracked', () => {
  claudeLog('old-claude', 3 * DAY);
  const w = new Watcher({ hours: 24 });
  w.tick();
  assert.deepEqual(ids(w).filter((k) => k === 'claude:old-claude'), []);
  w.setPinned([{ agent: 'claude', id: 'old-claude' }]);
  w.tick();
  assert.ok(ids(w).includes('claude:old-claude'));
  // and it isn't evicted for being old
  w.tick();
  assert.ok(ids(w).includes('claude:old-claude'));
});

test('codex pinned found by full walk', () => {
  const id = '01a1724d-40e3-7163-92b5-dc154d92ceef';
  const d = new Date(Date.now() - 10 * DAY);
  const dir = path.join(BASE, 'codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  write(path.join(dir, `rollout-2026-10-15T00-00-00-${id}.jsonl`), [
    { timestamp: d.toISOString(), type: 'session_meta', payload: { id, cwd: '/p/codex' } },
  ], 10 * DAY);
  const w = new Watcher({ hours: 24 });
  w.tick();
  assert.ok(!ids(w).includes(`codex:${id}`));
  w.setPinned([{ agent: 'codex', id }, { agent: 'codex', id: 'not-anywhere' }]);
  w.tick();
  assert.ok(ids(w).includes(`codex:${id}`));
  const miss = w.codexMiss.get('not-anywhere');
  assert.ok(miss.until > Date.now() && miss.delay === 60000);
  // unpinning forgets the id and its cached path
  w.setPinned([{ agent: 'codex', id }]);
  assert.ok(!w.codexMiss.has('not-anywhere'));
});

test('codex full walk runs at most once a minute and backs off', () => {
  const w = new Watcher({ hours: 24 });
  w.setPinned([{ agent: 'codex', id: 'ghost' }]);
  w.findPinnedCodex(1_000_000);
  const first = w.codexMiss.get('ghost');
  w.codexMiss.set('ghost', { ...first, until: 0 }); // due again, but the walk was just done
  w.findPinnedCodex(1_000_000 + 1000);
  assert.equal(w.codexMiss.get('ghost').delay, 60000);
  w.findPinnedCodex(1_000_000 + 61000);
  assert.equal(w.codexMiss.get('ghost').delay, 120000);
  // past 16 minutes of backoff it is given up on
  w.codexMiss.set('ghost', { until: 0, delay: 16 * 60000 });
  w.findPinnedCodex(1_000_000 + 200000);
  assert.equal(w.codexMiss.get('ghost').until, Infinity);
});

test('unpinned old file is evicted', () => {
  claudeLog('evict-me', 3 * DAY);
  const w = new Watcher({ hours: 24 });
  w.setPinned([{ agent: 'claude', id: 'evict-me' }]);
  w.tick();
  assert.ok(ids(w).includes('claude:evict-me'));
  w.setPinned([]);
  w.tick();
  assert.ok(!ids(w).includes('claude:evict-me'));
});
