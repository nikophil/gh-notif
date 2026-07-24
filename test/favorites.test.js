import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUALIFIER_LENGTH, parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, cycleFavorite, filterDataByScope, favoriteLabel, favoriteCounts,
  closedPRsUrl,
} from '../src/favorites.js';
import { scopesQualifier } from '../src/collect.js';

test('parseScope: empty → null, with « / » → repo, otherwise org', () => {
  assert.equal(parseScope(''), null);
  assert.equal(parseScope('   '), null);
  assert.equal(parseScope(null), null);
  assert.deepEqual(parseScope('symfony'), { type: 'org', value: 'symfony' });
  assert.deepEqual(parseScope(' noctud/collection '), { type: 'repo', value: 'noctud/collection' });
});

test('normalizeFavorites: dedup, trim, ignore unusable values', () => {
  assert.deepEqual(normalizeFavorites(['symfony', ' symfony ', 'zenstruck']), ['symfony', 'zenstruck']);
  assert.deepEqual(normalizeFavorites(['', '   ', null, 42, {}, 'a']), ['a']);
  assert.deepEqual(normalizeFavorites(undefined), []);
  assert.deepEqual(normalizeFavorites('symfony'), []); // tampered file: not an array
});

test('normalizeFavorites preserves insertion order', () => {
  assert.deepEqual(normalizeFavorites(['z', 'a', 'm']), ['z', 'a', 'm']);
});

test('addFavorite: appends at the end, idempotent, refuses empty', () => {
  assert.deepEqual(addFavorite([], 'symfony'), ['symfony']);
  assert.deepEqual(addFavorite(['symfony'], 'zenstruck'), ['symfony', 'zenstruck']);
  assert.deepEqual(addFavorite(['symfony'], ' symfony '), ['symfony']); // already there → unchanged
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
  assert.deepEqual(favoriteScopes(['symfony', 'noctud/collection']), [
    { type: 'org', value: 'symfony' },
    { type: 'repo', value: 'noctud/collection' },
  ]);
  assert.equal(favoriteScopes([]), null);
  assert.equal(favoriteScopes(undefined), null);
});

test('activeFavoriteOf: null if absent, unknown, or removed from the list', () => {
  assert.equal(activeFavoriteOf({ activeFav: 'symfony' }, ['symfony', 'z']), 'symfony');
  assert.equal(activeFavoriteOf({ activeFav: 'symfony' }, ['z']), null); // removed since
  assert.equal(activeFavoriteOf({}, ['symfony']), null);
  assert.equal(activeFavoriteOf({ activeFav: 42 }, ['symfony']), null); // tampered file
  assert.equal(activeFavoriteOf(null, ['symfony']), null);
});

test('cycleFavorite: all → 1st → … → last → all', () => {
  const list = ['symfony', 'noctud/collection', 'zenstruck'];
  assert.equal(cycleFavorite(list, null), 'symfony');
  assert.equal(cycleFavorite(list, 'symfony'), 'noctud/collection');
  assert.equal(cycleFavorite(list, 'noctud/collection'), 'zenstruck');
  assert.equal(cycleFavorite(list, 'zenstruck'), null); // full loop
});

test('cycleFavorite: empty list stays on null, unknown active restarts from the beginning', () => {
  assert.equal(cycleFavorite([], null), null);
  assert.equal(cycleFavorite([], 'symfony'), null);
  assert.equal(cycleFavorite(['a', 'b'], 'vanished'), 'a');
});

// Example data: two perimeters mixed, as after a collection on the union.
const data = () => ({
  mine: [{ repo: 'symfony/api', number: 1 }, { repo: 'zenstruck/foundry', number: 2 }],
  others: [{ repo: 'symfony/front', number: 3 }, { repo: 'zenstruck/foundry', number: 4 }],
  hidden: [{ repo: 'zenstruck/foundry', number: 5 }],
  hiddenCount: 1,
  notifications: [{ repo: 'symfony/api', number: 1 }, { repo: 'zenstruck/foundry', number: 2 }],
  debug: [{ repo: 'symfony/api' }, { repo: 'zenstruck/foundry' }],
  approvalEvents: [{ repo: 'zenstruck/foundry' }],
});

