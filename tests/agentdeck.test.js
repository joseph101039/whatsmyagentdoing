'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FRESH_MS, loadFeed, FeedSource, pluginParents, mergeSessions } = require('../src/agentdeck');
const { newSession } = require('../src/parsers');

const NOW = Date.parse('2026-10-25T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-deck-'));
const tmp = () => fs.mkdtempSync(path.join(BASE, 't-'));
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function row(over = {}) {
  return {
    key: 'claude-c1', provider: 'claude', sessionId: 'c1', state: 'working', event: 'UserPromptSubmit',
    updatedAt: iso(NOW - 1000), projectPath: '/p/demo', agentPid: 123, name: null, model: null,
    waitingReason: null, discovered: false, background: false, parentSessionId: null,
    running: true, processStartedAt: iso(NOW - 3600000), sharedProcess: false, ...over,
  };
}
function feed(sessions, over = {}) {
  return { schemaVersion: 1, generatedAt: iso(NOW - 1000), appPid: 999, sessions, ...over };
}
function log(over = {}) {
  return { ...newSession('claude', 'c1', '/x.jsonl'), cwd: '/p/demo', status: 'idle', lastEventAt: NOW - 500, ...over };
}
const one = (logs, rows, parents) => mergeSessions(logs, feed(rows), parents, NOW).find((s) => s.id === (rows[0] || {}).sessionId);

// ---- status mapping, one case per row of the plan's table

test('waiting overrides any log status and keeps the log activity', () => {
  const s = one([log({ status: 'tool', activity: 'Bash: ls' })], [row({ state: 'waiting', waitingReason: 'permission prompt' })]);
  assert.equal(s.status, 'waiting');
  assert.equal(s.activity, 'Bash: ls');
  assert.equal(s.waitingReason, 'permission prompt');
});

test('error overrides any log status', () => {
  assert.equal(one([log({ status: 'thinking' })], [row({ state: 'error' })]).status, 'error');
});

test('working carries a fresh active log status', () => {
  for (const st of ['thinking', 'tool', 'typing', 'waiting']) {
    assert.equal(one([log({ status: st })], [row({ state: 'working' })]).status, st);
  }
});

test('working with an idle/done log or no log is thinking', () => {
  assert.equal(one([log({ status: 'done' })], [row({ state: 'working' })]).status, 'thinking');
  assert.equal(one([log({ status: 'idle' })], [row({ state: 'working' })]).status, 'thinking');
  assert.equal(one([], [row({ state: 'working' })]).status, 'thinking');
});

test('stale log waiting is not carried over a newer working hook', () => {
  const s = one([log({ status: 'waiting', lastEventAt: NOW - 10000 })], [row({ state: 'working', updatedAt: iso(NOW - 1000) })]);
  assert.equal(s.status, 'thinking');
  // within the 2s slack it still counts as current
  const t = one([log({ status: 'waiting', lastEventAt: NOW - 2500 })], [row({ state: 'working', updatedAt: iso(NOW - 1000) })]);
  assert.equal(t.status, 'waiting');
});

test('done is done', () => {
  assert.equal(one([log({ status: 'thinking' })], [row({ state: 'done' })]).status, 'done');
});

test('ready with a finished log is done, otherwise idle', () => {
  assert.equal(one([log({ status: 'done' })], [row({ state: 'ready' })]).status, 'done');
  assert.equal(one([log({ status: 'thinking' })], [row({ state: 'ready' })]).status, 'idle');
  assert.equal(one([], [row({ state: 'ready' })]).status, 'idle');
});

// ---- synthesis and presence

test('synthesizes session without log', () => {
  const s = one([], [row({ provider: 'codex', sessionId: 'x1', name: 'renamed', model: 'gpt-x', updatedAt: iso(NOW - 4000) })]);
  assert.equal(s.agent, 'codex');
  assert.equal(s.cwd, '/p/demo');
  assert.equal(s.title, 'renamed');
  assert.equal(s.model, 'gpt-x');
  assert.equal(s.lastEventAt, NOW - 4000);
  assert.equal(s.alive, true);
  assert.equal(s.pid, 123);
  assert.equal(s.deckState, 'working');
});

test('log title wins; name fills an empty title', () => {
  assert.equal(one([log({ title: 'from log' })], [row({ name: 'deck' })]).title, 'from log');
  assert.equal(one([log({ title: null })], [row({ name: 'deck' })]).title, 'deck');
});

test('merge does not mutate the watcher sessions', () => {
  const l = log({ status: 'done' });
  one([l], [row({ state: 'waiting' })]);
  assert.equal(l.status, 'done');
  assert.equal(l.alive, undefined);
});

test('not running row is not alive', () => {
  assert.equal(one([], [row({ running: false })]).alive, false);
});

test('shared app-server done over 5 min is not alive', () => {
  const base = { provider: 'codex', sessionId: 'x1', sharedProcess: true, state: 'done' };
  assert.equal(one([], [row({ ...base, updatedAt: iso(NOW - 6 * 60000) })]).alive, false);
  assert.equal(one([], [row({ ...base, updatedAt: iso(NOW - 60000) })]).alive, true);
  // a shared row still working stays, however long
  assert.equal(one([], [row({ ...base, state: 'working', updatedAt: iso(NOW - 60 * 60000) })]).alive, true);
});

