import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS, MINE_SORT_KEYS, DEFAULT_SORT, normalizeSort, toggleSort, sortRows, groupStacks, hasStacks, stackChildKeys } from '../src/sort.js';

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
  assert.deepEqual(SORT_KEYS, ['repo', 'number', 'title', 'labels', 'branch', 'date', 'review', 'updated', 'approvals', 'author', 'diff', 'files', 'status', 'triggers', 'ci']);
});

test('normalizeSort with MINE_SORT_KEYS: every column except author, the rest → default', () => {
  assert.deepEqual(MINE_SORT_KEYS, SORT_KEYS.filter((k) => k !== 'author'));
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
  // files → fewest changed files first (the quick reviews, like diff)
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'files'), { key: 'files', dir: 'asc' });
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

test('sortRows: repo/title/branch alphabetical, case-insensitive; missing at the end', () => {
  const withText = [
    { number: 1, repo: 'o/b', title: 'Zulu', branch: 'feat/x' },
    { number: 2, repo: 'O/a', title: 'alpha', branch: null },
    { number: 3, repo: null, title: 'Mike', branch: 'Chore/y' },
  ];
  assert.deepEqual(order(sortRows(withText, { key: 'repo', dir: 'asc' })), [2, 1, 3]);
  assert.deepEqual(order(sortRows(withText, { key: 'title', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withText, { key: 'branch', dir: 'asc' })), [3, 1, 2]);
});

test('sortRows: labels alphabetical on the names (case-insensitive), no label → missing at the end', () => {
  const withLabels = [
    { number: 1, labels: [{ name: 'Zebra', color: 'ededed' }] },
    { number: 2, labels: [] },
    { number: 3, labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'urgent', color: 'ff0000' }] },
    { number: 4, labels: [{ name: 'bug', color: 'd73a4a' }] }, // same 1st label as #3: joined names break the tie
  ];
  assert.deepEqual(order(sortRows(withLabels, { key: 'labels', dir: 'asc' })), [4, 3, 1, 2]);
  assert.deepEqual(order(sortRows(withLabels, { key: 'labels', dir: 'desc' })), [1, 3, 4, 2]);
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'labels'), { key: 'labels', dir: 'asc' });
});

test('sortRows: number desc (default) → highest PR number first', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'number', dir: 'desc' })), [3, 2, 1]);
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'number'), { key: 'number', dir: 'desc' });
});

test('sortRows: ci asc → failing first, then pending, then green; none/absent at the end', () => {
  const withCi = [
    { number: 1, ci: 'pass' },
    { number: 2, ci: 'fail' },
    { number: 3, ci: 'none' },
    { number: 4, ci: 'pending' },
  ];
  assert.deepEqual(order(sortRows(withCi, { key: 'ci', dir: 'asc' })), [2, 4, 1, 3]);
  assert.deepEqual(order(sortRows(withCi, { key: 'ci', dir: 'desc' })), [1, 4, 2, 3]);
});

test('sortRows: triggers ranked semantically (most important trigger of the row), empty at the end', () => {
  const withTriggers = [
    { number: 1, triggers: ['activity'] },
    { number: 2, triggers: ['comment', 'review'] }, // review dominates
    { number: 3, triggers: ['reply'] },
    { number: 4, triggers: [] },
  ];
  assert.deepEqual(order(sortRows(withTriggers, { key: 'triggers', dir: 'asc' })), [2, 3, 1, 4]);
});