test('filterDataByScope: filters all lists and recomputes hiddenCount', () => {
  const out = filterDataByScope(data(), { type: 'org', value: 'symfony' });
  assert.deepEqual(out.mine.map((r) => r.number), [1]);
  assert.deepEqual(out.others.map((r) => r.number), [3]);
  assert.deepEqual(out.hidden, []);
  assert.equal(out.hiddenCount, 0); // recomputed, not inherited from the original 1
  assert.deepEqual(out.notifications.map((r) => r.number), [1]);
  assert.deepEqual(out.debug, [{ repo: 'symfony/api' }]);
});

test('filterDataByScope: precise repo scope', () => {
  const out = filterDataByScope(data(), { type: 'repo', value: 'zenstruck/foundry' });
  assert.deepEqual(out.mine.map((r) => r.number), [2]);
  assert.deepEqual(out.others.map((r) => r.number), [4]);
  assert.equal(out.hiddenCount, 1);
});

test('filterDataByScope: null scope → data unchanged (same references)', () => {
  const d = data();
  assert.equal(filterDataByScope(d, null), d);
});

test('filterDataByScope does not mutate the source data (the raw one serves the notifs)', () => {
  const d = data();
  filterDataByScope(d, { type: 'org', value: 'symfony' });
  assert.equal(d.mine.length, 2);
  assert.equal(d.hiddenCount, 1);
});

test('filterDataByScope: the non-filtered keys are kept as-is', () => {
  // approvalEvents feeds the desktop notifs: it must not be filtered here.
  const out = filterDataByScope(data(), { type: 'org', value: 'symfony' });
  assert.deepEqual(out.approvalEvents, [{ repo: 'zenstruck/foundry' }]);
});

test('favoriteLabel: org → « org/* », repo unchanged (display only)', () => {
  assert.equal(favoriteLabel('symfony'), 'symfony/*');
  assert.equal(favoriteLabel('noctud/collection'), 'noctud/collection');
  assert.equal(favoriteLabel(' zenstruck '), 'zenstruck/*');
  assert.equal(favoriteLabel(''), '');
  assert.equal(favoriteLabel(null), '');
});

test('favoriteCounts: others’ activity per favorite + total, on the raw union', () => {
  const others = [
    { repo: 'symfony/api' }, { repo: 'symfony/front' },
    { repo: 'noctud/collection' }, { repo: 'zenstruck/foundry' },
  ];
  const { total, byFav } = favoriteCounts(['symfony', 'noctud/collection', 'zenstruck'], others);
  assert.equal(total, 4);
  assert.deepEqual(byFav, { symfony: 2, 'noctud/collection': 1, zenstruck: 1 });
});

test('favoriteCounts: empty/invalid list or data → zeros, no crash', () => {
  assert.deepEqual(favoriteCounts([], []), { total: 0, byFav: {} });
  assert.deepEqual(favoriteCounts(['symfony'], null), { total: 0, byFav: { symfony: 0 } });
  assert.deepEqual(favoriteCounts(null, [{ repo: 'a/b' }]), { total: 1, byFav: {} });
});

test('closedPRsUrl: without scope → GitHub search author:@me is:closed', () => {
  assert.equal(
    closedPRsUrl(null),
    'https://github.com/pulls?q=is%3Apr%20author%3A%40me%20is%3Aclosed',
  );
});

test('closedPRsUrl: org / repo scope → qualifier added (encoded)', () => {
  assert.ok(closedPRsUrl({ type: 'org', value: 'symfony' }).endsWith('%20org%3Asymfony'));
  assert.ok(closedPRsUrl({ type: 'repo', value: 'noctud/collection' }).endsWith('%20repo%3Anoctud%2Fcollection'));
});

test('closedPRsUrl: union of scopes → all qualifiers (OR-ed by GitHub)', () => {
  const url = closedPRsUrl([{ type: 'org', value: 'symfony' }, { type: 'repo', value: 'a/b' }]);
  assert.ok(url.includes('org%3Asymfony'));
  assert.ok(url.includes('repo%3Aa%2Fb'));
});
