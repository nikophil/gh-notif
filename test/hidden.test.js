import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, signatureOf, isHidden, toggleHidden, reconcile, assignLabels } from '../src/hidden.js';

// NB : `category` porte les valeurs de CATEGORY (filter.js) : thread_reply / on_my_pr / mention.
const items = [
  { category: 'thread_reply', repo: 'o/r', number: 42, url: 'u1' },
  { category: 'mention', repo: 'o/r', number: 42, url: 'u2' },
  { category: 'review_request', repo: 'o/r', number: 42, url: 'pr-url' }, // ignoré (pas un trigger)
  { category: 'on_my_pr', repo: 'o/x', number: 7, url: 'u3' },
];

test('keyOf', () => {
  assert.equal(keyOf({ repo: 'o/r', number: 42 }), 'o/r#42');
});

test('signatureOf : URLs des items de trigger de la PR (review_request exclu)', () => {
  assert.deepEqual(signatureOf('o/r#42', items).sort(), ['u1', 'u2']);
  assert.deepEqual(signatureOf('o/x#7', items), ['u3']);
  assert.deepEqual(signatureOf('o/none#1', items), []);
});

test('toggleHidden : masque avec instantané puis restaure', () => {
  const map = {};
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#42'), true);
  assert.deepEqual(map['o/r#42'].seen.sort(), ['u1', 'u2']);
  assert.equal(map['o/r#42'].at, '2026-06-25T00:00:00.000Z');
  // re-toggle → restaure
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T01:00:00.000Z'), false);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile : dé-masque sur nouveau trigger, garde si signature inchangée', () => {
  const map = { 'o/r#42': { at: 'x', seen: ['u1', 'u2'] } };
  const entries = [{ repo: 'o/r', number: 42 }];
  // signature inchangée → reste masquée, pas de changement
  assert.equal(reconcile(map, entries, items), false);
  assert.equal(isHidden(map, 'o/r#42'), true);
  // nouvel évènement u9 → dé-masque
  const items2 = [...items, { category: 'thread_reply', repo: 'o/r', number: 42, url: 'u9' }];
  assert.equal(reconcile(map, entries, items2), true);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile : signature vide reste masquée (review en attente sans interaction)', () => {
  const map = { 'o/r#60': { at: 'x', seen: [] } };
  const entries = [{ repo: 'o/r', number: 60 }];
  assert.equal(reconcile(map, entries, []), false);
  assert.equal(isHidden(map, 'o/r#60'), true);
});

test('reconcile : élague une clé absente des entrées courantes', () => {
  const map = { 'o/r#99': { at: 'x', seen: [] } };
  assert.equal(reconcile(map, [{ repo: 'o/r', number: 1 }], []), true);
  assert.equal(isHidden(map, 'o/r#99'), false);
});

test('assignLabels : le label est le numéro de la PR', () => {
  const rows = [{ repo: 'o/r', number: 7004 }, { repo: 'o/x', number: 388 }];
  assert.deepEqual(assignLabels(rows), ['7004', '388']);
});
