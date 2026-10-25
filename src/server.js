'use strict';

const fs = require('fs');
const http = require('http');
const { guessFromPrompts } = require('./lang');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/office3d.js': ['office3d.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/popout.js': ['popout.js', 'text/javascript; charset=utf-8'],
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
// 3D models, served as-is (3D view only).
const MOUNTS = { '/assets/': path.join(__dirname, '..', 'assets') };
const scenes = require('./scenes');
const updater = require('./update');
const { mergeSessions, pluginParents, isPresent } = require('./agentdeck');
const { canClose, closeSession, inspectCachedMany, precheck } = require('./close');

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  // no-cache: a reinstalled scene pack or an updated clone must show up on reload
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const ACTIVE = new Set(['thinking', 'tool', 'typing']);

// Logs only record finished blocks, so a few states need a clock to resolve:
// a reply with no follow-up is a finished turn, and an "active" session that
// has gone silent for a long time was most likely closed mid-turn.
// With the AgentDeck feed, `deck` maps keys to live.json rows; sessions it
// reports as running come from hooks and need no clock.
function view(s, now, { privacy }, deck, procs) {
  const quiet = now - (s.lastEventAt || s.mtime || now);
  let status = s.status;
  if (s.alive !== true) {
    if (status === 'typing' && quiet > 45_000) status = 'done';
    if (status === 'thinking' && quiet > 15 * 60_000) status = 'idle';
    if (status === 'tool' && quiet > 45 * 60_000) status = 'idle';
    if ((status === 'waiting' || status === 'error') && quiet > 2 * 3600_000) status = 'idle';
  }

  const out = {
    key: `${s.agent}:${s.id}`,
    agent: s.agent,
    id: s.id,
    sessionId: s.sessionId || null,
    parentId: s.parentId,
    subagent: s.subagent,
    cwd: s.cwd,
    project: s.cwd ? path.basename(s.cwd) : null,
    title: s.title,
    model: s.model,
    status,
    activity: status === 'tool' || status === 'waiting' ? s.activity : null,
    prompt: s.prompt,
    reply: s.reply,
    error: s.error,
    turnStartedAt: s.turnStartedAt,
    lastEventAt: s.lastEventAt || s.mtime,
    startedAt: s.startedAt,
  };
  if (deck) {
    const row = deck.get(out.key);
    // null: an agent the feed doesn't cover (Gemini), presence from the logs
    out.alive = typeof s.alive === 'boolean' ? s.alive : null;
    out.pid = s.pid ?? null;
    out.spawnedBy = s.spawnedBy || null;
    out.waitingReason = s.waitingReason || null;
    // procs: one batched, cached ps lookup for the rows that pass the cheap checks
    out.closable = !!row && out.alive === true && !precheck(row) && canClose(row, procs.get(row.agentPid), now).ok;
  }
  if (privacy) {
    out.prompt = out.reply = out.title = null;
    if (out.activity) out.activity = out.activity.split(/[:\s]/)[0];
    // Claude's registry reason is free text that can quote a command
    out.waitingReason = null;
  }
  return out;
}

// A parent whose turn ended (done/idle) while subagents it started are still
// busy is waiting on them, not finished: show it as running a tool with a
// count, so it keeps its desk and counts as working. Children are counted from
// their own view() statuses before any parent changes, so nested or cyclic
// links can't hold each other up. Needs-you and interrupted states are kept,
// and a parent whose process ended stays gone.
function markDelegating(sessions) {
  const busy = new Map();
  for (const c of sessions) {
    if (!c.subagent || !c.parentId || c.alive === false || !ACTIVE.has(c.status)) continue;
    const parentKey = `${c.spawnedBy || c.agent}:${c.parentId}`;
    if (parentKey === c.key) continue;
    busy.set(parentKey, (busy.get(parentKey) || 0) + 1);
  }
  return sessions.map((s) => {
    const n = busy.get(s.key);
    if (!n || s.alive === false || (s.status !== 'done' && s.status !== 'idle')) return s;
    return { ...s, status: 'tool', activity: null, delegating: n };
  });
}

// The language the user writes their prompts in (recent sessions first);
// the page uses it as the default UI language.
function promptLanguage(raw) {
  const recent = raw
    .filter((s) => !s.subagent && s.prompt && !s.prompt.startsWith('/'))
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))
    .slice(0, 60)
    .map((s) => s.prompt);
  return guessFromPrompts(recent);
}

// The plugin's job files change once per Codex task; a directory scan on
// every snapshot (each SSE push and API call) buys nothing.
let parentsAt = 0;
let parentsMemo = new Map();
function cachedParents(now) {
  if (now - parentsAt >= 3000) { parentsMemo = pluginParents(); parentsAt = now; }
  return parentsMemo;
}

