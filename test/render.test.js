import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY } from '../src/filter.js';
import { renderList, hyperlink, truncate, displayWidth } from '../src/render.js';

// Pour des assertions de mise en page déterministes, on désactive couleur et liens.
const PLAIN = { color: false, hyperlinks: false };

test('rendu vide', () => {
  assert.match(renderList([], [], PLAIN), /Rien à signaler/);
});

test('rend une review demandée dans un tableau encadré', () => {
  const items = [{ category: CATEGORY.REVIEW_REQUEST, repo: 'o/r', number: 42, title: 'PR A', url: 'https://github.com/o/r/pull/42', actor: null }];
  const out = renderList(items, [], PLAIN);
  assert.match(out, /Reviews demandées \(1\)/);
  assert.match(out, /┌.*┐/);
  assert.match(out, /Dépôt/);
  assert.match(out, /o\/r/);
  assert.match(out, /#42/);
  assert.match(out, /PR A/);
});

test('section avec acteur : en-tête « Titre / Qui » et suffixe @acteur', () => {
  const items = [{ category: CATEGORY.MENTION, repo: 'o/r', number: 120, title: 'fix header', url: 'u', actor: 'alice' }];
  const out = renderList(items, [], PLAIN);
  assert.match(out, /Mentions \(1\)/);
  assert.match(out, /Titre \/ Qui/);
  assert.ok(out.includes('fix header — @alice'));
});

test('mention sans auteur résolu → pas de @null', () => {
  const items = [{ category: CATEGORY.MENTION, repo: 'o/r', number: 5, title: 'PR M', url: 'u', actor: null }];
  const out = renderList(items, [], PLAIN);
  assert.ok(!out.includes('@null'), 'ne doit jamais afficher @null');
  assert.match(out, /Mentions \(1\)/);
  assert.ok(out.includes('PR M'));
});

test('réponse à un commentaire : suffixe @acteur', () => {
  const items = [{ category: CATEGORY.THREAD_REPLY, repo: 'o/r', number: 7, title: 'PR T', url: 'u', actor: 'carol' }];
  const out = renderList(items, [], PLAIN);
  assert.match(out, /Réponses à tes commentaires \(1\)/);
  assert.ok(out.includes('PR T — @carol'));
});

test('rend la section reviews en attente avec lien', () => {
  const pending = [{ repo: 'o/r', number: 98, title: 'PR X', url: 'https://github.com/o/r/pull/98', updatedAt: '2026-06-20T09:00:00Z' }];
  const out = renderList([], pending, PLAIN);
  assert.match(out, /Reviews en attente \(1\)/);
  assert.match(out, /#98/);
  assert.match(out, /PR X/);
});

test('omet les catégories vides', () => {
  const items = [{ category: CATEGORY.MENTION, repo: 'o/r', number: 1, title: 'T', url: 'u', actor: 'alice' }];
  const out = renderList(items, [], PLAIN);
  assert.doesNotMatch(out, /Reviews demandées/);
  assert.match(out, /Mentions \(1\)/);
});

test('alignement : toutes les lignes d’un tableau ont la même largeur', () => {
  const items = [
    { category: CATEGORY.REVIEW_REQUEST, repo: 'mapado/oauth-server', number: 388, title: 'feat: add api to create global private application here', url: 'u', actor: null },
    { category: CATEGORY.REVIEW_REQUEST, repo: 'a/b', number: 1, title: 'x', url: 'u', actor: null },
  ];
  const out = renderList(items, [], PLAIN);
  const tableLines = out.split('\n').filter((l) => /^[┌├└│]/.test(l));
  const widths = new Set(tableLines.map(displayWidth));
  assert.equal(widths.size, 1, `largeurs incohérentes: ${[...widths].join(',')}`);
});

test('troncature des titres trop longs', () => {
  const items = [{ category: CATEGORY.REVIEW_REQUEST, repo: 'o/r', number: 1, title: 'x'.repeat(200), url: 'u', actor: null }];
  const out = renderList(items, [], PLAIN);
  assert.ok(out.includes('…'), 'un titre trop long doit être tronqué avec …');
});

// ── helpers purs ─────────────────────────────────────────────────────────
test('hyperlink: enveloppe en OSC 8 quand activé', () => {
  const s = hyperlink('https://x', 'texte', { hyperlinks: true });
  assert.ok(s.startsWith('\x1b]8;;https://x\x1b\\'));
  assert.ok(s.includes('texte'));
});

test('hyperlink: texte brut quand désactivé ou sans url', () => {
  assert.equal(hyperlink('https://x', 'texte', { hyperlinks: false }), 'texte');
  assert.equal(hyperlink(null, 'texte', { hyperlinks: true }), 'texte');
});

test('displayWidth: ASCII = longueur, emoji = 2', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🔍'), 2);
});

test('truncate: respecte la largeur max et ajoute …', () => {
  const t = truncate('abcdefghij', 5);
  assert.equal(t, 'abcd…');
  assert.ok(displayWidth(t) <= 5);
  assert.equal(truncate('abc', 5), 'abc');
});

test('couleur: aucune séquence ANSI quand color:false, présente quand color:true', () => {
  const items = [{ category: CATEGORY.REVIEW_REQUEST, repo: 'o/r', number: 1, title: 'T', url: 'u', actor: null }];
  assert.ok(!renderList(items, [], { color: false, hyperlinks: false }).includes('\x1b['));
  assert.ok(renderList(items, [], { color: true, hyperlinks: false }).includes('\x1b['));
});
