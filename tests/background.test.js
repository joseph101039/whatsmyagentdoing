'use strict';

// A Claude session or subagent whose turn ended while a background task it
// started (Bash run_in_background, Monitor) is still running is waiting on
// that task, not finished.

const test = require('node:test');
const assert = require('node:assert/strict');
const { newSession, applyClaude, pendingBackground, BG_MAX_MS } = require('../src/parsers');
const { mergeSessions } = require('../src/agentdeck');
const { markDelegating, snapshot } = require('../src/server');

const T0 = Date.parse('2026-10-27T04:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const launchBash = (id, at, toolId = `tu_${id}`) => [
  { type: 'assistant', timestamp: iso(at), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } },
  { type: 'user', timestamp: iso(at + 50), message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: `Command running in background with ID: ${id}.` }] }, toolUseResult: { stdout: '', backgroundTaskId: id } },
];
const endTurn = (at) => ({ type: 'assistant', timestamp: iso(at), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'waiting on the poll' }] } });
const stop = (name, input, at, isError = false) => [
  { type: 'assistant', timestamp: iso(at), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}`, name, input }] } },
  { type: 'user', timestamp: iso(at + 50), message: { content: [{ type: 'tool_result', tool_use_id: `tu_${name}`, content: isError ? 'No task found' : 'stopped', ...(isError ? { is_error: true } : {}) }] }, toolUseResult: isError ? undefined : { message: 'stopped', task_id: input.task_id || input.shell_id } },
];
const note = (id, status) => `<task-notification>\n<task-id>${id}</task-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>\n</task-notification>`;

function run(lines) {
  const s = newSession('claude', 'c1', '/x.jsonl');
  for (const d of lines) applyClaude(s, d);
  return s;
}

test('a background Bash with no completion notice is pending after the turn ends', () => {
  const s = run([...launchBash('bq3', T0), endTurn(T0 + 1000)]);
  assert.equal(s.status, 'done');
  assert.equal(pendingBackground(s, T0 + 60_000), 1);
});

test('every way the completion is logged clears it', () => {
  const at = T0 + 2000;
  const cases = {
    attachment: { type: 'attachment', timestamp: iso(at), attachment: { type: 'queued_command', prompt: note('bq3', 'completed') } },
    queue: { type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: note('bq3', 'failed') },
    user: { type: 'user', timestamp: iso(at), message: { content: note('bq3', 'stopped') } },
    // how a subagent whose turn ended is woken: a meta line with a preamble
    metaUser: { type: 'user', isMeta: true, timestamp: iso(at), message: { content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n${note('bq3', 'completed')}` } },
    taskStop: [...stop('TaskStop', { task_id: 'bq3' }, at)],
    killShell: [...stop('KillShell', { shell_id: 'bq3' }, at)],
  };
  for (const [name, line] of Object.entries(cases)) {
    const s = run([...launchBash('bq3', T0), endTurn(T0 + 1000), ...[line].flat()]);
    assert.equal(pendingBackground(s, T0 + 60_000), 0, name);
  }
});

test('a stop that failed, or was never answered, leaves the task pending', () => {
  const failed = run([...launchBash('bq3', T0), ...stop('TaskStop', { task_id: 'bq3' }, T0 + 2000, true)]);
  assert.equal(pendingBackground(failed, T0 + 60_000), 1);
  const asked = run([...launchBash('bq3', T0), stop('TaskStop', { task_id: 'bq3' }, T0 + 2000)[0]]);
  assert.equal(pendingBackground(asked, T0 + 60_000), 1);
});

