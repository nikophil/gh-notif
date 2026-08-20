import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, signatureOf, isHidden, toggleHidden, reconcile, assignLabels } from '../src/hidden.js';

// NB: `category` carries the values of CATEGORY (filter.js): thread_reply / on_my_pr / mention.
const items = [
  { category: 'thread_reply', repo: 'o/r', number: 42, url: 'u1' },
  { category: 'mention', repo: 'o/r', number: 42, url: 'u2' },
  { category: 'review_request', repo: 'o/r', number: 42, url: 'pr-url' }, // ignored (not a trigger)
  { category: 'on_my_pr', repo: 'o/x', number: 7, url: 'u3' },
];

test('keyOf', () => {
  assert.equal(keyOf({ repo: 'o/r', number: 42 }), 'o/r#42');
});

test('signatureOf: URLs of the PR trigger items (review_request excluded)', () => {
  assert.deepEqual(signatureOf('o/r#42', items).sort(), ['u1', 'u2']);
  assert.deepEqual(signatureOf('o/x#7', items), ['u3']);
  assert.deepEqual(signatureOf('o/none#1', items), []);
});

test('toggleHidden: hides with snapshot then restores', () => {
  const map = {};
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#42'), true);
  assert.deepEqual(map['o/r#42'].seen.sort(), ['u1', 'u2']);
  assert.equal(map['o/r#42'].at, '2026-06-25T00:00:00.000Z');
  // re-toggle → restores
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T01:00:00.000Z'), false);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile: un-hides on new trigger, keeps if signature unchanged', () => {
  const map = { 'o/r#42': { at: 'x', seen: ['u1', 'u2'] } };
  const entries = [{ repo: 'o/r', number: 42 }];
  // signature unchanged → stays hidden, no change
  assert.equal(reconcile(map, entries, items), false);
  assert.equal(isHidden(map, 'o/r#42'), true);
  // new event u9 → un-hides
  const items2 = [...items, { category: 'thread_reply', repo: 'o/r', number: 42, url: 'u9' }];
  assert.equal(reconcile(map, entries, items2), true);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile: empty signature stays hidden (pending review without interaction)', () => {
  const map = { 'o/r#60': { at: 'x', seen: [] } };
  const entries = [{ repo: 'o/r', number: 60 }];
  assert.equal(reconcile(map, entries, []), false);
  assert.equal(isHidden(map, 'o/r#60'), true);
});

// Regression (issue #1): a poll is a partial sample. An absence dates the key,
// it never deletes it on the spot — otherwise the signature is lost for good
// and the PR comes back visible.
const OTHER = [{ repo: 'o/r', number: 1 }];

test('reconcile: an absence dates the key but keeps it hidden', () => {
  const map = { 'o/r#99': { at: 'x', seen: [] } };
  assert.equal(reconcile(map, OTHER, [], '2026-08-20T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#99'), true, 'still hidden');
  assert.equal(map['o/r#99'].missingSince, '2026-08-20T00:00:00.000Z');
  assert.deepEqual(map['o/r#99'].seen, [], 'signature preserved');
});

test('reconcile: a repeated absence does not re-date (no write churn)', () => {
  const map = { 'o/r#99': { at: 'x', seen: [], missingSince: '2026-08-20T00:00:00.000Z' } };
  assert.equal(reconcile(map, OTHER, [], '2026-08-21T00:00:00.000Z'), false, 'nothing changed');
  assert.equal(map['o/r#99'].missingSince, '2026-08-20T00:00:00.000Z');
});

test('reconcile: reappearing resets the countdown', () => {
  const map = { 'o/r#99': { at: 'x', seen: [], missingSince: '2026-08-20T00:00:00.000Z' } };
  assert.equal(reconcile(map, [{ repo: 'o/r', number: 99 }], [], '2026-08-21T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#99'), true);
  assert.equal(map['o/r#99'].missingSince, undefined, 'countdown cleared');
});

test('reconcile: purges after 30 days of uninterrupted absence', () => {
  const map = { 'o/r#99': { at: 'x', seen: [], missingSince: '2026-06-01T00:00:00.000Z' } };
  // 29 days: kept
  assert.equal(reconcile(map, OTHER, [], '2026-06-30T00:00:00.000Z'), false);
  assert.equal(isHidden(map, 'o/r#99'), true);
  // 31 days: purged
  assert.equal(reconcile(map, OTHER, [], '2026-07-02T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#99'), false);
});

test('assignLabels: the label is the PR number', () => {
  const rows = [{ repo: 'o/r', number: 7004 }, { repo: 'o/x', number: 388 }];
  assert.deepEqual(assignLabels(rows), ['7004', '388']);
});
