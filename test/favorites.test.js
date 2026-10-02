import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUALIFIER_LENGTH, parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, cycleFavorite, filterDataByScope, favoriteLabel, favoriteCounts,
  closedPRsUrl, reviewedPRsUrl, authorPRsUrl, reviewCoverageQueries, repoInAllMode,
} from '../src/favorites.js';
import { scopesQualifier } from '../src/collect.js';

test('parseScope: empty → null, with « / » → repo, otherwise org', () => {
  assert.equal(parseScope(''), null);
  assert.equal(parseScope('   '), null);
  assert.equal(parseScope(null), null);
  assert.deepEqual(parseScope('stark'), { type: 'org', value: 'stark' });
  assert.deepEqual(parseScope(' nakatomi/collection '), { type: 'repo', value: 'nakatomi/collection' });
});

test('normalizeFavorites: dedup, trim, ignore unusable values', () => {
  assert.deepEqual(normalizeFavorites(['stark', ' stark ', 'zorg']), ['stark', 'zorg']);
  assert.deepEqual(normalizeFavorites(['', '   ', null, 42, {}, 'a']), ['a']);
  assert.deepEqual(normalizeFavorites(undefined), []);
  assert.deepEqual(normalizeFavorites('stark'), []); // tampered file: not an array
});

test('normalizeFavorites preserves insertion order', () => {
  assert.deepEqual(normalizeFavorites(['z', 'a', 'm']), ['z', 'a', 'm']);
});

test('addFavorite: appends at the end, idempotent, refuses empty', () => {
  assert.deepEqual(addFavorite([], 'stark'), ['stark']);
  assert.deepEqual(addFavorite(['stark'], 'zorg'), ['stark', 'zorg']);
  assert.deepEqual(addFavorite(['stark'], ' stark '), ['stark']); // already there → unchanged
  assert.throws(() => addFavorite([], '  '), /requires a value/);
});

// Fills up until refusal and returns the last accepted list.
function fillUntilFull(name) {
  let list = [];
  for (let i = 0; i < 100; i++) {
    try { list = addFavorite(list, name(i)); } catch { return list; }
  }
  assert.fail('addFavorite should have ended up refusing');
}

test('addFavorite: whatever is accepted always fits in a GitHub query', () => {
  // The invariant that matters: whatever we pin, the search stays valid
  // (< 256 characters, prefix `is:open is:pr review-requested:@me` included).
  for (const name of [(i) => `org${i}`, (i) => `organisation-tres-longue-${i}/depot-interminable-${i}`]) {
    const list = fillUntilFull(name);
    const q = `is:open is:pr review-requested:@me${scopesQualifier(favoriteScopes(list))}`;
    assert.ok(q.length < 256, `query of ${q.length} characters`);
  }
});

test('addFavorite: the cap depends on the length of the names, not their count', () => {
  const shorts = fillUntilFull((i) => `org${i}`);
  const longs = fillUntilFull((i) => `organisation-tres-longue-${i}/depot-interminable-${i}`);
  assert.ok(shorts.length > longs.length,
    `short names (${shorts.length}) should accept more than long names (${longs.length})`);
});

test('addFavorite: a duplicate passes even once the cap is reached', () => {
  const list = fillUntilFull((i) => `org${i}`);
  assert.deepEqual(addFavorite(list, list[0]), list); // idempotent, no error
  assert.throws(() => addFavorite(list, 'one-favorite-too-many'), /would exceed/);
});

test('MAX_QUALIFIER_LENGTH leaves margin below the GitHub limit of 256', () => {
  assert.ok(MAX_QUALIFIER_LENGTH < 256 - 34); // 34 = `is:open is:pr review-requested:@me`
});

