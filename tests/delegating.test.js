'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, markDelegating } = require('../src/server');

const now = Date.now();
const s = (key, over = {}) => {
  const [agent, id] = key.split(':');
  return { key, agent, id, status: 'done', subagent: false, parentId: null, alive: true, ...over };
};
const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

test('a done or idle parent with a busy child keeps working with a count', () => {
  const out = byKey(markDelegating([
    s('claude:p'),
    s('claude:q', { status: 'idle' }),
    s('claude:k1', { subagent: true, parentId: 'p', status: 'tool', alive: undefined }),
    s('claude:k2', { subagent: true, parentId: 'p', status: 'thinking', alive: undefined }),
    s('codex:x', { subagent: true, parentId: 'q', spawnedBy: 'claude', status: 'typing' }),
  ]));
  assert.equal(out['claude:p'].status, 'tool');
  assert.equal(out['claude:p'].delegating, 2);
  assert.equal(out['claude:p'].activity, null);
  assert.equal(out['claude:q'].status, 'tool');
  assert.equal(out['claude:q'].delegating, 1);
});

test('finished, ended or needs-you cases are left alone', () => {
  const out = byKey(markDelegating([
    s('claude:a'), s('claude:a1', { subagent: true, parentId: 'a', status: 'done' }),
    s('claude:b'), s('codex:b1', { subagent: true, parentId: 'b', spawnedBy: 'claude', status: 'tool', alive: false }),
    s('claude:c', { status: 'waiting' }), s('claude:c1', { subagent: true, parentId: 'c', status: 'tool' }),
    s('claude:d', { status: 'interrupted' }), s('claude:d1', { subagent: true, parentId: 'd', status: 'tool' }),
    s('claude:e', { alive: false }), s('codex:e1', { subagent: true, parentId: 'e', spawnedBy: 'claude', status: 'tool' }),
  ]));
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((k) => out[`claude:${k}`].status), ['done', 'done', 'waiting', 'interrupted', 'done']);
  assert.ok(['a', 'b', 'c', 'd', 'e'].every((k) => out[`claude:${k}`].delegating === undefined));
});

test('self and cyclic links cannot hold sessions at work', () => {
  const out = byKey(markDelegating([
    s('claude:self', { subagent: true, parentId: 'self', status: 'done' }),
    s('claude:m', { subagent: true, parentId: 'n' }),
    s('claude:n', { subagent: true, parentId: 'm' }),
  ]));
  assert.deepEqual(['self', 'm', 'n'].map((k) => out[`claude:${k}`].status), ['done', 'done', 'done']);
});

test('a crashed child stops holding its parent once view() decays it', () => {
  const raw = (child) => ({
    sessions: () => [
      { agent: 'claude', id: 'p', status: 'done', lastEventAt: now - 1000 },
      { agent: 'claude', id: 'k', subagent: true, parentId: 'p', ...child },
    ],
  });
  const parent = (child) => snapshot(raw(child), { privacy: false, demo: true }).sessions.find((x) => x.id === 'p');
  assert.equal(parent({ status: 'tool', lastEventAt: now - 60_000 }).status, 'tool');
  assert.equal(parent({ status: 'tool', lastEventAt: now - 46 * 60_000 }).status, 'done');
  assert.equal(parent({ status: 'thinking', lastEventAt: now - 16 * 60_000 }).status, 'done');
  assert.equal(parent({ status: 'typing', lastEventAt: now - 46_000 }).status, 'done');
});
