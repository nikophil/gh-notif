import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS, MINE_SORT_KEYS, DEFAULT_SORT, normalizeSort, toggleSort, sortRows } from '../src/sort.js';

// Fixtures: 3 PRs with all-distinct values (author deliberately with mixed case
// to test case-insensitivity; updatedAt deliberately in an order ≠ createdAt).
const rows = () => [
  { repo: 'o/a', number: 1, author: 'zoe', createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z', approvals: 2 },
  { repo: 'o/b', number: 2, author: 'Alice', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-23T00:00:00Z', approvals: 0 },
  { repo: 'o/c', number: 3, author: 'bob', createdAt: '2026-07-21T00:00:00Z', updatedAt: '2026-07-24T00:00:00Z', approvals: 1 },
];
const order = (list) => list.map((r) => r.number);

test('normalizeSort: valid passes, invalid/absent → default', () => {
  assert.deepEqual(normalizeSort({ key: 'author', dir: 'asc' }), { key: 'author', dir: 'asc' });
  assert.deepEqual(normalizeSort(null), DEFAULT_SORT);
  assert.deepEqual(normalizeSort(undefined), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'nope', dir: 'asc' }), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'date', dir: 'sideways' }), DEFAULT_SORT);
  assert.deepEqual(DEFAULT_SORT, { key: 'updated', dir: 'desc' });
  assert.deepEqual(SORT_KEYS, ['date', 'updated', 'approvals', 'author', 'diff', 'status']);
});

test('normalizeSort with MINE_SORT_KEYS: only date/updated/diff/status valid, the rest → default', () => {
  assert.deepEqual(MINE_SORT_KEYS, ['date', 'updated', 'diff', 'status']);
  assert.ok(MINE_SORT_KEYS.includes(DEFAULT_SORT.key), 'the shared default must stay valid for mine');
  assert.deepEqual(normalizeSort({ key: 'date', dir: 'asc' }, MINE_SORT_KEYS), { key: 'date', dir: 'asc' });
  assert.deepEqual(normalizeSort({ key: 'author', dir: 'asc' }, MINE_SORT_KEYS), DEFAULT_SORT);
  assert.deepEqual(normalizeSort(null, MINE_SORT_KEYS), DEFAULT_SORT);
});

test('normalizeSort returns a copy (never DEFAULT_SORT itself)', () => {
  const s = normalizeSort(null);
  s.dir = 'asc';
  assert.equal(DEFAULT_SORT.dir, 'desc'); // not polluted by the mutation
});

test('toggleSort: same column → flip the direction', () => {
  assert.deepEqual(toggleSort({ key: 'date', dir: 'desc' }, 'date'), { key: 'date', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'date'), { key: 'date', dir: 'desc' });
});

test('toggleSort: other column → REPLACES, with the column default direction', () => {
  // date → newest first; approvals → least approved first; author → A→Z;
  // diff → smallest first (the quick reviews)
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'approvals'), { key: 'approvals', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'approvals', dir: 'desc' }, 'author'), { key: 'author', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'author', dir: 'desc' }, 'date'), { key: 'date', dir: 'desc' });
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'diff'), { key: 'diff', dir: 'asc' });
  // status → actionable first (open before draft before merged/closed)
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'status'), { key: 'status', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'status', dir: 'asc' }, 'status'), { key: 'status', dir: 'desc' });
});

test('sortRows: date desc → newest opened first; asc → reverse', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'asc' })), [1, 3, 2]);
});

test('sortRows: updated desc (default) → last-touched first; asc → reverse', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'updated', dir: 'desc' })), [1, 3, 2]);
  assert.deepEqual(order(sortRows(rows(), { key: 'updated', dir: 'asc' })), [2, 3, 1]);
});

