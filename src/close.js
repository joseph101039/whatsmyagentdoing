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

// One ps call for any number of pids; ps exits 1 when some are gone, so
// its output is read from the error too.
function runPs(pids) {
  const args = ['-o', 'pid=', '-o', 'lstart=', '-o', 'command=', '-p', pids.join(',')];
  // LC_ALL=C keeps lstart in the English format Date.parse understands.
  const opts = { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
  try { return execFileSync('ps', args, opts); } catch (e) { return typeof e.stdout === 'string' ? e.stdout : ''; }
}

const LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)/;

// → Map pid -> { alive, command, startedAt }; pids with no process are absent.
function inspectPids(pids, run = runPs) {
  const out = new Map();
  const valid = pids.filter((p) => Number.isInteger(p) && p > 1);
  if (!valid.length) return out;
  let text;
  try { text = String(run(valid)); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(LINE);
    if (!m) continue;
    const startedAt = Date.parse(m[2]);
    if (Number.isFinite(startedAt)) out.set(Number(m[1]), { alive: true, command: m[3], startedAt });
  }
  return out;
}

// → { alive, command, startedAt } or null when there is no such process.
function inspectPid(pid, run = runPs) {
  return inspectPids([pid], run).get(pid) || null;
}

const cache = new Map(); // pid -> { at, info }
// Looks up every pid that isn't cached in a single ps call, so a snapshot
// costs at most one spawn per INSPECT_TTL_MS however many sessions run.
function inspectCachedMany(pids, now = Date.now(), run) {
  const stale = [...new Set(pids)].filter((p) => { const c = cache.get(p); return !c || now - c.at >= INSPECT_TTL_MS; });
  if (stale.length) {
    const found = inspectPids(stale, run);
    for (const p of stale) cache.set(p, { at: now, info: found.get(p) || null });
  }
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= INSPECT_TTL_MS) cache.delete(k);
  return new Map(pids.map((p) => [p, cache.get(p) ? cache.get(p).info : null]));
}
function inspectCached(pid, now = Date.now(), run) {
  return inspectCachedMany([pid], now, run).get(pid);
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

// Install layouts whose executable isn't simply named after the agent.
const AGENT_PATHS = {
  claude: ['/claude/versions/', '/@anthropic-ai/claude-code/'],
  codex: ['/@openai/codex/'],
};
const NODES = new Set(['node', 'bun']);

// The executable (or the script node runs) must be the agent itself, e.g.
// `claude`, ~/.local/share/claude/versions/2.1.308 or `node …/bin/codex`.
// Exact basenames, case-sensitive: Claude.app, codex-code-mode-host, an
// editor on claude-notes.md or a shell whose arguments mention ~/.claude
// are not the agent.
function isAgentCommand(command, provider) {
  const words = String(command).split(/\s+/);
  const isAgent = (w) => !!w && (path.basename(w) === provider || (AGENT_PATHS[provider] || []).some((p) => w.includes(p)));
  if (isAgent(words[0])) return true;
  return NODES.has(path.basename(words[0] || '')) && isAgent(words[1]);
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
  // Claude keeps a registry file for every running process, so a missing
  // one fails closed. Codex has no equivalent: pid + start time + the
  // executable are the whole identity, re-read by ps just before the kill.
  if (row.provider === 'claude' && registry(row.agentPid) !== row.sessionId) {
    return { ok: false, reason: 'session-mismatch' };
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

module.exports = { inspectPid, inspectPids, inspectCached, inspectCachedMany, canClose, closeSession, precheck, isAgentCommand };
