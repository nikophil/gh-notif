import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS, DEFAULT_SORT, normalizeSort, toggleSort, sortRows } from '../src/sort.js';

// Fixtures : 3 PR aux valeurs toutes distinctes (auteur volontairement avec
// une casse mélangée pour tester l'insensibilité à la casse).
const rows = () => [
  { repo: 'o/a', number: 1, author: 'zoe', createdAt: '2026-07-20T00:00:00Z', approvals: 2 },
  { repo: 'o/b', number: 2, author: 'Alice', createdAt: '2026-07-22T00:00:00Z', approvals: 0 },
  { repo: 'o/c', number: 3, author: 'bob', createdAt: '2026-07-21T00:00:00Z', approvals: 1 },
];
const order = (list) => list.map((r) => r.number);

test('normalizeSort : valide passe, invalide/absent → défaut', () => {
  assert.deepEqual(normalizeSort({ key: 'author', dir: 'asc' }), { key: 'author', dir: 'asc' });
  assert.deepEqual(normalizeSort(null), DEFAULT_SORT);
  assert.deepEqual(normalizeSort(undefined), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'nope', dir: 'asc' }), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'date', dir: 'sideways' }), DEFAULT_SORT);
  assert.deepEqual(DEFAULT_SORT, { key: 'date', dir: 'desc' });
  assert.deepEqual(SORT_KEYS, ['date', 'approvals', 'author']);
});

test('normalizeSort renvoie une copie (jamais DEFAULT_SORT lui-même)', () => {
  const s = normalizeSort(null);
  s.dir = 'asc';
  assert.equal(DEFAULT_SORT.dir, 'desc'); // pas pollué par la mutation
});

test('toggleSort : même colonne → inverse le sens', () => {
  assert.deepEqual(toggleSort({ key: 'date', dir: 'desc' }, 'date'), { key: 'date', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'date'), { key: 'date', dir: 'desc' });
});

test('toggleSort : autre colonne → REMPLACE, avec le sens par défaut de la colonne', () => {
  // date → récent d'abord ; approvals → les moins approuvées d'abord ; author → A→Z
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'approvals'), { key: 'approvals', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'approvals', dir: 'desc' }, 'author'), { key: 'author', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'author', dir: 'desc' }, 'date'), { key: 'date', dir: 'desc' });
});

test('sortRows : date desc (défaut) → plus récente d\'abord ; asc → inverse', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'asc' })), [1, 3, 2]);
});

test('sortRows : approvals asc → les moins approuvées d\'abord', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows : author insensible à la casse (Alice < bob < zoe)', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows : valeurs manquantes en FIN quel que soit le sens', () => {
  const withNulls = [
    { number: 1, author: null, createdAt: null, approvals: 0 },
    { number: 2, author: 'bob', createdAt: '2026-07-22T00:00:00Z', approvals: 1 },
    { number: 3, author: 'alice', createdAt: '2026-07-20T00:00:00Z', approvals: 2 },
  ];
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'desc' })), [2, 3, 1]);
});

test('sortRows : égalité → ordre d\'arrivée conservé (stable)', () => {
  const ties = [
    { number: 1, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 2, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 3, approvals: 1, author: 'a', createdAt: 'x' },
  ];
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'asc' })), [1, 2, 3]);
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'desc' })), [1, 2, 3]);
});

test('sortRows : ne mute pas l\'entrée, tolère null/undefined', () => {
  const input = rows();
  const before = order(input);
  sortRows(input, { key: 'date', dir: 'asc' });
  assert.deepEqual(order(input), before);
  assert.deepEqual(sortRows(null, DEFAULT_SORT), []);
  assert.deepEqual(sortRows(undefined, DEFAULT_SORT), []);
});

test('sortRows : sort invalide → tri par défaut (date desc), pas de crash', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'nope' })), [2, 3, 1]);
});
