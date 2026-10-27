'use strict';

// AgentDeck (a macOS menubar app) writes the sessions it sees through agent
// hooks to live.json. When that feed is fresh it decides who is present and
// who spawned whom; the logs still supply the fine-grained activity.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { newSession, pendingBackground } = require('./parsers');

const FRESH_MS = 45000;          // AgentDeck rewrites the file at least every 15s
const SHARED_DONE_MS = 5 * 60000; // plugin app-server never ends its sessions
const CARRY_SLACK_MS = 2000;
const LOG_ACTIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);
const FEED_AGENTS = new Set(['claude', 'codex']); // the agents AgentDeck has hooks for

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function parseFeed(text) {
  let feed;
  try { feed = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (!feed || feed.schemaVersion !== 1 || !Array.isArray(feed.sessions)) return { ok: false, reason: 'schema' };
  return { ok: true, feed };
}

// Freshness and the app's pid are re-checked on every call: a crashed
// AgentDeck leaves a perfectly valid file behind that never changes again.
function checkFeed(feed, now, isAlive = pidAlive) {
  const at = Date.parse(feed.generatedAt);
  // a timestamp from the future would otherwise stay "fresh" until the clock caught up
  if (!Number.isFinite(at) || Math.abs(now - at) > FRESH_MS) return { ok: false, reason: 'stale' };
  if (!Number.isInteger(feed.appPid) || feed.appPid <= 1 || !isAlive(feed.appPid)) return { ok: false, reason: 'app-dead' };
  return { ok: true, feed };
}

function loadFeed(file, now = Date.now(), isAlive = pidAlive) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  const r = parseFeed(text);
  return r.ok ? checkFeed(r.feed, now, isAlive) : r;
}

// Re-parses only when the file changes; read({ force }) for actions that
// must see the latest rows (closing a session).
class FeedSource {
  constructor(file, { isAlive = pidAlive } = {}) {
    this.file = file;
    this.isAlive = isAlive;
    this.mtime = -1;
    this.parsed = { ok: false, reason: 'missing' };
  }

  read(now = Date.now(), { force = false } = {}) {
    let st = null;
    try { st = fs.statSync(this.file); } catch {}
    if (!st) { this.mtime = -1; return { ok: false, reason: 'missing' }; }
    if (force || st.mtimeMs !== this.mtime) {
      // mtime is remembered only after a successful read, so a transient
      // failure (file mid-rename) is retried on the next call
      try {
        this.parsed = parseFeed(fs.readFileSync(this.file, 'utf8'));
        this.mtime = st.mtimeMs;
      } catch { this.parsed = { ok: false, reason: 'missing' }; this.mtime = -1; }
    }
    return this.parsed.ok ? checkFeed(this.parsed.feed, now, this.isAlive) : this.parsed;
  }
}

function isPresent(row, now) {
  if (!row.running) return false;
  const quiet = now - (Date.parse(row.updatedAt) || 0);
  return !(row.sharedProcess && row.state === 'done' && quiet > SHARED_DONE_MS);
}

const pluginCache = new Map(); // state.json path -> { mtime, pairs }

// The Codex plugin for Claude Code records each job with both the Claude
// session that asked and the Codex thread that ran it — an exact pairing,
// unlike the process ancestry AgentDeck has to guess from.
function pluginParents(root) {
  const dataRoot = root || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'data');
  const out = new Map();
  const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const seen = new Set();
  for (const p of ls(dataRoot)) {
    if (!p.isDirectory() || !p.name.includes('codex')) continue;
    const stateDir = path.join(dataRoot, p.name, 'state');
    for (const w of ls(stateDir)) {
      if (!w.isDirectory()) continue;
      const file = path.join(stateDir, w.name, 'state.json');
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      seen.add(file);
      let c = pluginCache.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        const pairs = [];
        try {
          for (const j of JSON.parse(fs.readFileSync(file, 'utf8')).jobs || []) {
            if (j && typeof j.threadId === 'string' && typeof j.sessionId === 'string') pairs.push([j.threadId, j.sessionId]);
          }
        } catch {}
        c = { mtime: st.mtimeMs, pairs };
        pluginCache.set(file, c);
      }
      for (const [thread, session] of c.pairs) out.set(thread, session);
    }
  }
  for (const f of pluginCache.keys()) if (!seen.has(f)) pluginCache.delete(f);
  return out;
}

function mergedStatus(row, log) {
  switch (row.state) {
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    case 'done': return 'done';
    case 'ready': return log && log.status === 'done' ? 'done' : 'idle';
    case 'working':
      // A log line older than the hook means the log is behind (e.g. a
      // permission prompt already answered), so it can't override "working".
      if (log && LOG_ACTIVE.has(log.status) && (log.lastEventAt || 0) >= (Date.parse(row.updatedAt) || 0) - CARRY_SLACK_MS) {
        return log.status;
      }
      return 'thinking';
    default: return log ? log.status : 'idle';
  }
}

// Returns copies (the watcher's session objects stay untouched), each with
// alive / deckState / pid / waitingReason / spawnedBy for feed rows.
function mergeSessions(logSessions, feed, parents = new Map(), now = Date.now()) {
  const logs = new Map(logSessions.map((s) => [`${s.agent}:${s.id}`, s]));
  const out = new Map();
  for (const row of feed.sessions || []) {
    if (!row || !FEED_AGENTS.has(row.provider) || typeof row.sessionId !== 'string' || !row.sessionId) continue;
    const key = `${row.provider}:${row.sessionId}`;
    const log = logs.get(key);
    let s;
    if (log) {
      s = { ...log };
      if (!s.title && row.name) s.title = row.name;
      if (!s.cwd && row.projectPath) s.cwd = row.projectPath;
      if (!s.model && row.model) s.model = row.model;
    } else {
      s = newSession(row.provider, row.sessionId, null);
      s.cwd = row.projectPath || null;
      s.title = row.name || null;
      s.model = row.model || null;
      s.lastEventAt = Date.parse(row.updatedAt) || null;
    }
    s.status = mergedStatus(row, log); // view() shows activity only for tool/waiting
    s.alive = isPresent(row, now);
    s.deckState = row.state;
    s.pid = row.agentPid ?? null;
    s.waitingReason = row.waitingReason || null;
    s.spawnedBy = null;
    if (row.provider === 'codex') {
      const parent = parents.get(row.sessionId) || (typeof row.parentSessionId === 'string' ? row.parentSessionId : null);
      if (parent) { s.parentId = parent; s.subagent = true; s.spawnedBy = 'claude'; }
    }
    out.set(key, s);
  }
  for (const [key, log] of logs) {
    if (out.has(key)) continue;
    // Agents without AgentDeck hooks (Gemini) keep the log-based presence.
    if (!FEED_AGENTS.has(log.agent)) { out.set(key, { ...log }); continue; }
    const s = { ...log, alive: false };
    // Claude's own subagents have no hook session; they count while their
    // parent is present and they are visibly busy or waiting on a background
    // task. Presence stays undecided (not true) so the clock-based decay
    // still retires one that crashed mid-tool and will never log again.
    if (log.subagent && log.parentId && (LOG_ACTIVE.has(log.status) || pendingBackground(log, now) > 0)) {
      const parent = out.get(`${log.agent}:${log.parentId}`);
      if (parent && parent.alive) delete s.alive;
    }
    out.set(key, s);
  }
  return [...out.values()];
}

module.exports = { FRESH_MS, loadFeed, parseFeed, checkFeed, FeedSource, pluginParents, mergeSessions, isPresent };