test('sortRows: diff = additions ONLY (deletions ignored; asc → fewest added lines first)', () => {
  const withDiff = [
    { number: 1, additions: 500, deletions: 10 },   // bigger than #3 despite a smaller total
    { number: 2, additions: 0, deletions: 0 },      // 0: a real value, not missing
    { number: 3, additions: 100, deletions: 1000 }, // a big deletion is not a big review
  ];
  assert.deepEqual(order(sortRows(withDiff, { key: 'diff', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withDiff, { key: 'diff', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows: diff missing (no additions counter) at the END whatever the direction', () => {
  const withNulls = [
    { number: 1, deletions: 9 },                    // no additions → missing
    { number: 2, additions: 10, deletions: 0 },
    { number: 3, additions: 0, deletions: 5 },      // 0 added lines is a real value
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

test('sortRows: review asc → longest in review first (readyAt, fallback createdAt)', () => {
  const inReview = [
    { number: 1, state: 'open', createdAt: '2026-07-01T00:00:00Z', readyAt: '2026-07-25T00:00:00Z' }, // long draft, ready recently
    { number: 2, state: 'open', createdAt: '2026-07-20T00:00:00Z' },                                  // never draft → createdAt
    { number: 3, state: 'draft', createdAt: '2026-06-01T00:00:00Z' },                                 // not in review → missing, at the end
    { number: 4, state: 'merged', createdAt: '2026-06-02T00:00:00Z', readyAt: '2026-06-03T00:00:00Z' },
  ];
  assert.deepEqual(order(sortRows(inReview, { key: 'review', dir: 'asc' })), [2, 1, 3, 4]);
  assert.deepEqual(order(sortRows(inReview, { key: 'review', dir: 'desc' })), [1, 2, 3, 4]);
  assert.deepEqual(order(sortRows(inReview, { key: 'review', dir: 'asc' }, MINE_SORT_KEYS)), [2, 1, 3, 4]);
  // First click default: the ones waiting the most first.
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'review'), { key: 'review', dir: 'asc' });
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

// ---- groupStacks (stacked PRs) ----
// Fixture: a repo with main as default branch. #10 is a root (base = main),
// #11 is stacked on #10 (base = #10's head), #12 is independent.
const stackRows = () => [
  { repo: 'o/a', number: 12, branch: 'feat/solo', base: 'main', defaultBranch: 'main' },
  { repo: 'o/a', number: 11, branch: 'feat/child', base: 'feat/parent', defaultBranch: 'main' },
  { repo: 'o/a', number: 10, branch: 'feat/parent', base: 'main', defaultBranch: 'main' },
];

test('groupStacks: no stack → order unchanged, no annotation', () => {
  const input = [
    { repo: 'o/a', number: 1, branch: 'f1', base: 'main', defaultBranch: 'main' },
    { repo: 'o/b', number: 2, branch: 'f2', base: 'main', defaultBranch: 'main' },
  ];
  const out = groupStacks(input);
  assert.deepEqual(order(out), [1, 2]);
  assert.ok(out.every((r) => r.stackDepth === undefined));
});

test('groupStacks: stacks come FIRST (root on top), the non-stacked rows below', () => {
  // canonical stacked view, no sort semantics: each block root-first, then
  // the solo rows in their incoming order.
  const out = groupStacks(stackRows());
  assert.deepEqual(order(out), [10, 11, 12]);
  assert.equal(out[0].stackDepth, undefined); // root
  assert.equal(out[1].stackDepth, 1);         // child, under its root
  assert.equal(out[2].stackDepth, undefined); // solo, below the stacks
});

test('groupStacks: does not mutate the input rows', () => {
  const input = stackRows();
  groupStacks(input);
  assert.ok(input.every((r) => r.stackDepth === undefined));
});

test('groupStacks: 3-level stack → chain order root → leaf, whatever the incoming order', () => {
  const out = groupStacks([
    { repo: 'o/a', number: 20, branch: 'l0', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 22, branch: 'l2', base: 'l1', defaultBranch: 'main' },
    { repo: 'o/a', number: 21, branch: 'l1', base: 'l0', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out), [20, 21, 22]);
  const byNum = Object.fromEntries(out.map((r) => [r.number, r]));
  assert.equal(byNum[20].stackDepth, undefined);
  assert.equal(byNum[21].stackDepth, 1);
  assert.equal(byNum[22].stackDepth, 2);
});

test('groupStacks: two siblings keep their incoming order under their root', () => {
  const out = groupStacks([
    { repo: 'o/a', number: 31, branch: 'c1', base: 'p', defaultBranch: 'main' },
    { repo: 'o/a', number: 30, branch: 'p', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 32, branch: 'c2', base: 'p', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out), [30, 31, 32]);
});

test('groupStacks: parent absent from the table → no link, no reordering, no annotation (the base chip is a render rule)', () => {
  const rows = [
    { repo: 'o/a', number: 40, branch: 'f', base: 'feat/gone', defaultBranch: 'main' },
    { repo: 'o/a', number: 41, branch: 'g', base: 'main', defaultBranch: 'main' },
  ];
  const out = groupStacks(rows);
  assert.deepEqual(order(out), [40, 41]);
  assert.ok(out.every((r) => r.stackDepth === undefined && r.inStack === undefined && !('orphanBase' in r)));
  assert.equal(hasStacks(rows), false);
});

test('groupStacks: same branch name in another repo does not match', () => {
  const out = groupStacks([
    { repo: 'o/b', number: 60, branch: 'feat/parent', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 61, branch: 'x', base: 'feat/parent', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out), [60, 61]);
  assert.equal(out[1].stackDepth, undefined);
});

test('groupStacks: a fork-hosted head branch is not a stack parent', () => {
  // #70's head lives on a fork: a base ref « feat/parent » in o/a cannot be it.
  const out = groupStacks([
    { repo: 'o/a', number: 70, branch: 'feat/parent', branchRepo: 'fork/a', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 71, branch: 'x', base: 'feat/parent', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out), [70, 71]);
  assert.equal(out[1].stackDepth, undefined);
});

test('groupStacks: defensive on a base cycle — every row emitted once, no hang', () => {
  const out = groupStacks([
    { repo: 'o/a', number: 80, branch: 'a', base: 'b', defaultBranch: 'main' },
    { repo: 'o/a', number: 81, branch: 'b', base: 'a', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out).sort(), [80, 81]);
});

test('hasStacks: true only if a parent/child link exists in the rows', () => {
  assert.equal(hasStacks(stackRows()), true);
  assert.equal(hasStacks([
    { repo: 'o/a', number: 1, branch: 'f1', base: 'main', defaultBranch: 'main' },
    { repo: 'o/b', number: 2, branch: 'f2', base: 'main', defaultBranch: 'main' },
  ]), false);
  assert.equal(hasStacks([]), false);
  assert.equal(hasStacks(null), false);
});

test('hasStacks: an orphan (parent absent) is not enough to show the toggle', () => {
  assert.equal(hasStacks([
    { repo: 'o/a', number: 40, branch: 'f', base: 'feat/gone', defaultBranch: 'main' },
  ]), false);
});

test('groupStacks: every row of a stack (parent included) is flagged for the block background', () => {
  const out = groupStacks(stackRows());
  const byNum = Object.fromEntries(out.map((r) => [r.number, r]));
  assert.equal(byNum[10].inStack, true, 'parent flagged');
  assert.equal(byNum[11].stackDepth, 1, 'child carries its depth');
  assert.equal(byNum[12].inStack, undefined, 'solo row untouched');
});

test('groupStacks: each block gets its own stackIndex (parent and children alike)', () => {
  const out = groupStacks([
    { repo: 'o/a', number: 30, branch: 'p1', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 31, branch: 'c1', base: 'p1', defaultBranch: 'main' },
    { repo: 'o/a', number: 40, branch: 'p2', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 41, branch: 'c2', base: 'p2', defaultBranch: 'main' },
    { repo: 'o/a', number: 50, branch: 'solo', base: 'main', defaultBranch: 'main' },
  ]);
  const byNum = Object.fromEntries(out.map((r) => [r.number, r]));
  assert.equal(byNum[30].stackIndex, 0);
  assert.equal(byNum[31].stackIndex, 0);
  assert.equal(byNum[40].stackIndex, 1);
  assert.equal(byNum[41].stackIndex, 1);
  assert.equal(byNum[50].stackIndex, undefined, 'solo row: no block');
});

test('groupStacks: root always on top → never a stackUp flag (single ↳ marker)', () => {
  const out = groupStacks(stackRows());
  assert.ok(out.every((r) => r.stackUp === undefined));
});

test('groupStacks: a branched block (a parent with 2 children) is flagged stackBranched', () => {
  // A ← B ← (C ← D, E ← F): branching at B → per-depth indent needed.
  const out = groupStacks([
    { repo: 'o/a', number: 1, branch: 'a', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 2, branch: 'b', base: 'a', defaultBranch: 'main' },
    { repo: 'o/a', number: 3, branch: 'c', base: 'b', defaultBranch: 'main' },
    { repo: 'o/a', number: 4, branch: 'd', base: 'c', defaultBranch: 'main' },
    { repo: 'o/a', number: 5, branch: 'e', base: 'b', defaultBranch: 'main' },
    { repo: 'o/a', number: 6, branch: 'f', base: 'e', defaultBranch: 'main' },
  ]);
  assert.deepEqual(order(out), [1, 2, 3, 4, 5, 6]); // DFS: the E branch after the C one
  const byNum = Object.fromEntries(out.map((r) => [r.number, r]));
  assert.deepEqual([byNum[3].stackDepth, byNum[5].stackDepth], [2, 2], 'C and E are siblings in depth');
  assert.ok(out.filter((r) => r.stackDepth).every((r) => r.stackBranched === true), 'children flagged');
});

test('groupStacks: a LINEAR chain is never flagged stackBranched (single indent stays)', () => {
  const out = groupStacks([
    { repo: 'o/a', number: 1, branch: 'a', base: 'main', defaultBranch: 'main' },
    { repo: 'o/a', number: 2, branch: 'b', base: 'a', defaultBranch: 'main' },
    { repo: 'o/a', number: 3, branch: 'c', base: 'b', defaultBranch: 'main' },
  ]);
  assert.ok(out.every((r) => r.stackBranched === undefined));
});

test('sortRows: files = changedFiles (asc → fewest first), missing at the END whatever the direction', () => {
  const rows = [
    { number: 1, changedFiles: 12 },
    { number: 2 },                    // older snapshot: no count → missing
    { number: 3, changedFiles: 0 },   // 0 is a real value
    { number: 4, changedFiles: 3 },
  ];
  assert.deepEqual(order(sortRows(rows, { key: 'files', dir: 'asc' })), [3, 4, 1, 2]);
  assert.deepEqual(order(sortRows(rows, { key: 'files', dir: 'desc' })), [1, 4, 3, 2]);
  assert.deepEqual(order(sortRows(rows, { key: 'files', dir: 'asc' }, MINE_SORT_KEYS)), [3, 4, 1, 2]);
});

test('stackChildKeys: keys (repo#number) of the rows whose parent is in the table, depth-first', () => {
  const parent = { repo: 'o/r', number: 1, branch: 'p', base: 'main', defaultBranch: 'main' };
  const child = { repo: 'o/r', number: 2, branch: 'c', base: 'p', defaultBranch: 'main' };
  const grandchild = { repo: 'o/r', number: 3, branch: 'g', base: 'c', defaultBranch: 'main' };
  const solo = { repo: 'o/r', number: 4, branch: 's', base: 'main', defaultBranch: 'main' };
  const orphan = { repo: 'o/r', number: 5, branch: 'x', base: 'gone', defaultBranch: 'main' };
  assert.deepEqual(stackChildKeys([grandchild, solo, child, parent, orphan]), ['o/r#2', 'o/r#3']);
  assert.deepEqual(stackChildKeys([solo, orphan]), []); // an orphan alone is not a stack
  assert.deepEqual(stackChildKeys([]), []);
  assert.deepEqual(stackChildKeys(undefined), []);
});
