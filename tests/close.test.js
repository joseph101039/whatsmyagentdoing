'use strict';

// Every process here is fake: ps output, the registry and kill() are
// injected, so no real agent can be signalled by running the tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectPid, canClose, closeSession } = require('../src/close');

const STARTED = 'Sun Oct 25 09:03:02 2026';
const STARTED_MS = Date.parse(STARTED);
const NOW = STARTED_MS + 3600000;

function row(over = {}) {
  return {
    key: 'claude-c1', provider: 'claude', sessionId: 'c1', state: 'working', agentPid: 4242,
    running: true, sharedProcess: false, processStartedAt: new Date(STARTED_MS + 300).toISOString(), ...over,
  };
}
const info = (command, startedAt = STARTED_MS) => ({ alive: true, command, startedAt });
const noRegistry = { registry: () => undefined };
const CLAUDE = '/Users/me/.local/share/claude/versions/2.1.308 --resume c1';

test('inspectPid parses ps lstart and the full command', () => {
  const r = inspectPid(4242, () => `${STARTED}     /Users/me/.local/share/claude/versions/2.1.308 -p hello\n`);
  assert.deepEqual(r, { alive: true, command: '/Users/me/.local/share/claude/versions/2.1.308 -p hello', startedAt: STARTED_MS });
  assert.equal(inspectPid(4242, () => { throw new Error('exit 1'); }), null);
  assert.equal(inspectPid(4242, () => ''), null);
  assert.equal(inspectPid(1, () => `${STARTED} launchd`), null);
  // single-digit days are space padded
  assert.equal(inspectPid(7, () => 'Mon Oct  5 01:02:03 2026 codex exec hi').startedAt, Date.parse('Mon Oct 5 01:02:03 2026'));
});

test('canClose accepts versioned claude binary', () => {
  assert.deepEqual(canClose(row(), info(CLAUDE), NOW, noRegistry), { ok: true });
  assert.deepEqual(canClose(row(), info(CLAUDE), NOW, { registry: () => 'c1' }), { ok: true });
});

test('canClose accepts codex exec', () => {
  const r = row({ provider: 'codex', sessionId: 'x1' });
  assert.deepEqual(canClose(r, info('/opt/homebrew/bin/codex exec --json fix it'), NOW, noRegistry), { ok: true });
  assert.deepEqual(canClose(r, info('node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js exec hi'), NOW, noRegistry), { ok: true });
});

test('canClose rejects recycled pid', () => {
  assert.equal(canClose(row(), info(CLAUDE, STARTED_MS + 5000), NOW, noRegistry).reason, 'pid-reused');
  assert.equal(canClose(row(), info(CLAUDE, STARTED_MS - 2000), NOW, noRegistry).reason, 'pid-reused');
  assert.equal(canClose(row(), null, NOW, noRegistry).reason, 'gone');
});

test('canClose rejects app-server', () => {
  const r = row({ provider: 'codex', sessionId: 'x1', sharedProcess: true });
  assert.equal(canClose(r, info('/opt/homebrew/bin/codex app-server'), NOW, noRegistry).reason, 'shared-process');
});

test('canClose rejects non-agent', () => {
  assert.equal(canClose(row(), info('/usr/bin/python3 server.py'), NOW, noRegistry).reason, 'not-agent');
  // a shell whose arguments merely mention ~/.claude is not Claude
  assert.equal(canClose(row(), info('/bin/zsh -c source /Users/me/.claude/shell-snapshots/x.sh && codex'), NOW, noRegistry).reason, 'not-agent');
  // a codex row whose pid now runs claude
  assert.equal(canClose(row({ provider: 'codex' }), info(CLAUDE), NOW, noRegistry).reason, 'not-agent');
});

test('canClose rejects registry session mismatch', () => {
  assert.equal(canClose(row(), info(CLAUDE), NOW, { registry: () => 'someone-else' }).reason, 'session-mismatch');
  assert.equal(canClose(row(), info(CLAUDE), NOW, { registry: () => null }).reason, 'session-mismatch');
});

test('canClose rejects rows without identity or not running', () => {
  assert.equal(canClose(row({ agentPid: null }), info(CLAUDE), NOW, noRegistry).reason, 'no-pid');
  assert.equal(canClose(row({ processStartedAt: null }), info(CLAUDE), NOW, noRegistry).reason, 'no-pid');
  assert.equal(canClose(row({ running: false }), info(CLAUDE), NOW, noRegistry).reason, 'not-running');
});

test('closeSession sends SIGTERM only after the checks pass', () => {
  const sent = [];
  const kill = (pid, sig) => sent.push([pid, sig]);
  const ok = closeSession(row(), { inspect: () => info(CLAUDE), kill, now: NOW, registry: () => 'c1' });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(sent, [[4242, 'SIGTERM']]);

  const bad = closeSession(row(), { inspect: () => info(CLAUDE, STARTED_MS + 9000), kill, now: NOW, registry: () => 'c1' });
  assert.deepEqual(bad, { ok: false, reason: 'pid-reused' });
  assert.equal(sent.length, 1);

  const gone = closeSession(row(), { inspect: () => info(CLAUDE), kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, now: NOW, registry: () => 'c1' });
  assert.deepEqual(gone, { ok: false, reason: 'gone' });
});

// ---- server: feed mode and the guarded endpoint (no process is signalled:
// the only row has a pid whose identity can't match)

test('server reports feed mode, presence and refuses unguarded closes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createServer, snapshot } = require('../src/server');
  const { FeedSource } = require('../src/agentdeck');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-srv-'));
  const file = path.join(dir, 'live.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), appPid: process.pid,
    sessions: [row({ sessionId: 'feedonly', agentPid: 999999, processStartedAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now).toISOString() })],
  }));
  const pins = [];
  const watcher = { on() {}, sessions: () => [], setPinned: (l) => pins.push(l) };
  const opts = { privacy: false, feed: new FeedSource(file) };
  const snap = snapshot(watcher, opts);
  assert.deepEqual(snap.feed, { mode: 'agentdeck' });
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].key, 'claude:feedonly');
  assert.equal(snap.sessions[0].alive, true);
  assert.equal(snap.sessions[0].closable, false);
  assert.deepEqual(pins.at(-1), [{ agent: 'claude', id: 'feedonly' }]);
  // log mode output stays as upstream: no feed field, no presence fields
  const plain = snapshot(watcher, { privacy: false });
  assert.equal(plain.feed, undefined);

  const server = createServer(watcher, { ...opts, managed: 'inst-1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const ping = await fetch(base + '/api/ping').then((r) => r.json());
    assert.deepEqual(ping, { app: 'whatsmyagentdoing', instance: 'inst-1' });
    assert.equal((await fetch(base + '/api/sessions/close?key=claude:feedonly', { method: 'POST' })).status, 403);
    const h = { method: 'POST', headers: { 'x-whatsmyagentdoing': 'close' } };
    const unknown = await fetch(base + '/api/sessions/close?key=claude:nope', h);
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { ok: false, reason: 'unknown-session' });
    const gone = await fetch(base + '/api/sessions/close?key=claude:feedonly', h);
    assert.equal(gone.status, 400);
    assert.equal((await gone.json()).ok, false);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: new Date(now - 60000).toISOString(), appPid: process.pid, sessions: [] }));
    assert.deepEqual(await fetch(base + '/api/sessions/close?key=claude:feedonly', h).then((r) => r.json()), { ok: false, reason: 'stale' });
    const s2 = await fetch(base + '/api/sessions').then((r) => r.json());
    assert.deepEqual(s2.feed, { mode: 'logs', reason: 'stale' });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
