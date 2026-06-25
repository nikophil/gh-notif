import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderFragment } from '../src/html.js';

const NOW = new Date('2026-06-24T12:00:00Z').getTime();

const myRow = (over = {}) => ({
  repo: 'mapado/web', number: 120, url: 'https://github.com/mapado/web/pull/120',
  title: 'fix header', triggers: ['comment'], ci: 'pass', state: 'open', approvals: 0, ...over,
});
const otherRow = (over = {}) => ({
  repo: 'mapado/api', number: 55, url: 'https://github.com/mapado/api/pull/55',
  title: 'perf: cache', triggers: ['review'], ci: 'pass', author: 'alice',
  createdAt: '2026-06-21T12:00:00Z', additions: 412, deletions: 38, state: 'open', approvals: 2, ...over,
});

test('escapeHtml : échappe & < > " \'', () => {
  assert.equal(escapeHtml('a <b> & "c" \'d\''), 'a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;');
});

test('escapeHtml : non-string → chaîne vide', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('renderFragment : titres de section avec compteurs', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow(), otherRow({ number: 9 })] }, { now: NOW });
  assert.match(out, /📥 Tes PR ouvertes \(1\)/);
  assert.match(out, /👥 Activité sur les PR des autres \(2\)/);
});

test('renderFragment : lien vers la PR', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.ok(out.includes('href="https://github.com/mapado/web/pull/120"'));
});

test('renderFragment : titre dangereux échappé (pas d’injection)', () => {
  const out = renderFragment({ mine: [myRow({ title: '[X] <script>alert(1)</script> & co' })], others: [] }, { now: NOW });
  assert.ok(out.includes('&lt;script&gt;'), 'le titre doit être échappé');
  assert.ok(!out.includes('<script>alert(1)'), 'aucune balise script brute injectée');
  assert.ok(out.includes('&amp; co'));
});

test('renderFragment : emojis état / CI / triggers', () => {
  const out = renderFragment({ mine: [myRow({ state: 'draft', ci: 'fail', triggers: ['mention', 'reply'] })], others: [] }, { now: NOW });
  assert.ok(out.includes('📝'));        // état draft
  assert.ok(out.includes('❌'));        // CI fail
  assert.ok(out.includes('💬'));        // trigger mention
  assert.ok(out.includes('↩️'));        // trigger reply
});

test('renderFragment : approbations (nombre, · si zéro)', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 3 })], others: [myRow({ number: 7, approvals: 0 })] }, { now: NOW });
  assert.ok(out.includes('3'));
});

test('renderFragment : autres → auteur, date relative, diff +/−', () => {
  const out = renderFragment({ mine: [], others: [otherRow({ state: 'merged', approvals: 4 })] }, { now: NOW });
  assert.ok(out.includes('@alice'));
  assert.ok(out.includes('il y a 3j'));     // relativeDate
  assert.ok(out.includes('+412'));          // diff ajouts
  assert.ok(out.includes('−38'));           // diff retraits (U+2212)
  assert.ok(out.includes('🟣'));            // état mergée
});

test('renderFragment : diff en deux spans distincts (ajouts vert / retraits rouge)', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW });
  assert.match(out, /class="add"[^>]*>\+412</);
  assert.match(out, /class="del"[^>]*>−38</);
});

test('renderFragment : état vide → « Rien à signaler »', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW });
  assert.match(out, /Rien à signaler/);
});

test('renderFragment : seulement « mine » (others vide) n’affiche pas la section autres', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.match(out, /Tes PR ouvertes/);
  assert.doesNotMatch(out, /Activité sur les PR des autres/);
});
