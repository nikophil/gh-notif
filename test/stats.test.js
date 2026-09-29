import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthKeys, monthRange, isMonthFinal, needsFetch, splitRange, datasetQueries, compactPR,
  collectStats, computeStats, median, STATS_TTL_MS, SCHEMA, quantile, compactUnmerged, needsFetchUnmerged, unmergedQueries, periodKeys, periodOptions, isValidPeriod, rankOf, firstPRYear, needsFirstYear, monthsToFetch,
} from '../src/stats.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');

test('monthKeys: the current month + the 11 before, oldest first (always 12)', () => {
  const keys = monthKeys(NOW);
  assert.equal(keys.length, 12);
  assert.equal(keys[0], '2025-10');
  assert.equal(keys[11], '2026-09');
  assert.deepEqual(monthKeys(Date.parse('2026-01-15T00:00:00Z')).slice(0, 2), ['2025-02', '2025-03'], 'year wrap');
});

test('monthRange: inclusive first..last day (leap February)', () => {
  assert.deepEqual(monthRange('2026-09'), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(monthRange('2028-02'), ['2028-02-01', '2028-02-29']);
});

test('isMonthFinal / needsFetch: a past month fetched after its end + 1 day is final', () => {
  const after = Date.parse('2026-09-02T00:00:00Z');
  assert.ok(isMonthFinal('2026-08', after));
  assert.ok(!isMonthFinal('2026-08', Date.parse('2026-08-31T23:00:00Z')), 'fetched during the month');
  assert.ok(!needsFetch({ fetchedAt: after, count: 3, schema: SCHEMA, prs: [] }, '2026-08', NOW, { force: true }), 'final: even 🔄 skips it');
  assert.ok(needsFetch(undefined, '2026-08', NOW), 'missing');
  assert.ok(needsFetch({ fetchedAt: after, prs: [] }, '2026-08', NOW), 'no count = predates the completeness check');
  assert.ok(needsFetch({ fetchedAt: after, count: 3, schema: SCHEMA, incomplete: true, prs: [] }, '2026-08', NOW), 'incomplete');
  const cur = { fetchedAt: NOW - 1000, count: 1, schema: SCHEMA, prs: [] };
  assert.ok(!needsFetch(cur, '2026-09', NOW), 'current month, fresh');
  assert.ok(needsFetch(cur, '2026-09', NOW, { force: true }), 'current month, 🔄');
  assert.ok(needsFetch({ ...cur, fetchedAt: NOW - STATS_TTL_MS - 1 }, '2026-09', NOW), 'current month, stale');
});

test('splitRange: two halves, null on a single day', () => {
  assert.deepEqual(splitRange('2026-09-01', '2026-09-30'), [['2026-09-01', '2026-09-15'], ['2026-09-16', '2026-09-30']]);
  assert.deepEqual(splitRange('2026-09-01', '2026-09-02'), [['2026-09-01', '2026-09-01'], ['2026-09-02', '2026-09-02']]);
  assert.equal(splitRange('2026-09-01', '2026-09-01'), null);
});

test('datasetQueries: scope → every merged PR of it; no scope → mine + the ones I reviewed', () => {
  assert.deepEqual(datasetQueries({ type: 'org', value: 'acme' }), ['org:acme']);
  assert.deepEqual(datasetQueries(null), ['author:@me', 'reviewed-by:@me -author:@me']);
});

const node = (n, { author = 'bob', merged = '2026-09-10T10:00:00Z', created = '2026-09-09T10:00:00Z', ready = null, reviews = [], bot = false } = {}) => ({
  number: n, repository: { nameWithOwner: 'acme/api' }, author: { __typename: bot ? 'Bot' : 'User', login: author },
  createdAt: created, mergedAt: merged, additions: 1, deletions: 0,
  ready: { nodes: ready ? [{ createdAt: ready }] : [] },
  firstReviews: { nodes: reviews.map(([login, at]) => ({ author: { __typename: 'User', login }, submittedAt: at })) },
  latestReviews: { nodes: reviews.map(([login, at, state = 'APPROVED']) => ({ author: { __typename: 'User', login }, submittedAt: at, state })) },
  reviewEvents: { totalCount: reviews.length },
});

test('compactPR: drops the author and bots from the reviewers, dates the first review', () => {
  const n = node(1, { reviews: [['bob', '2026-09-09T11:00:00Z'], ['me', '2026-09-09T12:00:00Z'], ['alice', '2026-09-09T13:00:00Z']] });
  n.latestReviews.nodes.push({ author: { __typename: 'Bot', login: 'copilot' }, submittedAt: '2026-09-09T10:30:00Z' });
  const pr = compactPR(n);
  assert.deepEqual(pr.rv.map(([l]) => l), ['me', 'alice']);
  assert.deepEqual(pr.frs.map(([l]) => l), ['me', 'alice'], "the author's own review does not count");
  assert.deepEqual(pr.rv[0], ['me', '2026-09-09T12:00:00Z', 'APPROVED'], 'verdict kept');
  assert.equal(pr.ev, 3);
  assert.equal(compactPR({ ...n, mergedAt: null }), null);
});

// Fake gh over a fixed list of PR nodes: honours merged:FROM..TO and `first`,
// cursor = offset. `truncate(q, offset)` → true = the page comes back half
// empty and claims there is no next page (GitHub's silent truncation).
function fakeGh(nodes, { truncate = () => false, fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    async searchMergedPRs(q, { first, after }) {
      calls.push({ q, first, after });
      if (fail(q, first)) throw new Error('gh: HTTP 504');
      const range = q.match(/merged:(\S+)\.\.(\S+)/);
      // No range = the first-activity lookup (sort:created-asc, mine only).
      const hits = range
        ? nodes.filter((n) => n.mergedAt.slice(0, 10) >= range[1] && n.mergedAt.slice(0, 10) <= range[2])
        : [...nodes]
          .filter((n) => (q.includes('author:@me') ? n.author.login === 'me' : n.latestReviews.nodes.some((r) => r.author.login === 'me')))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const offset = after ? Number(after) : 0;
      let page = hits.slice(offset, offset + first);
      // Truncated: half the page, and « no next page » (what GitHub does).
      const cut = truncate(q, offset);
      if (cut) page = page.slice(0, Math.ceil(page.length / 2));
      const end = offset + page.length;
      return { issueCount: hits.length, nodes: page, pageInfo: { hasNextPage: !cut && end < hits.length, endCursor: String(end) } };
    },
  };
}

const septNodes = (count) => Array.from({ length: count }, (_, i) => node(i + 1, { merged: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` }));

test('collectStats: fills the months, saves a count, reports x/12 progress', async () => {
  const gh = fakeGh(septNodes(90));
  const cache = { months: {} };
  const progress = [];
  const errors = await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, onProgress: (p) => progress.push(p), clock: () => NOW });
  assert.deepEqual(errors, []);
  assert.equal(cache.months['2026-09'].prs.length, 90);
  assert.equal(cache.months['2026-09'].count, 90);
  assert.equal(cache.months['2026-08'].prs.length, 0);
  const last = progress.at(-1);
  assert.equal(last.total, 12);
  assert.equal(last.done, 12);
  assert.deepEqual(last.months.find((m) => m.key === '2026-09'), { key: '2026-09', state: 'done', fetched: 90, total: 90 });
});

test('collectStats: a silently truncated search is detected and recovered by halves', async () => {
  // The full-month query stops after its first page; the half-month ones are fine.
  const gh = fakeGh(septNodes(90), { truncate: (q) => q.includes('2026-09-01..2026-09-30') });
  const cache = { months: {} };
  await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, clock: () => NOW });
  assert.equal(cache.months['2026-09'].prs.length, 90);
  assert.ok(!cache.months['2026-09'].incomplete);
  assert.ok(gh.calls.some((c) => c.q.includes('2026-09-01..2026-09-15')), 'refetched by halves');
});

test('collectStats: still short after the retries → month flagged incomplete (refetched next time)', async () => {
  const gh = fakeGh(septNodes(90), { truncate: () => true });
  const cache = { months: {} };
  const progress = [];
  await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, onProgress: (p) => progress.push(p), clock: () => NOW });
  const b = cache.months['2026-09'];
  assert.equal(b.incomplete, true);
  assert.equal(b.count, 90);
  assert.ok(b.prs.length < 90);
  assert.equal(progress.at(-1).months.at(-1).state, 'short');
  assert.ok(needsFetch(b, '2026-09', NOW));
});

test('collectStats: a failed page is retried at half the size, the smaller size sticks', async () => {
  const gh = fakeGh(septNodes(30), { fail: (q, first) => first > 20 });
  const cache = { months: {} };
  const errors = await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, concurrency: 1, clock: () => NOW });
  assert.deepEqual(errors, []);
  assert.equal(cache.months['2026-09'].prs.length, 30);
  assert.ok(gh.calls.filter((c) => c.first === 40).length === 1, 'only one 40-sized attempt in the whole run');
});

test('collectStats: a month that keeps failing is an error, keeps its old bucket', async () => {
  const gh = fakeGh(septNodes(10), { fail: (q) => q.includes('2026-09') });
  const old = { fetchedAt: NOW - STATS_TTL_MS - 1, count: 1, schema: SCHEMA, prs: [compactPR(node(99))] };
  const cache = { months: { '2026-09': old } };
  const errors = await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, clock: () => NOW });
  assert.equal(errors.length, 1);
  assert.equal(cache.months['2026-09'], old);
});

test('collectStats: keeps months out of the window (year views), skips final ones', async () => {
  const final = { fetchedAt: NOW, count: 0, schema: SCHEMA, prs: [] };
  const cache = { months: { '2024-01': final, '2026-01': final } };
  const gh = fakeGh([]);
  await collectStats(gh, null, cache, { now: NOW, clock: () => NOW });
  assert.equal(cache.months['2024-01'], final);
  assert.ok(!gh.calls.some((c) => c.q.includes('2026-01-01')), 'final month not refetched');
  assert.ok(gh.calls.some((c) => c.q.includes('author:@me')) && gh.calls.some((c) => c.q.includes('reviewed-by:@me')), 'no scope: two queries');
});

test('median: odd / even / empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('computeStats: my ratio, durations, team median + rank, months, days, repos, queue', () => {
  const h = 3600000;
  const at = (d, hh = 10) => `2026-09-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:00:00Z`;
  const prs = [
    // mine: ready → merged in 10 h, first review after 2 h
    compactPR(node(1, { author: 'me', created: at(1, 0), ready: at(1, 10), merged: at(1, 20), reviews: [['bob', at(1, 12)]] })),
    compactPR(node(2, { author: 'me', created: at(2, 10), merged: at(3, 10), reviews: [['bob', at(2, 14)]] })),
    // bob's, reviewed by me (×3) → my ratio 3/2 = 1.5
    ...[3, 4, 5].map((n) => compactPR(node(n, { author: 'bob', created: at(4), merged: at(5), reviews: [['me', at(4, 12)]] }))),
    // a bot PR: counted in my ratio (I reviewed it), not in the team numbers
    compactPR(node(6, { author: 'dependabot', bot: true, created: at(6), merged: at(6, 11), reviews: [['me', at(6, 10)]] })),
  ];
  const cache = { months: { '2026-09': { fetchedAt: NOW, count: prs.length, schema: SCHEMA, prs } } };
  const s = computeStats(cache, 'me', { now: NOW, scoped: true, waiting: [{ createdAt: '2026-09-25T12:00:00Z' }] });
  assert.deepEqual({ reviewed: s.me.reviewed, merged: s.me.merged }, { reviewed: 4, merged: 2 });
  assert.equal(s.me.ratio, 2);
  assert.equal(s.me.ttm, (10 * h + 24 * h) / 2);
  assert.equal(s.me.ttfr, (2 * h + 4 * h) / 2);
  // bob: 3 merged, reviewed 2 of mine → 0.67; me: 2 merged < MIN → no ratio rank
  assert.deepEqual(s.team.ratio, { rank: null, of: 1 });
  assert.deepEqual(s.team.reviews, { rank: 1, of: 2 }, 'me 4 reviews, bob 2');
  assert.deepEqual(s.team.merged, { rank: 2, of: 2 }, 'bob 3 merged, me 2');
  assert.equal(s.months.at(-1).key, '2026-09');
  assert.deepEqual({ r: s.months.at(-1).reviewed, m: s.months.at(-1).merged }, { r: 4, m: 2 });
  assert.equal(s.days['2026-09-04'], 3);
  assert.deepEqual(s.repos[0], { repo: 'acme/api', reviewed: 4, merged: 2 });
  assert.deepEqual(s.queue, { count: 1, oldest: 3 * 24 * h });
  assert.deepEqual(s.incomplete, []);
});

test('computeStats: no scope → no team numbers', () => {
  const s = computeStats({ months: {} }, 'me', { now: NOW, scoped: false });
  assert.equal(s.team, null);
  assert.equal(s.me.ratio, null);
});

test('periodKeys: last 12 months, a past year (12), the current year (up to now)', () => {
  assert.equal(periodKeys('last12', NOW).length, 12);
  assert.deepEqual(periodKeys('2025', NOW), Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(periodKeys('2026', NOW).at(-1), '2026-09');
  assert.equal(periodKeys('2026', NOW).length, 9);
  assert.equal(periodKeys('junk', NOW).length, 12, 'fallback');
});

test('periodOptions / isValidPeriod: last 12 months, then the years down to the first PR', () => {
  assert.deepEqual(periodOptions(2023, NOW), ['last12', '2026', '2025', '2024', '2023']);
  assert.deepEqual(periodOptions(null, NOW), ['last12', '2026'], 'first year unknown yet');
  assert.ok(isValidPeriod('last12', NOW) && isValidPeriod('2019', NOW));
  assert.ok(!isValidPeriod('2027', NOW) && !isValidPeriod('1999', NOW) && !isValidPeriod('x', NOW) && !isValidPeriod(null, NOW));
});

test('rankOf: competition ranking, ties share a rank, absent → null', () => {
  const m = new Map([['a', 5], ['b', 9], ['me', 5], ['c', 1]]);
  assert.equal(rankOf(m, 'me'), 2);
  assert.equal(rankOf(m, 'a'), 2);
  assert.equal(rankOf(m, 'c'), 4);
  assert.equal(rankOf(m, 'nobody'), null);
});

test('firstPRYear: MY first activity in the scope (first PR or first review), not the scope\'s first PR', async () => {
  const gh = fakeGh([
    node(1, { author: 'bob', created: '2015-01-01T00:00:00Z', merged: '2015-01-02T00:00:00Z' }), // the scope's first PR: ignored
    node(2, { author: 'me', created: '2022-03-01T00:00:00Z', merged: '2022-03-02T00:00:00Z' }),
    node(3, { author: 'bob', created: '2021-05-01T00:00:00Z', merged: '2021-05-02T00:00:00Z', reviews: [['me', '2021-05-01T12:00:00Z']] }),
  ]);
  assert.equal(await firstPRYear(gh, { type: 'org', value: 'acme' }), 2021);
  assert.deepEqual(gh.calls.map((c) => c.q), [
    'is:pr is:merged author:@me org:acme sort:created-asc',
    'is:pr is:merged reviewed-by:@me org:acme sort:created-asc',
  ]);
  assert.equal(await firstPRYear(fakeGh([]), null), null, 'nothing → null');
});

test('collectStats: fetches only the requested keys, records myFirstYear', async () => {
  const gh = fakeGh([node(1, { author: 'me', created: '2020-01-01T00:00:00Z', merged: '2025-03-10T10:00:00Z' })]);
  const cache = { months: {} };
  await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, keys: periodKeys('2025', NOW), clock: () => NOW });
  assert.deepEqual(Object.keys(cache.months).sort(), periodKeys('2025', NOW));
  assert.equal(cache.months['2025-03'].prs.length, 1);
  assert.equal(cache.myFirstYear, 2020);
});

test('computeStats: a focused month narrows tiles and repos, the chart keeps the period', () => {
  const at = (m, d) => `2026-${m}-${d}T10:00:00Z`;
  const prs = [
    compactPR(node(1, { author: 'me', created: at('08', '01'), merged: at('08', '02') })),
    compactPR(node(2, { author: 'bob', created: at('09', '01'), merged: at('09', '02'), reviews: [['me', at('09', '01')]] })),
  ];
  const cache = { months: { '2026-08': { fetchedAt: NOW, count: 1, schema: SCHEMA, prs: [prs[0]] }, '2026-09': { fetchedAt: NOW, count: 1, schema: SCHEMA, prs: [prs[1]] } } };
  const s = computeStats(cache, 'me', { now: NOW, month: '2026-09', scoped: true });
  assert.equal(s.month, '2026-09');
  assert.deepEqual({ r: s.me.reviewed, m: s.me.merged }, { r: 1, m: 0 });
  assert.equal(s.months.find((m) => m.key === '2026-08').merged, 1, 'chart spans the period');
  assert.equal(computeStats(cache, 'me', { now: NOW, month: '1999-01' }).month, null, 'unknown month ignored');
});

test('needsFirstYear: unknown → yes; found → no; not found / failed → again after a day; the old scope-wide field is ignored', () => {
  assert.ok(needsFirstYear({ months: {} }, NOW));
  assert.ok(!needsFirstYear({ months: {}, myFirstYear: 2019 }, NOW));
  assert.ok(!needsFirstYear({ months: {}, myFirstYear: null, myFirstYearAt: NOW - 1000 }, NOW));
  assert.ok(needsFirstYear({ months: {}, myFirstYear: null, myFirstYearAt: NOW - 2 * 86400000 }, NOW));
  assert.ok(needsFirstYear({ months: {}, firstYear: 2015 }, NOW), 'v1 value (scope\'s first PR) not reused');
});

test('collectStats: looks the first year up even when every month is fresh (real bug)', async () => {
  const fresh = Object.fromEntries(periodKeys('last12', NOW).map((k) => [k, { fetchedAt: NOW, count: 0, schema: SCHEMA, prs: [] }]));
  const cache = { months: fresh };
  const gh = fakeGh([node(1, { author: 'me', created: '2017-02-01T00:00:00Z', merged: '2017-02-02T00:00:00Z' })]);
  await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, clock: () => NOW });
  assert.equal(cache.myFirstYear, 2017);
  assert.equal(gh.calls.length, 2, 'only the two lookups (my PRs, my reviews), no month refetched');
});

test('computeStats: reciprocity, size points, team people', () => {
  const at = (d, h = 10) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
  const prs = [
    compactPR(node(1, { author: 'me', created: at(1), merged: at(2), reviews: [['bob', at(1, 12)], ['alice', at(1, 13)]] })),
    compactPR(node(2, { author: 'me', created: at(3), merged: at(3, 12), reviews: [['bob', at(3, 11)]] })),
    compactPR(node(3, { author: 'bob', created: at(4), merged: at(5), reviews: [['me', at(4, 12)]] })),
    compactPR(node(4, { author: 'dependabot', bot: true, created: at(6), merged: at(6, 11), reviews: [['me', at(6, 10)]] })),
  ];
  const cache = { months: { '2026-09': { fetchedAt: NOW, count: prs.length, schema: SCHEMA, prs } } };
  const s = computeStats(cache, 'me', { now: NOW, scoped: true });
  assert.deepEqual(s.reciprocity, [
    { login: 'bob', theyReviewedMine: 2, iReviewedTheirs: 1 },
    { login: 'alice', theyReviewedMine: 1, iReviewedTheirs: 0 },
  ], 'bots are not people');
  assert.deepEqual(s.sizes.mine.map((p) => p.n).sort(), [1, 2]);
  assert.equal(s.sizes.mine.find((p) => p.n === 2).ttm, 2 * 3600000);
  assert.deepEqual(s.sizes.team.map((p) => p.n), [3], 'team = humans but me');
  assert.deepEqual(s.shipping.map((a) => [a.login, a.merged]), [['me', 2], ['bob', 1]]);
  assert.deepEqual(s.reviewing.map((r) => [r.login, r.given, r.merged]), [['bob', 2, 1], ['me', 2, 2], ['alice', 1, 0]]);
});

test('computeStats: no scope → no team points (the dataset is only mine)', () => {
  const prs = [compactPR(node(1, { author: 'bob', reviews: [['me', '2026-09-09T12:00:00Z']] }))];
  const s = computeStats({ months: { '2026-09': { fetchedAt: NOW, count: 1, schema: SCHEMA, prs } } }, 'me', { now: NOW, scoped: false });
  assert.deepEqual(s.sizes.team, []);
  assert.equal(s.team, null);
});

// ── schema v2: verdicts, unmerged dataset, filters, repository ─────────────

const un = (n, { author = 'bob', created = '2026-09-05T10:00:00Z', open = false } = {}) => ({
  number: n, repository: { nameWithOwner: 'acme/api' }, author: { __typename: 'User', login: author },
  createdAt: created, closedAt: open ? null : '2026-09-06T10:00:00Z', state: open ? 'OPEN' : 'CLOSED', additions: 5, deletions: 1,
});

test('compactUnmerged / unmergedQueries', () => {
  assert.deepEqual(compactUnmerged(un(4, { open: true })), { repo: 'acme/api', n: 4, a: 'bob', bot: false, c: '2026-09-05T10:00:00Z', cl: null, open: true, add: 5, del: 1 });
  assert.equal(compactUnmerged({ ...un(4), mergedAt: '2026-09-07T00:00:00Z' }), null);
  assert.deepEqual(unmergedQueries({ type: 'org', value: 'acme' }), ['org:acme']);
  assert.deepEqual(unmergedQueries(null), ['author:@me']);
});

test('needsFetch: an old-schema bucket is refetched; needsFetchUnmerged: never final while a PR is open', () => {
  const after = Date.parse('2026-09-02T00:00:00Z');
  assert.ok(needsFetch({ fetchedAt: after, count: 0, prs: [] }, '2026-08', NOW), 'no schema');
  assert.ok(!needsFetch({ fetchedAt: after, count: 0, schema: SCHEMA, prs: [] }, '2026-08', NOW));
  assert.ok(!needsFetchUnmerged({ fetchedAt: after, prs: [{ open: false }] }, '2026-08', NOW), 'past, all closed → final');
  assert.ok(!needsFetchUnmerged({ fetchedAt: NOW - 1000, prs: [{ open: true }] }, '2026-08', NOW), 'open PR, fresh');
  assert.ok(needsFetchUnmerged({ fetchedAt: NOW - STATS_TTL_MS - 1, prs: [{ open: true }] }, '2026-08', NOW), 'open PR, stale');
  assert.ok(needsFetchUnmerged(undefined, '2026-08', NOW));
});

test('collectStats: fills the unmerged dataset by CREATION month when the gh has it', async () => {
  const gh = fakeGh(septNodes(3));
  const unmergedNodes = [un(10, { created: '2026-09-05T10:00:00Z' }), un(11, { created: '2026-09-06T10:00:00Z', open: true }), un(12, { created: '2026-08-06T10:00:00Z' })];
  gh.searchUnmergedPRs = async (q, { first, after }) => {
    gh.calls.push({ q, first, after });
    const [, from, to] = q.match(/created:(\S+)\.\.(\S+)/);
    const hits = unmergedNodes.filter((n) => n.createdAt.slice(0, 10) >= from && n.createdAt.slice(0, 10) <= to);
    return { issueCount: hits.length, nodes: hits, pageInfo: { hasNextPage: false, endCursor: null } };
  };
  const cache = { months: {} };
  await collectStats(gh, { type: 'org', value: 'acme' }, cache, { now: NOW, clock: () => NOW });
  assert.deepEqual(cache.unmerged['2026-09'].prs.map((p) => p.n).sort(), [10, 11]);
  assert.deepEqual(cache.unmerged['2026-08'].prs.map((p) => p.n), [12]);
  assert.ok(gh.calls.some((c) => c.q.startsWith('is:pr is:unmerged created:2026-09-01..2026-09-30 org:acme')));
  assert.equal(cache.months['2026-09'].schema, SCHEMA);
});

test('quantile: nearest rank', () => {
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.9), null);
});

// A scope of 4 merged PRs + 2 unmerged, used by the tests below.
function scopeCache() {
  const at = (d, h = 10) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
  const prs = [
    // mine, reviewed by bob (approved) and the AI account (commented, first!)
    compactPR(node(1, { author: 'me', created: at(1), merged: at(2), reviews: [['ai', at(1, 10)], ['bob', at(1, 14), 'APPROVED']] })),
    // bob's, I requested changes; carol commented
    compactPR(node(2, { author: 'bob', created: at(3), merged: at(4), reviews: [['me', at(3, 12), 'CHANGES_REQUESTED'], ['carol', at(3, 13), 'COMMENTED']] })),
    // carol's, no review at all
    compactPR(node(3, { author: 'carol', created: at(5), merged: at(5, 11) })),
    // bob's, created in AUGUST, merged in September
    compactPR(node(4, { author: 'bob', created: '2026-08-20T10:00:00Z', merged: at(6), reviews: [['me', at(6, 9), 'APPROVED']] })),
  ];
  prs[0].rv.find((r) => r[0] === 'ai')[2] = 'COMMENTED';
  const unmerged = [compactUnmerged(un(10, { author: 'bob' })), compactUnmerged(un(11, { author: 'carol', open: true }))];
  return {
    months: { '2026-09': { fetchedAt: NOW, count: 4, schema: SCHEMA, prs } },
    unmerged: { '2026-09': { fetchedAt: NOW, count: 2, schema: SCHEMA, prs: unmerged } },
  };
}

test('computeStats: my verdicts, the repository aggregates (with p90 and outcomes)', () => {
  const s = computeStats(scopeCache(), 'me', { now: NOW, scoped: true });
  assert.deepEqual(s.me.verdicts, { APPROVED: 1, CHANGES_REQUESTED: 1, COMMENTED: 0 });
  const r = s.repo;
  assert.equal(r.merged, 4);
  assert.equal(r.noReview, 1, 'carol #3');
  assert.equal(r.noApproval, 2, '#2 (changes + comment), #3');
  assert.equal(r.reviewersPerPR, (2 + 2 + 0 + 1) / 4);
  assert.equal(r.opened.total, 6, 'created in the period: 4 merged (#4 in August — inside the 12 months) + 2 unmerged');
  assert.deepEqual({ m: r.opened.merged, c: r.opened.closed, o: r.opened.open }, { m: 4, c: 1, o: 1 });
  const focused = computeStats(scopeCache(), 'me', { now: NOW, scoped: true, month: '2026-09' }).repo.opened;
  assert.equal(focused.total, 5, 'focused on September: #4 (created in August) is out');
  const sep = r.outcomes.find((o) => o.key === '2026-09');
  assert.deepEqual({ k: sep.known, m: sep.merged, c: sep.closed, o: sep.open }, { k: true, m: 3, c: 1, o: 1 });
  assert.equal(r.outcomes.find((o) => o.key === '2026-08').merged, 1, '#4 by creation month');
  assert.equal(r.outcomes.find((o) => o.key === '2026-08').known, false);
  assert.equal(r.speed.find((x) => x.key === '2026-09').n, 4);
  assert.deepEqual(r.repos, [{ repo: 'acme/api', merged: 4 }]);
});

test('computeStats: who\'s shipping (opened / merge rate / diff) and who\'s reviewing (verdicts)', () => {
  const s = computeStats(scopeCache(), 'me', { now: NOW, scoped: true });
  const bob = s.shipping.find((a) => a.login === 'bob');
  assert.deepEqual({ merged: bob.merged, opened: bob.opened, rate: bob.mergeRate }, { merged: 2, opened: 3, rate: 2 / 3 }, '#2 #4 merged + #10 closed');
  const carol = s.shipping.find((a) => a.login === 'carol');
  assert.deepEqual({ opened: carol.opened, open: carol.open }, { opened: 2, open: 1 });
  const me = s.reviewing.find((r) => r.login === 'me');
  assert.deepEqual({ g: me.given, a: me.approved, c: me.changes }, { g: 2, a: 1, c: 1 });
  assert.equal(s.reviewing.find((r) => r.login === 'carol').commented, 1);
});

test('computeStats: an ignored account loses its reviews (first review recomputed), includeIgnored brings them back', () => {
  const on = computeStats(scopeCache(), 'me', { now: NOW, scoped: true, ignored: ['ai'] });
  assert.ok(!on.reviewing.some((r) => r.login === 'ai'));
  assert.equal(on.me.ttfr, 4 * 3600000, 'bob at 14:00, not the AI at 10:00');
  const off = computeStats(scopeCache(), 'me', { now: NOW, scoped: true, ignored: ['ai'], includeIgnored: true });
  assert.ok(off.reviewing.some((r) => r.login === 'ai'));
  assert.equal(off.me.ttfr, 0);
});

test('computeStats: team filter keeps the members\' PRs and reviews (and mine)', () => {
  const s = computeStats(scopeCache(), 'me', { now: NOW, scoped: true, teamMembers: ['bob'] });
  assert.deepEqual(s.shipping.map((a) => a.login).sort(), ['bob', 'me']);
  assert.ok(!s.reviewing.some((r) => r.login === 'carol' || r.login === 'ai'));
  assert.equal(s.repo.merged, 3, 'carol\'s #3 dropped');
});

test('computeStats: automated-looking accounts suggested (volume + nearly all comments), known reviewers listed', () => {
  const cache = scopeCache();
  const many = Array.from({ length: 40 }, (_, i) => compactPR(node(100 + i, { author: 'bob', merged: '2026-09-10T10:00:00Z', reviews: [['ai', '2026-09-09T10:00:00Z', 'COMMENTED']] })));
  cache.months['2026-09'].prs.push(...many);
  const s = computeStats(cache, 'me', { now: NOW, scoped: true, ignored: ['ai'] });
  assert.deepEqual(s.automated.map((a) => a.login), ['ai'], 'still suggested while ignored');
  assert.equal(s.reviewers[0], 'ai');
});

test('monthsToFetch: an unmerged month is due even when every merged month is final (past-year views)', () => {
  const final = { fetchedAt: NOW, count: 0, schema: SCHEMA, prs: [] };
  const cache = {
    months: { '2025-03': final, '2025-04': final },
    unmerged: {
      '2025-03': { fetchedAt: NOW - STATS_TTL_MS - 1, prs: [{ open: true }] },
      '2025-04': { fetchedAt: NOW, prs: [{ open: false }] },
    },
  };
  assert.deepEqual(monthsToFetch(cache, ['2025-03', '2025-04'], NOW), ['2025-03'], 'still holds an open PR, stale');
  assert.deepEqual(monthsToFetch(cache, ['2025-03', '2025-04'], NOW, { withUnmerged: false }), [], 'no unmerged search: merged months only');
  assert.deepEqual(monthsToFetch({ months: {} }, ['2025-03'], NOW), ['2025-03'], 'never fetched');
});

test('computeStats: a PR cached as open then merged counts once, as merged', () => {
  const cache = scopeCache();
  // #11 (carol) is still open in the unmerged cache, but got merged since.
  cache.months['2026-09'].prs.push(compactPR(node(11, { author: 'carol', created: '2026-09-05T10:00:00Z', merged: '2026-09-20T10:00:00Z' })));
  const s = computeStats(cache, 'me', { now: NOW, scoped: true });
  const o = s.repo.opened;
  assert.deepEqual({ t: o.total, m: o.merged, c: o.closed, open: o.open }, { t: 6, m: 5, c: 1, open: 0 });
  const sep = s.repo.outcomes.find((x) => x.key === '2026-09');
  assert.deepEqual({ m: sep.merged, open: sep.open }, { m: 4, open: 0 });
  const carol = s.shipping.find((a) => a.login === 'carol');
  assert.deepEqual({ opened: carol.opened, open: carol.open, rate: carol.mergeRate }, { opened: 2, open: 0, rate: 1 });
});

test('computeStats: the 5 first reviews all taken by an ignored account → the reviewers\' dates stand in, the PR is not dropped', () => {
  // GitHub only gives the first 5 reviews: the AI account took them all, bob reviewed after.
  const n = node(1, { author: 'carol', created: '2026-09-01T10:00:00Z', merged: '2026-09-02T10:00:00Z', reviews: Array.from({ length: 5 }, (_, i) => ['ai', `2026-09-01T1${i}:00:00Z`, 'COMMENTED']) });
  n.latestReviews.nodes = [
    { author: { __typename: 'User', login: 'ai' }, submittedAt: '2026-09-01T14:00:00Z', state: 'COMMENTED' },
    { author: { __typename: 'User', login: 'bob' }, submittedAt: '2026-09-01T16:00:00Z', state: 'APPROVED' },
  ];
  const cache = { months: { '2026-09': { fetchedAt: NOW, count: 1, schema: SCHEMA, prs: [compactPR(n)] } } };
  const s = computeStats(cache, 'me', { now: NOW, scoped: true, ignored: ['ai'] });
  assert.equal(s.repo.ttfr.median, 6 * 3600000, 'bob, 6 h after the creation');
});
