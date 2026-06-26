import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalsOf, approvalKey, isReady, newApprovals, READY_THRESHOLD } from '../src/approvals.js';

test('approvalsOf : reviewers dont la dernière review est APPROVED (login + submittedAt)', () => {
  assert.deepEqual(approvalsOf(undefined), []);
  assert.deepEqual(approvalsOf([]), []);

  // COMMENTED ignoré, APPROVED gardé
  assert.deepEqual(
    approvalsOf([
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
    ]),
    [{ login: 'alice', submittedAt: '2026-06-20T10:00:00Z' }],
  );

  // approbation annulée par une review ultérieure du même user → ne compte plus
  assert.deepEqual(
    approvalsOf([
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-21T10:00:00Z' },
    ]),
    [],
  );

  // deux reviewers distincts APPROVED (on garde le submittedAt de la review la plus récente)
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

test('approvalKey : clé stable repo#number:login:submittedAt', () => {
  assert.equal(
    approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z'),
    'o/r#42:alice:2026-06-20T10:00:00Z',
  );
  // deux clés différentes pour deux reviewers de la même PR
  assert.notEqual(
    approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z'),
    approvalKey('o/r', 42, 'bob', '2026-06-20T10:00:00Z'),
  );
});

test('isReady : ≥ READY_THRESHOLD (2)', () => {
  assert.equal(READY_THRESHOLD, 2);
  assert.equal(isReady(0), false);
  assert.equal(isReady(1), false);
  assert.equal(isReady(2), true);
  assert.equal(isReady(3), true);
});

test('newApprovals : renvoie les évènements absents du Set, sans muter le Set', () => {
  const events = [
    { repo: 'o/r', number: 42, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
    { repo: 'o/r', number: 42, actor: 'bob', submittedAt: '2026-06-21T12:00:00Z' },
  ];
  const seen = new Set([approvalKey('o/r', 42, 'alice', '2026-06-20T10:00:00Z')]);

  const fresh = newApprovals(events, seen);
  assert.deepEqual(fresh, [events[1]]); // alice déjà vue, bob nouveau
  assert.equal(seen.size, 1); // pas de mutation
});

test('newApprovals : tout est nouveau face à un Set vide', () => {
  const events = [
    { repo: 'o/r', number: 1, actor: 'alice', submittedAt: '2026-06-20T10:00:00Z' },
  ];
  assert.deepEqual(newApprovals(events, new Set()), events);
});