test('a foreground Bash moved to the background by its timeout counts', () => {
  const s = run([
    { type: 'assistant', timestamp: iso(T0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_f', name: 'Bash', input: { command: 'mvn test', timeout: 120000 } }] } },
    { type: 'user', timestamp: iso(T0 + 120_000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_f', content: 'Command did not complete within its 120s timeout and was moved to the background (ID: b5z).' }] }, toolUseResult: { stdout: '', backgroundTaskId: 'b5z', timedOutAfterMs: 120000 } },
    endTurn(T0 + 121_000),
  ]);
  assert.equal(pendingBackground(s, T0 + 200_000), 1);
});

test('only a Bash or Monitor result can start a task', () => {
  const s = run([
    { type: 'assistant', timestamp: iso(T0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_o', name: 'TaskOutput', input: { task_id: 'old' } }] } },
    { type: 'user', timestamp: iso(T0 + 50), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_o', content: 'done' }] }, toolUseResult: { taskId: 'old', backgroundTaskId: 'old' } },
    { type: 'user', timestamp: iso(T0 + 60), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_unknown', content: 'x' }] }, toolUseResult: { backgroundTaskId: 'orphan' } },
    endTurn(T0 + 100),
  ]);
  assert.equal(pendingBackground(s, T0 + 1000), 0);
});

test('a Monitor counts until its final notice; per-event notices keep it', () => {
  const start = [
    { type: 'assistant', timestamp: iso(T0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_m', name: 'Monitor', input: { command: 'x' } }] } },
    { type: 'user', timestamp: iso(T0 + 50), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_m', content: 'Monitor started (task b8m…)' }] }, toolUseResult: { taskId: 'b8m', timeoutMs: 1800000 } },
    endTurn(T0 + 100),
  ];
  const event = { type: 'attachment', timestamp: iso(T0 + 200), attachment: { type: 'queued_command', prompt: note('b8m', null) } };
  assert.equal(pendingBackground(run([...start, event]), T0 + 1000), 1);
  const final = { type: 'attachment', timestamp: iso(T0 + 300), attachment: { type: 'queued_command', prompt: note('b8m', 'completed') } };
  assert.equal(pendingBackground(run([...start, event, final]), T0 + 1000), 0);
});

test('a Monitor longer than the cap counts until its own timeout', () => {
  const s = run([
    { type: 'assistant', timestamp: iso(T0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_m', name: 'Monitor', input: { command: 'x' } }] } },
    { type: 'user', timestamp: iso(T0), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_m', content: 'Monitor started' }] }, toolUseResult: { taskId: 'long', timeoutMs: 2 * BG_MAX_MS } },
  ]);
  assert.equal(pendingBackground(s, T0 + BG_MAX_MS + 1000), 1);
  assert.equal(pendingBackground(s, T0 + 2 * BG_MAX_MS + 120_000), 0);
});

test('async subagents are not background tasks; their own logs count them', () => {
  const s = run([
    { type: 'assistant', timestamp: iso(T0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_a', name: 'Agent', input: { description: 'watch' } }] } },
    { type: 'user', timestamp: iso(T0 + 50), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'Async agent launched successfully.' }] }, toolUseResult: { isAsync: true, agentId: 'a62', status: 'async_launched' } },
    endTurn(T0 + 100),
  ]);
  assert.equal(pendingBackground(s, T0 + 1000), 0);
});

test('a task launched longer ago than the cap no longer counts', () => {
  const s = run([...launchBash('old', T0), endTurn(T0 + 1000)]);
  assert.equal(pendingBackground(s, T0 + BG_MAX_MS - 1000), 1);
  assert.equal(pendingBackground(s, T0 + BG_MAX_MS + 1000), 0);
});

test('a done subagent with a pending task stays present while its parent is', () => {
  const NOW = T0 + 60_000;
  const parentLog = { ...newSession('claude', 'p', '/p.jsonl'), status: 'done', lastEventAt: T0 };
  const child = { ...run([...launchBash('bq3', T0), endTurn(T0 + 1000)]), id: 'agent-a62', subagent: true, parentId: 'p' };
  const feed = { sessions: [{ provider: 'claude', sessionId: 'p', state: 'done', running: true, updatedAt: iso(T0) }] };
  const out = mergeSessions([parentLog, child], feed, new Map(), NOW);
  const c = out.find((s) => s.id === 'agent-a62');
  assert.equal(c.alive, undefined);
  const idle = { ...child, bg: undefined };
  assert.equal(mergeSessions([parentLog, idle], feed, new Map(), NOW).find((s) => s.id === 'agent-a62').alive, false);
});

const s = (key, over = {}) => {
  const [agent, id] = key.split(':');
  return { key, agent, id, status: 'done', subagent: false, parentId: null, alive: true, ...over };
};
const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

test('a subagent waiting on its task works, and holds its parent at work', () => {
  const out = byKey(markDelegating([
    s('claude:p'),
    s('claude:k', { subagent: true, parentId: 'p', alive: undefined, bgTasks: 1 }),
  ]));
  assert.equal(out['claude:k'].status, 'tool');
  assert.equal(out['claude:k'].bgTasks, 1);
  assert.equal(out['claude:p'].status, 'tool');
  assert.equal(out['claude:p'].delegating, 1);
});

test('a parent waiting on its own task works with a count', () => {
  const out = byKey(markDelegating([s('claude:p', { bgTasks: 2 })]));
  assert.equal(out['claude:p'].status, 'tool');
  assert.equal(out['claude:p'].activity, null);
  assert.equal(out['claude:p'].bgTasks, 2);
  assert.equal(out['claude:p'].delegating, undefined);
});

test('ended, needs-you and interrupted sessions are not held by tasks', () => {
  const out = byKey(markDelegating([
    s('claude:e', { alive: false, bgTasks: 1 }),
    s('claude:w', { status: 'waiting', bgTasks: 1 }),
    s('claude:i', { status: 'interrupted', bgTasks: 1 }),
    s('claude:q'), s('claude:k', { subagent: true, parentId: 'q', alive: false, bgTasks: 1 }),
    s('claude:r'), s('claude:rw', { subagent: true, parentId: 'r', status: 'waiting', bgTasks: 1 }),
  ]));
  assert.deepEqual(['e', 'w', 'i', 'q', 'k', 'r'].map((k) => out[`claude:${k}`].status), ['done', 'waiting', 'interrupted', 'done', 'done', 'done']);
  assert.ok(Object.values(out).every((x) => x.bgTasks === undefined));
});

test('a working session with a task running keeps its own activity', () => {
  const out = byKey(markDelegating([s('claude:p', { status: 'thinking', bgTasks: 1 })]));
  assert.equal(out['claude:p'].status, 'thinking');
  assert.equal(out['claude:p'].bgTasks, undefined);
});

test('a log-only session silent past the tool decay window lets its task go', () => {
  const raw = (quiet) => ({
    sessions: () => [{ ...run([...launchBash('bq3', Date.now() - quiet - 1000), endTurn(Date.now() - quiet)]), lastEventAt: Date.now() - quiet }],
  });
  const one = (quiet) => snapshot(raw(quiet), { privacy: false, demo: true }).sessions[0];
  assert.equal(one(10 * 60_000).status, 'tool');
  assert.equal(one(10 * 60_000).bgTasks, 1);
  assert.equal(one(50 * 60_000).status, 'done');
});