test('sortRows: approvals asc → least approved first', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows: diff = additions + deletions (asc → smallest first)', () => {
  const withDiff = [
    { number: 1, additions: 100, deletions: 50 },  // 150
    { number: 2, additions: 0, deletions: 0 },     // 0: a real value, not missing
    { number: 3, additions: 3, deletions: 40 },    // 43
  ];
  assert.deepEqual(order(sortRows(withDiff, { key: 'diff', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withDiff, { key: 'diff', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows: diff missing (both counters absent) at the END whatever the direction', () => {
  const withNulls = [
    { number: 1 },                                  // no additions/deletions → missing
    { number: 2, additions: 10, deletions: 0 },
    { number: 3, additions: 0, deletions: 5 },      // a lone counter counts as 0
  ];
  assert.deepEqual(order(sortRows(withNulls, { key: 'diff', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'diff', dir: 'desc' })), [2, 3, 1]);
});

test('sortRows: diff valid with MINE_SORT_KEYS too', () => {
  const withDiff = [
    { number: 1, additions: 9, deletions: 9 },
    { number: 2, additions: 1, deletions: 0 },
  ];
  assert.deepEqual(order(sortRows(withDiff, { key: 'diff', dir: 'asc' }, MINE_SORT_KEYS)), [2, 1]);
});

test('sortRows: status asc → open, draft, merged, closed (actionable first)', () => {
  const withStates = [
    { number: 1, state: 'closed' },
    { number: 2, state: 'open' },
    { number: 3, state: 'merged' },
    { number: 4, state: 'draft' },
  ];
  assert.deepEqual(order(sortRows(withStates, { key: 'status', dir: 'asc' })), [2, 4, 3, 1]);
  assert.deepEqual(order(sortRows(withStates, { key: 'status', dir: 'desc' })), [1, 3, 4, 2]);
});

test('sortRows: status missing or unknown at the END whatever the direction', () => {
  const withNulls = [
    { number: 1 },                    // no state → missing
    { number: 2, state: 'weird' },    // unknown state → missing too
    { number: 3, state: 'merged' },
    { number: 4, state: 'open' },
  ];
  assert.deepEqual(order(sortRows(withNulls, { key: 'status', dir: 'asc' })), [4, 3, 1, 2]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'status', dir: 'desc' })), [3, 4, 1, 2]);
});

test('sortRows: status valid with MINE_SORT_KEYS too', () => {
  const withStates = [
    { number: 1, state: 'draft' },
    { number: 2, state: 'open' },
  ];
  assert.deepEqual(order(sortRows(withStates, { key: 'status', dir: 'asc' }, MINE_SORT_KEYS)), [2, 1]);
});

test('sortRows: author case-insensitive (Alice < bob < zoe)', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows: missing values at the END whatever the direction', () => {
  const withNulls = [
    { number: 1, author: null, createdAt: null, updatedAt: null, approvals: 0 },
    { number: 2, author: 'bob', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-23T00:00:00Z', approvals: 1 },
    { number: 3, author: 'alice', createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z', approvals: 2 },
  ];
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'updated', dir: 'desc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'updated', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'desc' })), [2, 3, 1]);
});

test('sortRows: equality → arrival order preserved (stable)', () => {
  const ties = [
    { number: 1, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 2, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 3, approvals: 1, author: 'a', createdAt: 'x' },
  ];
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'asc' })), [1, 2, 3]);
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'desc' })), [1, 2, 3]);
});

test('sortRows: does not mutate the input, tolerates null/undefined', () => {
  const input = rows();
  const before = order(input);
  sortRows(input, { key: 'date', dir: 'asc' });
  assert.deepEqual(order(input), before);
  assert.deepEqual(sortRows(null, DEFAULT_SORT), []);
  assert.deepEqual(sortRows(undefined, DEFAULT_SORT), []);
});

test('sortRows: invalid sort → default sort (updated desc), no crash', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'nope' })), [1, 3, 2]);
});

test('sortRows with MINE_SORT_KEYS: an out-of-set key falls back to the default', () => {
  // 'author' is valid for others but not for mine → updated desc.
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'asc' }, MINE_SORT_KEYS)), [1, 3, 2]);
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'asc' }, MINE_SORT_KEYS)), [1, 3, 2]);
});
