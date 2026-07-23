import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUALIFIER_LENGTH, parseScope, normalizeFavorites, addFavorite, removeFavorite,
  favoriteScopes, activeFavoriteOf, cycleFavorite, filterDataByScope, favoriteLabel, favoriteCounts,
  closedPRsUrl,
} from '../src/favorites.js';
import { scopesQualifier } from '../src/collect.js';

test('parseScope : vide → null, avec « / » → repo, sinon org', () => {
  assert.equal(parseScope(''), null);
  assert.equal(parseScope('   '), null);
  assert.equal(parseScope(null), null);
  assert.deepEqual(parseScope('mapado'), { type: 'org', value: 'mapado' });
  assert.deepEqual(parseScope(' noctud/collection '), { type: 'repo', value: 'noctud/collection' });
});

test('normalizeFavorites : dédup, trim, ignore les valeurs inexploitables', () => {
  assert.deepEqual(normalizeFavorites(['mapado', ' mapado ', 'zenstruck']), ['mapado', 'zenstruck']);
  assert.deepEqual(normalizeFavorites(['', '   ', null, 42, {}, 'a']), ['a']);
  assert.deepEqual(normalizeFavorites(undefined), []);
  assert.deepEqual(normalizeFavorites('mapado'), []); // fichier trafiqué : pas un tableau
});

test('normalizeFavorites préserve l’ordre d’ajout', () => {
  assert.deepEqual(normalizeFavorites(['z', 'a', 'm']), ['z', 'a', 'm']);
});

test('addFavorite : ajoute en fin, idempotent, refuse le vide', () => {
  assert.deepEqual(addFavorite([], 'mapado'), ['mapado']);
  assert.deepEqual(addFavorite(['mapado'], 'zenstruck'), ['mapado', 'zenstruck']);
  assert.deepEqual(addFavorite(['mapado'], ' mapado '), ['mapado']); // déjà là → inchangé
  assert.throws(() => addFavorite([], '  '), /requiert une valeur/);
});

// Remplit jusqu'au refus et renvoie la dernière liste acceptée.
function fillUntilFull(name) {
  let list = [];
  for (let i = 0; i < 100; i++) {
    try { list = addFavorite(list, name(i)); } catch { return list; }
  }
  assert.fail('addFavorite aurait dû finir par refuser');
}

test('addFavorite : ce qui est accepté tient toujours dans une query GitHub', () => {
  // L'invariant qui compte : quoi qu'on épingle, la recherche reste valide
  // (< 256 caractères, préfixe `is:open is:pr review-requested:@me` inclus).
  for (const name of [(i) => `org${i}`, (i) => `organisation-tres-longue-${i}/depot-interminable-${i}`]) {
    const list = fillUntilFull(name);
    const q = `is:open is:pr review-requested:@me${scopesQualifier(favoriteScopes(list))}`;
    assert.ok(q.length < 256, `query de ${q.length} caractères`);
  }
});

test('addFavorite : le plafond dépend de la longueur des noms, pas de leur nombre', () => {
  const courts = fillUntilFull((i) => `org${i}`);
  const longs = fillUntilFull((i) => `organisation-tres-longue-${i}/depot-interminable-${i}`);
  assert.ok(courts.length > longs.length,
    `noms courts (${courts.length}) doivent en accepter plus que noms longs (${longs.length})`);
});

test('addFavorite : un doublon passe même une fois le plafond atteint', () => {
  const list = fillUntilFull((i) => `org${i}`);
  assert.deepEqual(addFavorite(list, list[0]), list); // idempotent, pas d'erreur
  assert.throws(() => addFavorite(list, 'un-nouveau-favori-de-trop'), /dépasserait/);
});

test('MAX_QUALIFIER_LENGTH laisse de la marge sous la limite GitHub de 256', () => {
  assert.ok(MAX_QUALIFIER_LENGTH < 256 - 34); // 34 = `is:open is:pr review-requested:@me`
});