test('removeFavorite: removes, no-op on absent value', () => {
  assert.deepEqual(removeFavorite(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(removeFavorite(['a', 'b'], 'zzz'), ['a', 'b']);
  assert.deepEqual(removeFavorite([], 'a'), []);
});

test('favoriteScopes: list → scopes, empty list → null (= no filter)', () => {
  assert.deepEqual(favoriteScopes(['stark', 'nakatomi/collection']), [
    { type: 'org', value: 'stark' },
    { type: 'repo', value: 'nakatomi/collection' },
  ]);
  assert.equal(favoriteScopes([]), null);
  assert.equal(favoriteScopes(undefined), null);
});

test('activeFavoriteOf: null if absent, unknown, or removed from the list', () => {
  assert.equal(activeFavoriteOf({ activeFav: 'stark' }, ['stark', 'z']), 'stark');
  assert.equal(activeFavoriteOf({ activeFav: 'stark' }, ['z']), null); // removed since
  assert.equal(activeFavoriteOf({}, ['stark']), null);
  assert.equal(activeFavoriteOf({ activeFav: 42 }, ['stark']), null); // tampered file
  assert.equal(activeFavoriteOf(null, ['stark']), null);
});

test('cycleFavorite: all → 1st → … → last → all', () => {
  const list = ['stark', 'nakatomi/collection', 'zorg'];
  assert.equal(cycleFavorite(list, null), 'stark');
  assert.equal(cycleFavorite(list, 'stark'), 'nakatomi/collection');
  assert.equal(cycleFavorite(list, 'nakatomi/collection'), 'zorg');
  assert.equal(cycleFavorite(list, 'zorg'), null); // full loop
});

test('cycleFavorite: empty list stays on null, unknown active restarts from the beginning', () => {
  assert.equal(cycleFavorite([], null), null);
  assert.equal(cycleFavorite([], 'stark'), null);
  assert.equal(cycleFavorite(['a', 'b'], 'vanished'), 'a');
});

// Example data: two perimeters mixed, as after a collection on the union.
const data = () => ({
  mine: [{ repo: 'stark/api', number: 1 }, { repo: 'zorg/forge', number: 2 }],
  others: [{ repo: 'stark/front', number: 3 }, { repo: 'zorg/forge', number: 4 }],
  hidden: [{ repo: 'zorg/forge', number: 5 }],
  hiddenCount: 1,
  notifications: [{ repo: 'stark/api', number: 1 }, { repo: 'zorg/forge', number: 2 }],
  debug: [{ repo: 'stark/api' }, { repo: 'zorg/forge' }],
  approvalEvents: [{ repo: 'zorg/forge' }],
});

test('filterDataByScope: filters all lists and recomputes hiddenCount', () => {
  const out = filterDataByScope(data(), { type: 'org', value: 'stark' });
  assert.deepEqual(out.mine.map((r) => r.number), [1]);
  assert.deepEqual(out.others.map((r) => r.number), [3]);
  assert.deepEqual(out.hidden, []);
  assert.equal(out.hiddenCount, 0); // recomputed, not inherited from the original 1
  assert.deepEqual(out.notifications.map((r) => r.number), [1]);
  assert.deepEqual(out.debug, [{ repo: 'stark/api' }]);
});

test('filterDataByScope: precise repo scope', () => {
  const out = filterDataByScope(data(), { type: 'repo', value: 'zorg/forge' });
  assert.deepEqual(out.mine.map((r) => r.number), [2]);
  assert.deepEqual(out.others.map((r) => r.number), [4]);
  assert.equal(out.hiddenCount, 1);
});

test('filterDataByScope: filters hiddenMine and recomputes hiddenMineCount', () => {
  const d = { ...data(), hiddenMine: [{ repo: 'stark/api', number: 6 }, { repo: 'zorg/forge', number: 7 }], hiddenMineCount: 2 };
  const out = filterDataByScope(d, { type: 'org', value: 'stark' });
  assert.deepEqual(out.hiddenMine.map((r) => r.number), [6]);
  assert.equal(out.hiddenMineCount, 1);
});

test('filterDataByScope: filters the issues rows too', () => {
  const d = { ...data(), issues: [{ repo: 'stark/api', number: 8 }, { repo: 'zorg/forge', number: 9 }] };
  const out = filterDataByScope(d, { type: 'org', value: 'stark' });
  assert.deepEqual(out.issues.map((r) => r.number), [8]);
});

test('repoInAllMode: repo covered by at least one « all » favorite (union)', () => {
  const favorites = ['stark', 'zorg/forge'];
  const modes = { 'zorg/forge': 'all' };
  assert.equal(repoInAllMode(favorites, modes, 'zorg/forge'), true);
  assert.equal(repoInAllMode(favorites, modes, 'zorg/browser'), false); // repo favorite ≠ other repo
  assert.equal(repoInAllMode(favorites, modes, 'stark/console'), false);   // favorite in normal mode
  // org favorite in « all » mode covers all its repos
  assert.equal(repoInAllMode(favorites, { stark: 'all' }, 'stark/console'), true);
  assert.equal(repoInAllMode(favorites, { stark: 'all' }, 'zorg/forge'), false);
});

test('repoInAllMode: stale key (removed favorite) or malformed modes → false', () => {
  // « all » mode on a favorite no longer in the list: ignored
  assert.equal(repoInAllMode(['stark'], { 'zorg/forge': 'all' }, 'zorg/forge'), false);
  assert.equal(repoInAllMode(['stark'], null, 'stark/console'), false);
  assert.equal(repoInAllMode(['stark'], 'nope', 'stark/console'), false);
  assert.equal(repoInAllMode([], { stark: 'all' }, 'stark/console'), false);
});

test('filterDataByScope: null scope → data unchanged (same references)', () => {
  const d = data();
  assert.equal(filterDataByScope(d, null), d);
});

test('filterDataByScope does not mutate the source data (the raw one serves the notifs)', () => {
  const d = data();
  filterDataByScope(d, { type: 'org', value: 'stark' });
  assert.equal(d.mine.length, 2);
  assert.equal(d.hiddenCount, 1);
});

test('filterDataByScope: the non-filtered keys are kept as-is', () => {
  // approvalEvents feeds the desktop notifs: it must not be filtered here.
  const out = filterDataByScope(data(), { type: 'org', value: 'stark' });
  assert.deepEqual(out.approvalEvents, [{ repo: 'zorg/forge' }]);
});

test('favoriteLabel: org → « org/* », repo unchanged (display only)', () => {
  assert.equal(favoriteLabel('stark'), 'stark/*');
  assert.equal(favoriteLabel('nakatomi/collection'), 'nakatomi/collection');
  assert.equal(favoriteLabel(' zorg '), 'zorg/*');
  assert.equal(favoriteLabel(''), '');
  assert.equal(favoriteLabel(null), '');
});

test('favoriteCounts: one counter per panel (mine/others/issues) per favorite + total, on the raw union', () => {
  const data = {
    mine: [{ repo: 'stark/api' }],
    others: [
      { repo: 'stark/api' }, { repo: 'stark/front' },
      { repo: 'nakatomi/collection' }, { repo: 'zorg/forge' },
    ],
    issues: [{ repo: 'zorg/forge' }],
  };
  const { total, byFav } = favoriteCounts(['stark', 'nakatomi/collection', 'zorg'], data);
  assert.deepEqual(total, { mine: 1, others: 4, issues: 1 });
  assert.deepEqual(byFav, {
    stark: { mine: 1, others: 2, issues: 0 },
    'nakatomi/collection': { mine: 0, others: 1, issues: 0 },
    zorg: { mine: 0, others: 1, issues: 1 },
  });
});

test('favoriteCounts: empty/invalid list or data → zeros, no crash', () => {
  const zero = { mine: 0, others: 0, issues: 0 };
  assert.deepEqual(favoriteCounts([], {}), { total: zero, byFav: {} });
  assert.deepEqual(favoriteCounts(['stark'], null), { total: zero, byFav: { stark: zero } });
  assert.deepEqual(
    favoriteCounts(null, { others: [{ repo: 'a/b' }] }),
    { total: { mine: 0, others: 1, issues: 0 }, byFav: {} },
  );
});

test('closedPRsUrl: without scope → internal search page, author:@me is:closed', () => {
  assert.equal(
    closedPRsUrl(null),
    '/search?q=is%3Apr%20author%3A%40me%20is%3Aclosed',
  );
});

test('closedPRsUrl: org / repo scope → qualifier added (encoded)', () => {
  assert.ok(closedPRsUrl({ type: 'org', value: 'stark' }).endsWith('%20org%3Astark'));
  assert.ok(closedPRsUrl({ type: 'repo', value: 'nakatomi/collection' }).endsWith('%20repo%3Anakatomi%2Fcollection'));
});

test('closedPRsUrl: union of scopes → all qualifiers (OR-ed by GitHub)', () => {
  const url = closedPRsUrl([{ type: 'org', value: 'stark' }, { type: 'repo', value: 'a/b' }]);
  assert.ok(url.includes('org%3Astark'));
  assert.ok(url.includes('repo%3Aa%2Fb'));
});

test('reviewedPRsUrl: internal search page, reviewed-by:@me -author:@me, contextualized', () => {
  assert.equal(
    reviewedPRsUrl(null),
    '/search?q=is%3Apr%20reviewed-by%3A%40me%20-author%3A%40me',
  );
  assert.ok(reviewedPRsUrl({ type: 'org', value: 'stark' }).endsWith('%20org%3Astark'));
});

test('authorPRsUrl: internal search page, every PR of the author, newest opened first, contextualized', () => {
  assert.equal(authorPRsUrl('alice', null), '/search?q=is%3Apr%20author%3Aalice&sort=date&dir=desc');
  assert.equal(
    authorPRsUrl('alice', { type: 'org', value: 'stark' }),
    '/search?q=is%3Apr%20author%3Aalice%20org%3Astark&sort=date&dir=desc',
  );
});

test('reviewCoverageQueries: others\' PRs I reviewed vs my PRs merged, over 30 sliding days and a sliding year', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const q = reviewCoverageQueries({ type: 'org', value: 'stark' }, now);
  assert.equal(q.month.reviewed, 'is:pr merged:>=2026-08-29 reviewed-by:@me -author:@me org:stark');
  assert.equal(q.month.merged, 'is:pr merged:>=2026-08-29 author:@me org:stark');
  assert.equal(q.year.reviewed, 'is:pr merged:>=2025-09-28 reviewed-by:@me -author:@me org:stark');
  assert.equal(q.year.merged, 'is:pr merged:>=2025-09-28 author:@me org:stark');
  assert.equal(q.key, ' org:stark', 'cache key = scope only (the date moves daily)');
  assert.equal(reviewCoverageQueries(null, now).year.merged, 'is:pr merged:>=2025-09-28 author:@me');
});

test('reviewCoverageQueries: stays under the 256-char search cap at the favorites budget', () => {
  const q = reviewCoverageQueries(null, 0);
  assert.ok(q.year.reviewed.length + MAX_QUALIFIER_LENGTH <= 256);
});

test('parseScope: « owner/* » (the org label) and « owner/ » mean the org, not a repo', () => {
  assert.deepEqual(parseScope('acme/*'), { type: 'org', value: 'acme' });
  assert.deepEqual(parseScope(' acme/ '), { type: 'org', value: 'acme' });
  assert.deepEqual(parseScope('acme/api'), { type: 'repo', value: 'acme/api' });
});

test('addFavorite/removeFavorite: « owner/* » is stored and removed as the bare org', () => {
  assert.deepEqual(addFavorite(['acme'], 'acme/*'), ['acme'], 'no duplicate');
  assert.deepEqual(addFavorite([], 'acme/*'), ['acme']);
  assert.deepEqual(removeFavorite(['acme'], 'acme/*'), []);
});