// opts.feed (--agentdeck): a FeedSource. When it's fresh it decides who is
// present; when not, fall back to the logs and say why.
function snapshot(watcher, opts) {
  const now = Date.now();
  let raw = watcher.sessions();
  let deck = null;
  let feed = null;
  if (opts.feed) {
    const r = opts.feed.read(now);
    if (r.ok) {
      deck = new Map(r.feed.sessions.filter((x) => x && x.sessionId).map((x) => [`${x.provider}:${x.sessionId}`, x]));
      if (watcher.setPinned) {
        watcher.setPinned([...deck.values()].filter((x) => isPresent(x, now)).map((x) => ({ agent: x.provider, id: x.sessionId })));
      }
      raw = mergeSessions(raw, r.feed, cachedParents(now), now);
      feed = { mode: 'agentdeck' };
    } else {
      if (watcher.setPinned) watcher.setPinned([]);
      feed = { mode: 'logs', reason: r.reason };
    }
  }
  let procs = new Map();
  if (deck) {
    const pids = [...deck.values()].filter((x) => isPresent(x, now) && !precheck(x)).map((x) => x.agentPid);
    procs = inspectCachedMany(pids, now);
  }
  const sessions = markDelegating(raw.map((s) => view(s, now, opts, deck, procs)));
  sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  const out = { now, lang: opts.demo ? null : promptLanguage(raw), sessions };
  if (feed) out.feed = feed;
  return out;
}

function createServer(watcher, opts, { onShutdown, onRestart } = {}) {
  const clients = new Set();
  let last = '';

  const push = (force) => {
    // Nobody listening: skip the work; a new /events client gets a fresh snapshot.
    if (!clients.size) { last = ''; return; }
    let body;
    try { body = JSON.stringify(snapshot(watcher, opts)); } catch (e) { console.error('snapshot failed:', e.message); return; }
    // Compare without the timestamp so idle ticks don't spam clients.
    const sig = body.replace(/^\{"now":\d+,/, '{');
    if (!force && sig === last) return;
    last = sig;
    for (const res of clients) res.write(`data: ${body}\n\n`);
  };
  watcher.on('change', () => push(false));
  // Status can flip with no new log lines (see view()), so re-check on a clock.
  setInterval(() => push(false), 5000).unref();
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

  const server = http.createServer((req, res) => {
    // Refuse anything not addressed to loopback (blocks DNS-rebinding pages
    // from reading your prompts through this server).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    } else if (Object.keys(MOUNTS).some((m) => url.pathname.startsWith(m))) {
      const m = Object.keys(MOUNTS).find((k) => url.pathname.startsWith(k));
      serveFile(res, MOUNTS[m], decodeURIComponent(url.pathname.slice(m.length)));
    } else if (url.pathname.startsWith('/scenes/')) {
      const rel = decodeURIComponent(url.pathname.slice('/scenes/'.length));
      const [id, ...rest] = rel.split('/');
      const dir = scenes.sceneDir(id);
      if (!dir) res.writeHead(404).end();
      else serveFile(res, dir, rest.join('/'));
    } else if (url.pathname === '/api/scenes') {
      const cat = scenes.catalog();
      const icon = (x) => x.icon || (cat.find((c) => c.id === x.id) || {}).icon || '🗺️';
      const have = scenes.installed().map((x) => ({ ...x, icon: icon(x) }));
      const ids = new Set(have.map((x) => x.id));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        installed: have.map(({ id, name, version, credits, icon }) => ({ id, name, version, credits, icon })),
        available: cat.filter((x) => !ids.has(x.id)).map(({ id, name, version, size, credits, icon }) => ({ id, name, version, size, credits, icon: icon || '🗺️' })),
      }));
    } else if (url.pathname === '/api/scenes/install' && req.method === 'POST') {
      // Same guard as shutdown: a custom header web pages can't send cross-site.
      if (req.headers['x-whatsmyagentdoing'] !== 'install') { res.writeHead(403).end(); return; }
      const id = url.searchParams.get('id') || '';
      scenes.install(id).then(
        (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: x.id })); },
        (e) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); },
      );
    } else if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot(watcher, opts)));
    } else if (url.pathname === '/api/sessions/close' && req.method === 'POST') {
      // Same guard as shutdown: web pages can't send this header cross-site.
      if (req.headers['x-whatsmyagentdoing'] !== 'close' || !opts.feed) { res.writeHead(403).end(); return; }
      // Decide on the latest rows, not the ones the page was rendered from.
      const r = opts.feed.read(Date.now(), { force: true });
      const key = url.searchParams.get('key') || '';
      const row = r.ok && r.feed.sessions.find((x) => x && `${x.provider}:${x.sessionId}` === key);
      const result = !r.ok ? { ok: false, reason: r.reason } : !row ? { ok: false, reason: 'unknown-session' } : closeSession(row);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      // Only our CLI sends this header; a web page can't add a custom header
      // to a cross-site request without a CORS preflight, which we never allow.
      if (req.headers['x-whatsmyagentdoing'] !== 'stop' || !onShutdown) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      for (const c of clients) c.end();
      setTimeout(onShutdown, 50);
    } else if (url.pathname === '/api/version') {
      updater.checkLatest().finally(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(updater.info()));
      });
    } else if (url.pathname === '/api/update' && req.method === 'POST') {
      // Same guard as shutdown: web pages can't send this header cross-site.
      if (req.headers['x-whatsmyagentdoing'] !== 'update') { res.writeHead(403).end(); return; }
      updater.update().then(
        (version) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version }));
          for (const c of clients) c.end();
          if (onRestart) setTimeout(onRestart, 100);
        },
        (e) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); },
      );
    } else if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // --managed: the app checks it reached the server it started itself
      res.end(JSON.stringify(opts.managed ? { app: 'whatsmyagentdoing', instance: opts.managed } : { app: 'whatsmyagentdoing' }));
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(watcher, opts))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404).end();
    }
  });
  return server;
}

module.exports = { createServer, snapshot, markDelegating };
