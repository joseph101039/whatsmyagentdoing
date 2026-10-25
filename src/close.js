'use strict';

// Closing a session from the page = SIGTERM to the agent's own process,
// after making sure the pid still belongs to that session. Never SIGKILL:
// the agent gets to save its transcript and exit cleanly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const START_SLACK_MS = 1500; // ps lstart has 1s resolution
const INSPECT_TTL_MS = 10000;

function runPs(pid) {
  // LC_ALL=C keeps lstart in the English format Date.parse understands.
  return execFileSync('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
  });
}

// → { alive, command, startedAt } or null when there is no such process.
function inspectPid(pid, run = runPs) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let out;
  try { out = run(pid); } catch { return null; }
  const m = String(out).match(/^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)/);
  if (!m) return null;
  const startedAt = Date.parse(m[1]);
  return Number.isFinite(startedAt) ? { alive: true, command: m[2], startedAt } : null;
}

const cache = new Map(); // pid -> { at, info }
function inspectCached(pid, now = Date.now(), run) {
  const c = cache.get(pid);
  if (c && now - c.at < INSPECT_TTL_MS) return c.info;
  const info = inspectPid(pid, run);
  cache.set(pid, { at: now, info });
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= INSPECT_TTL_MS) cache.delete(k);
  return info;
}

// Claude Code keeps <config>/sessions/<pid>.json for each running process.
function claudeRegistry(pid) {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions', `${pid}.json`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try { return JSON.parse(text).sessionId || null; } catch { return null; }
}

// The cheap checks that need no process lookup; null when they pass.
function precheck(row) {
  if (!row || !Number.isInteger(row.agentPid) || row.agentPid <= 1 || !row.processStartedAt) return 'no-pid';
  if (!row.running) return 'not-running';
  // the plugin's codex app-server serves many sessions at once
  if (row.sharedProcess) return 'shared-process';
  if (row.provider !== 'claude' && row.provider !== 'codex') return 'not-agent';
  return null;
}

// The executable (or the script node runs) must be the agent itself, e.g.
// ~/.local/share/claude/versions/2.1.308 or `node …/codex exec`. Only the
// first two words: a shell whose arguments mention ~/.claude is not Claude.
function isAgentCommand(command, provider) {
  return String(command).split(/\s+/).slice(0, 2).some((w) => w.toLowerCase().includes(provider));
}

// row: a live.json session; info: inspectPid() of its agentPid.
// → { ok: true } or { ok: false, reason }
function canClose(row, info, now = Date.now(), { registry = claudeRegistry } = {}) {
  const pre = precheck(row);
  if (pre) return { ok: false, reason: pre };
  if (!info || !info.alive) return { ok: false, reason: 'gone' };
  const started = Date.parse(row.processStartedAt);
  // A different start time means the pid was reused by another process.
  if (!Number.isFinite(started) || Math.abs(info.startedAt - started) > START_SLACK_MS) {
    return { ok: false, reason: 'pid-reused' };
  }
  if (!isAgentCommand(info.command, row.provider)) return { ok: false, reason: 'not-agent' };
  if (row.provider === 'claude') {
    const id = registry(row.agentPid);
    if (id !== undefined && id !== row.sessionId) return { ok: false, reason: 'session-mismatch' };
  }
  return { ok: true };
}

function closeSession(row, { inspect = inspectPid, kill = process.kill.bind(process), now = Date.now(), registry } = {}) {
  const pre = precheck(row);
  if (pre) return { ok: false, reason: pre };
  const check = canClose(row, inspect(row.agentPid), now, registry ? { registry } : undefined);
  if (!check.ok) return check;
  try {
    kill(row.agentPid, 'SIGTERM');
  } catch (e) {
    return { ok: false, reason: e.code === 'EPERM' ? 'not-permitted' : 'gone' };
  }
  cache.delete(row.agentPid);
  return { ok: true };
}

module.exports = { inspectPid, inspectCached, canClose, closeSession, precheck };