test('removeFavorite : retire, no-op sur valeur absente', () => {
  assert.deepEqual(removeFavorite(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(removeFavorite(['a', 'b'], 'zzz'), ['a', 'b']);
  assert.deepEqual(removeFavorite([], 'a'), []);
});

test('favoriteScopes : liste → scopes, liste vide → null (= pas de filtre)', () => {
  assert.deepEqual(favoriteScopes(['mapado', 'noctud/collection']), [
    { type: 'org', value: 'mapado' },
    { type: 'repo', value: 'noctud/collection' },
  ]);
  assert.equal(favoriteScopes([]), null);
  assert.equal(favoriteScopes(undefined), null);
});

test('activeFavoriteOf : null si absent, inconnu, ou retiré de la liste', () => {
  assert.equal(activeFavoriteOf({ activeFav: 'mapado' }, ['mapado', 'z']), 'mapado');
  assert.equal(activeFavoriteOf({ activeFav: 'mapado' }, ['z']), null); // retiré depuis
  assert.equal(activeFavoriteOf({}, ['mapado']), null);
  assert.equal(activeFavoriteOf({ activeFav: 42 }, ['mapado']), null); // fichier trafiqué
  assert.equal(activeFavoriteOf(null, ['mapado']), null);
});

test('cycleFavorite : tous → 1er → … → dernier → tous', () => {
  const list = ['mapado', 'noctud/collection', 'zenstruck'];
  assert.equal(cycleFavorite(list, null), 'mapado');
  assert.equal(cycleFavorite(list, 'mapado'), 'noctud/collection');
  assert.equal(cycleFavorite(list, 'noctud/collection'), 'zenstruck');
  assert.equal(cycleFavorite(list, 'zenstruck'), null); // boucle complète
});

test('cycleFavorite : liste vide reste sur null, actif inconnu repart du début', () => {
  assert.equal(cycleFavorite([], null), null);
  assert.equal(cycleFavorite([], 'mapado'), null);
  assert.equal(cycleFavorite(['a', 'b'], 'disparu'), 'a');
});

// Données d'exemple : deux périmètres mêlés, comme après une collecte sur l'union.
const data = () => ({
  mine: [{ repo: 'mapado/api', number: 1 }, { repo: 'zenstruck/foundry', number: 2 }],
  others: [{ repo: 'mapado/front', number: 3 }, { repo: 'zenstruck/foundry', number: 4 }],
  hidden: [{ repo: 'zenstruck/foundry', number: 5 }],
  hiddenCount: 1,
  notifications: [{ repo: 'mapado/api', number: 1 }, { repo: 'zenstruck/foundry', number: 2 }],
  debug: [{ repo: 'mapado/api' }, { repo: 'zenstruck/foundry' }],
  approvalEvents: [{ repo: 'zenstruck/foundry' }],
});

test('filterDataByScope : filtre toutes les listes et recalcule hiddenCount', () => {
  const out = filterDataByScope(data(), { type: 'org', value: 'mapado' });
  assert.deepEqual(out.mine.map((r) => r.number), [1]);
  assert.deepEqual(out.others.map((r) => r.number), [3]);
  assert.deepEqual(out.hidden, []);
  assert.equal(out.hiddenCount, 0); // recalculé, pas hérité du 1 d'origine
  assert.deepEqual(out.notifications.map((r) => r.number), [1]);
  assert.deepEqual(out.debug, [{ repo: 'mapado/api' }]);
});

test('filterDataByScope : scope repo précis', () => {
  const out = filterDataByScope(data(), { type: 'repo', value: 'zenstruck/foundry' });
  assert.deepEqual(out.mine.map((r) => r.number), [2]);
  assert.deepEqual(out.others.map((r) => r.number), [4]);
  assert.equal(out.hiddenCount, 1);
});

test('filterDataByScope : scope null → données inchangées (mêmes références)', () => {
  const d = data();
  assert.equal(filterDataByScope(d, null), d);
});

test('filterDataByScope ne mute pas la donnée source (le brut sert aux notifs)', () => {
  const d = data();
  filterDataByScope(d, { type: 'org', value: 'mapado' });
  assert.equal(d.mine.length, 2);
  assert.equal(d.hiddenCount, 1);
});

test('filterDataByScope : les clés non filtrées sont conservées telles quelles', () => {
  // approvalEvents alimente les notifs desktop : il n'a pas à être filtré ici.
  const out = filterDataByScope(data(), { type: 'org', value: 'mapado' });
  assert.deepEqual(out.approvalEvents, [{ repo: 'zenstruck/foundry' }]);
});

test('favoriteLabel : org → « org/* », dépôt inchangé (affichage seulement)', () => {
  assert.equal(favoriteLabel('mapado'), 'mapado/*');
  assert.equal(favoriteLabel('noctud/collection'), 'noctud/collection');
  assert.equal(favoriteLabel(' zenstruck '), 'zenstruck/*');
  assert.equal(favoriteLabel(''), '');
  assert.equal(favoriteLabel(null), '');
});

test('favoriteCounts : activité des autres par favori + total, sur l’union brute', () => {
  const others = [
    { repo: 'mapado/api' }, { repo: 'mapado/front' },
    { repo: 'noctud/collection' }, { repo: 'zenstruck/foundry' },
  ];
  const { total, byFav } = favoriteCounts(['mapado', 'noctud/collection', 'zenstruck'], others);
  assert.equal(total, 4);
  assert.deepEqual(byFav, { mapado: 2, 'noctud/collection': 1, zenstruck: 1 });
});

test('favoriteCounts : liste/données vides ou invalides → zéros, pas de crash', () => {
  assert.deepEqual(favoriteCounts([], []), { total: 0, byFav: {} });
  assert.deepEqual(favoriteCounts(['mapado'], null), { total: 0, byFav: { mapado: 0 } });
  assert.deepEqual(favoriteCounts(null, [{ repo: 'a/b' }]), { total: 1, byFav: {} });
});

test('closedPRsUrl : sans scope → recherche GitHub author:@me is:closed', () => {
  assert.equal(
    closedPRsUrl(null),
    'https://github.com/pulls?q=is%3Apr%20author%3A%40me%20is%3Aclosed',
  );
});

test('closedPRsUrl : scope org / repo → qualifier ajouté (encodé)', () => {
  assert.ok(closedPRsUrl({ type: 'org', value: 'mapado' }).endsWith('%20org%3Amapado'));
  assert.ok(closedPRsUrl({ type: 'repo', value: 'noctud/collection' }).endsWith('%20repo%3Anoctud%2Fcollection'));
});

test('closedPRsUrl : union de scopes → tous les qualifiers (OR-isés par GitHub)', () => {
  const url = closedPRsUrl([{ type: 'org', value: 'mapado' }, { type: 'repo', value: 'a/b' }]);
  assert.ok(url.includes('org%3Amapado'));
  assert.ok(url.includes('repo%3Aa%2Fb'));
});
