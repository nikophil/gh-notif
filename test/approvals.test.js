import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalsOf, approvalKey, isReady, newApprovals, diffApprovals, READY_THRESHOLD } from '../src/approvals.js';

test('approvalsOf: reviewers whose latest review is APPROVED (login + submittedAt)', () => {
  assert.deepEqual(approvalsOf(undefined), []);
  assert.deepEqual(approvalsOf([]), []);

  // COMMENTED ignored, APPROVED kept
  assert.deepEqual(
    approvalsOf([
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
    ]),
    [{ login: 'alice', submittedAt: '2026-06-20T10:00:00Z' }],
  );

  // approval cancelled by a later review from the same user → no longer counts
  assert.deepEqual(
    approvalsOf([
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-21T10:00:00Z' },
    ]),
    [],
  );

  // two distinct reviewers APPROVED (we keep the submittedAt of the most recent review)
  assert.deepEqual(
    approvalsOf([
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-21T10:00:00Z' },
      { author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-06-21T12:00:00Z' },
    ]),
    [
      { login: 'alice', submittedAt: '2026-06-21T10:00:00Z' },
      { login: 'bob', submittedAt: '2026-06-21T12:00:00Z' },
    ],
  );
});

test('approvalKey: stable key repo#number:login:submittedAt', () => {
  assert.equal(
    approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z'),
    'o/r#42:alice:2026-06-20T10:00:00Z',
  );
  // two different keys for two reviewers of the same PR
  assert.notEqual(
    approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z'),
    approvalKey('o/r', 42, 'bob', '2026-06-20T10:00:00Z'),
  );
});

test('isReady: ≥ READY_THRESHOLD (2)', () => {
  assert.equal(READY_THRESHOLD, 2);
  assert.equal(isReady(0), false);
  assert.equal(isReady(1), false);
  assert.equal(isReady(2), true);
  assert.equal(isReady(3), true);
});

test('newApprovals: returns the events absent from the Set, without mutating the Set', () => {
  const events = [
    { repo: 'o/r', number: 42, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
    { repo: 'o/r', number: 42, actor: 'bob', submittedAt: '2026-06-21T12:00:00Z' },
  ];
  const seen = new Set([approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z')]);

  const fresh = newApprovals(events, seen);
  assert.deepEqual(fresh, [events[1]]); // alice already seen, bob new
  assert.equal(seen.size, 1); // no mutation
});

test('newApprovals: everything is new against an empty Set', () => {
  const events = [
    { repo: 'o/r', number: 1, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
  ];
  assert.deepEqual(newApprovals(events, new Set()), events);
});

test('diffApprovals: 1st poll (not primed) → silent priming, nothing to notify', () => {
  const events = [
    { repo: 'o/r', number: 42, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
    { repo: 'o/r', number: 42, actor: 'bob', submittedAt: '2026-06-21T12:00:00Z' },
  ];
  const seen = new Set();
  const fresh = diffApprovals({ events, seen, primed: false });
  assert.deepEqual(fresh, []);       // no burst at startup
  assert.equal(seen.size, 2);        // everything memorized
});

test('diffApprovals: subsequent poll → only the new ones surface, and are memorized', () => {
  const events = [
    { repo: 'o/r', number: 42, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
    { repo: 'o/r', number: 42, actor: 'bob', submittedAt: '2026-06-21T12:00:00Z' },
  ];
  const seen = new Set([approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z')]);
  const fresh = diffApprovals({ events, seen, primed: true });
  assert.deepEqual(fresh.map((e) => e.actor), ['bob']);
  assert.equal(seen.size, 2);        // bob now memorized
  // identical re-poll → nothing left
  assert.deepEqual(diffApprovals({ events, seen, primed: true }), []);
});
