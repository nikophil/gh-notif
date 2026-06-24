import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY } from '../src/filter.js';
import { renderList } from '../src/render.js';

test('rendu vide', () => {
  assert.match(renderList([], []), /Rien à signaler/);
});

test('rend une review demandée avec lien', () => {
  const items = [{ category: CATEGORY.REVIEW_REQUEST, repo: 'o/r', number: 42, title: 'PR A', url: 'https://github.com/o/r/pull/42', actor: null }];
  const out = renderList(items, []);
  assert.match(out, /Reviews demandées \(1\)/);
  assert.match(out, /o\/r #42/);
  assert.match(out, /https:\/\/github.com\/o\/r\/pull\/42/);
});

test('rend la section reviews en attente', () => {
  const pending = [{ repo: 'o/r', number: 98, title: 'PR X', url: 'https://github.com/o/r/pull/98', updatedAt: '2026-06-20T09:00:00Z' }];
  const out = renderList([], pending);
  assert.match(out, /Reviews en attente \(1\)/);
  assert.match(out, /o\/r #98/);
});

test('omet les catégories vides', () => {
  const items = [{ category: CATEGORY.MENTION, repo: 'o/r', number: 1, title: 'T', url: 'u', actor: 'alice' }];
  const out = renderList(items, []);
  assert.doesNotMatch(out, /Reviews demandées/);
  assert.match(out, /Mentions \(1\)/);
});

test('rend une réponse à un commentaire avec le suffixe correct', () => {
  const items = [{ category: CATEGORY.THREAD_REPLY, repo: 'o/r', number: 7, title: 'PR T', url: 'https://github.com/o/r/pull/7#discussion_r1', actor: 'carol' }];
  const out = renderList(items, []);
  assert.match(out, /Réponses à tes commentaires \(1\)/);
  assert.ok(out.includes('@carol t’a répondu'));
  assert.ok(!out.includes("t'a répondu"), "doit utiliser l'apostrophe typographique U+2019, pas ASCII");
  assert.match(out, /https:\/\/github.com\/o\/r\/pull\/7#discussion_r1/);
});