test('ended log session marked not alive', () => {
  const out = mergeSessions([log({ id: 'old', status: 'done' })], feed([row()]), new Map(), NOW);
  assert.equal(out.find((s) => s.id === 'old').alive, false);
  assert.equal(out.find((s) => s.id === 'c1').alive, true);
});

test('subagent of alive parent kept only while active', () => {
  const sub = (status) => log({ id: 'sub1', subagent: true, parentId: 'c1', status });
  const run = (status, parentRow) => mergeSessions([log(), sub(status)], feed([parentRow]), new Map(), NOW).find((s) => s.id === 'sub1');
  // undecided rather than true: the clock still retires a crashed subagent
  assert.equal(run('tool', row()).alive, undefined);
  assert.equal(run('done', row()).alive, false);
  assert.equal(run('tool', row({ running: false })).alive, false);
});

test('agents without hooks keep log-based presence', () => {
  const g = { ...newSession('gemini', 'g1', '/g.json'), status: 'thinking', lastEventAt: NOW - 500 };
  const out = mergeSessions([g], feed([row()]), new Map(), NOW);
  assert.equal(out.find((s) => s.id === 'g1').alive, undefined);
});

test('future or non-string feed values are rejected', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.json');
  fs.writeFileSync(file, JSON.stringify(feed([], { generatedAt: iso(NOW + 10 * 60000) })));
  assert.equal(loadFeed(file, NOW, () => true).reason, 'stale');
  const out = mergeSessions([], feed([row({ sessionId: 42 }), row({ provider: 'codex', sessionId: 'x1', parentSessionId: { a: 1 } })]), new Map(), NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].spawnedBy, null);
});

test('a failed read is retried even when mtime is unchanged', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.json');
  fs.writeFileSync(file, JSON.stringify(feed([])));
  const src = new FeedSource(file, { isAlive: () => true });
  const orig = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('EBUSY'); };
  try { assert.equal(src.read(NOW).ok, false); } finally { fs.readFileSync = orig; }
  assert.equal(src.read(NOW).ok, true);
});

// ---- parents

test('codex parent from the feed', () => {
  const s = one([], [row({ provider: 'codex', sessionId: 'x1', parentSessionId: 'c1' })]);
  assert.equal(s.parentId, 'c1');
  assert.equal(s.subagent, true);
  assert.equal(s.spawnedBy, 'claude');
  assert.equal(one([], [row()]).spawnedBy, null);
});

function pluginDir() {
  const root = tmp();
  const write = (ws, jobs) => {
    const d = path.join(root, 'codex-openai-codex', 'state', ws);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ version: 1, jobs }));
  };
  write('a', [{ sessionId: 'c1', threadId: 't1' }, { sessionId: 'c1', threadId: null }]);
  write('b', [{ sessionId: 'c2', threadId: 't2' }]);
  fs.mkdirSync(path.join(root, 'other-plugin', 'state', 'z'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other-plugin', 'state', 'z', 'state.json'), JSON.stringify({ jobs: [{ sessionId: 'no', threadId: 'no' }] }));
  return root;
}

test('plugin parent mapping', () => {
  const m = pluginParents(pluginDir());
  assert.deepEqual([...m].sort(), [['t1', 'c1'], ['t2', 'c2']]);
});

test('plugin parent wins over feed', () => {
  const s = one([], [row({ provider: 'codex', sessionId: 't2', parentSessionId: 'c1' })], pluginParents(pluginDir()));
  assert.equal(s.parentId, 'c2');
});

// ---- loading

function feedFile(content) {
  const f = path.join(tmp(), 'live.json');
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}

test('fresh feed loads', () => {
  const r = loadFeed(feedFile(feed([row()])), NOW, () => true);
  assert.equal(r.ok, true);
  assert.equal(r.feed.sessions.length, 1);
});

test('stale feed falls back', () => {
  const r = loadFeed(feedFile(feed([], { generatedAt: iso(NOW - 46000) })), NOW, () => true);
  assert.deepEqual(r, { ok: false, reason: 'stale' });
  assert.equal(FRESH_MS, 45000);
});

test('dead app falls back', () => {
  assert.deepEqual(loadFeed(feedFile(feed([])), NOW, () => false), { ok: false, reason: 'app-dead' });
});

test('invalid json, schema mismatch, missing file', () => {
  assert.equal(loadFeed(feedFile('{nope'), NOW, () => true).reason, 'invalid');
  assert.equal(loadFeed(feedFile(feed([], { schemaVersion: 2 })), NOW, () => true).reason, 'schema');
  assert.equal(loadFeed(feedFile({ schemaVersion: 1 }), NOW, () => true).reason, 'schema');
  assert.equal(loadFeed(path.join(tmp(), 'none.json'), NOW, () => true).reason, 'missing');
});

test('feed source re-checks freshness without the file changing', () => {
  const src = new FeedSource(feedFile(feed([row()])), { isAlive: () => true });
  assert.equal(src.read(NOW).ok, true);
  assert.deepEqual(src.read(NOW + FRESH_MS + 5000), { ok: false, reason: 'stale' });
  src.isAlive = () => false;
  assert.deepEqual(src.read(NOW), { ok: false, reason: 'app-dead' });
});
