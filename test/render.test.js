import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderList, hyperlink, truncate, displayWidth,
  triggersLabel, ciIcon, relativeDate, diffStat,
} from '../src/render.js';

// Mise en page déterministe : couleur et liens désactivés, `now` fixe.
const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const PLAIN = { color: false, hyperlinks: false, now: NOW };

const myRow = (over = {}) => ({ repo: 'mapado/web', number: 120, url: 'u', title: 'fix header', triggers: ['comment'], ci: 'pass', ...over });
const otherRow = (over = {}) => ({ repo: 'mapado/api', number: 55, url: 'u', title: 'perf: cache', triggers: ['review'], ci: 'pass', author: 'alice', createdAt: '2026-06-21T12:00:00Z', additions: 412, deletions: 38, ...over });

test('rendu vide', () => {
  assert.match(renderList({ mine: [], others: [] }, PLAIN), /Rien à signaler/);
});

test('tableau « tes PR » : Triggers + CI, pas de colonne Auteur', () => {
  const out = renderList({ mine: [myRow({ triggers: ['comment', 'mention'] })], others: [] }, PLAIN);
  assert.match(out, /Activité sur tes PR \(1\)/);
  assert.match(out, /┌.*┐/);
  assert.match(out, /Triggers/);
  assert.ok(out.includes('🗨 commentaire'));
  assert.ok(out.includes('💬 mention'));
  assert.ok(out.includes('✅'));
  assert.doesNotMatch(out, /Auteur/);
});

test('tableau « autres PR » : Auteur, Ouverte, Diff', () => {
  const out = renderList({ mine: [], others: [otherRow()] }, PLAIN);
  assert.match(out, /Activité sur les PR des autres \(1\)/);
  assert.match(out, /Auteur/);
  assert.match(out, /Ouverte/);
  assert.match(out, /Diff/);
  assert.ok(out.includes('@alice'));
  assert.ok(out.includes('il y a 3j'));
  assert.ok(out.includes('+412'));
  assert.ok(out.includes('−38'));
});

test('les deux tableaux peuvent coexister', () => {
  const out = renderList({ mine: [myRow()], others: [otherRow()] }, PLAIN);
  assert.match(out, /Activité sur tes PR \(1\)/);
  assert.match(out, /Activité sur les PR des autres \(1\)/);
});

test('alignement : chaque tableau a toutes ses lignes de même largeur (emojis inclus)', () => {
  const others = [
    otherRow({ repo: 'mapado/oauth-server', title: 'feat: add api to create a very very long thing', triggers: ['review', 'mention', 'reply', 'comment'], ci: 'fail', additions: 7, deletions: 980 }),
    otherRow({ repo: 'a/b', number: 1, title: 'x', triggers: ['review'], ci: 'pending', author: 'bob', additions: 0, deletions: 5 }),
  ];
  const mine = [myRow({ triggers: ['mention', 'reply'], ci: 'none' }), myRow({ number: 7, title: 'y', triggers: ['comment'] })];
  const out = renderList({ mine, others }, PLAIN);
  // Chaque bloc-tableau : toutes les lignes box-drawing doivent avoir la même largeur.
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter((l) => /^[┌├└│]/.test(l));
    if (lines.length === 0) continue;
    const widths = new Set(lines.map(displayWidth));
    assert.equal(widths.size, 1, `largeurs incohérentes (${[...widths].join(',')}) dans:\n${block}`);
  }
});

// ── helpers purs ─────────────────────────────────────────────────────────
test('triggersLabel : ordonné, icône + libellé, séparés par ·', () => {
  assert.equal(triggersLabel(['mention', 'review']), '🔍 review · 💬 mention');
  assert.equal(triggersLabel(['reply']), '↩️ réponse');
  assert.equal(triggersLabel([]), '');
});

test('ciIcon', () => {
  assert.equal(ciIcon('pass'), '✅');
  assert.equal(ciIcon('fail'), '❌');
  assert.equal(ciIcon('pending'), '🟡');
  assert.equal(ciIcon('none'), '·');
});

test('relativeDate', () => {
  assert.equal(relativeDate('2026-06-21T12:00:00Z', NOW), 'il y a 3j');
  assert.equal(relativeDate('2026-06-24T07:00:00Z', NOW), 'il y a 5h');
  assert.equal(relativeDate('2026-06-24T11:30:00Z', NOW), 'il y a 30min');
  assert.equal(relativeDate(null, NOW), '?');
});

test('diffStat : texte brut + barre de 5 blocs, rendu coloré', () => {
  const d = diffStat(412, 38);
  assert.ok(d.text.startsWith('+412 −38 '));
  const blocks = [...d.text].filter((c) => c === '🟩' || c === '🟥').length;
  assert.equal(blocks, 5);
  assert.ok(d.render({ color: true }).includes('\x1b[32m'), 'ajouts en vert');
  assert.ok(d.render({ color: true }).includes('\x1b[31m'), 'retraits en rouge');
});

test('diffStat : diff vide → pas de barre', () => {
  const d = diffStat(0, 0);
  assert.equal(d.text, '+0 −0');
});

test('displayWidth : ASCII=1, emoji simple=2, emoji+VS16 (↩️)=2, box=1', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🔍'), 2);
  assert.equal(displayWidth('↩️'), 2);   // base U+21A9 + VS16 U+FE0F
  assert.equal(displayWidth('🗨'), 2);
  assert.equal(displayWidth('─┌│'), 3);   // box-drawing : 1 chacun
  assert.equal(displayWidth('−'), 1);     // signe moins U+2212
});

test('hyperlink: OSC 8 quand activé, brut sinon', () => {
  assert.ok(hyperlink('https://x', 't', { hyperlinks: true }).startsWith('\x1b]8;;https://x\x1b\\'));
  assert.equal(hyperlink('https://x', 't', { hyperlinks: false }), 't');
  assert.equal(hyperlink(null, 't', { hyperlinks: true }), 't');
});

test('truncate: largeur max + …', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
});

test('couleur: ANSI absent si color:false, présent si color:true', () => {
  const data = { mine: [myRow()], others: [] };
  assert.ok(!renderList(data, { color: false, hyperlinks: false, now: NOW }).includes('\x1b['));
  assert.ok(renderList(data, { color: true, hyperlinks: false, now: NOW }).includes('\x1b['));
});
