import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderFragment, renderShell, renderLoading } from '../src/html.js';

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

test('renderFragment : tooltips (title) sur les icônes', () => {
  const out = renderFragment(
    { mine: [myRow({ state: 'merged', ci: 'pass', triggers: ['review', 'comment'], approvals: 2 })], others: [] },
    { now: NOW },
  );
  assert.match(out, /title="Mergée"/);
  assert.match(out, /title="CI : succès"/);
  assert.match(out, /title="Review demandée"/);
  assert.match(out, /title="Commentaire sur ta PR"/);
  assert.match(out, /title="2 approbations"/);
});

test('renderFragment : tooltip « Aucune approbation » quand 0', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 0 })], others: [] }, { now: NOW });
  assert.match(out, /title="Aucune approbation"/);
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

test('renderFragment : liens en nouvel onglet (_blank + noopener)', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener"/);
});

test('renderFragment : bouton de masquage (✕) sur les lignes « autres », pas sur les miennes', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  // un bouton d'action ciblant la PR des autres
  assert.match(out, /class="act"[^>]*data-key="mapado\/api#55"[^>]*data-act="hide"/);
  // la section « mine » (1re section) n'a pas de bouton act
  const mineSection = out.split('👥')[0];
  assert.ok(!mineSection.includes('class="act"'));
});

test('renderFragment : showHidden affiche les lignes masquées (grisées + restaurer)', () => {
  const data = {
    mine: [],
    others: [otherRow()],
    hidden: [otherRow({ repo: 'mapado/old', number: 9, title: 'vieille PR' })],
    hiddenCount: 1,
  };
  const shown = renderFragment(data, { now: NOW, showHidden: true });
  assert.match(shown, /class="hid"/);                       // ligne grisée
  assert.match(shown, /data-key="mapado\/old#9"[^>]*data-act="show"/); // bouton restaurer
  assert.match(shown, /1 masquée/);                          // compteur dans le titre
  // sans showHidden : la ligne masquée n'apparaît pas
  const hiddenView = renderFragment(data, { now: NOW, showHidden: false });
  assert.ok(!hiddenView.includes('mapado/old#9'));
  assert.match(hiddenView, /1 masquée/); // compteur affiché même replié
});

// ── renderShell (page + polling) ───────────────────────────────────────────
test('renderShell : page HTML complète avec polling de /fragment', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.ok(out.startsWith('<!doctype html'), 'commence par le doctype');
  assert.ok(out.includes('id="content"'), 'conteneur rafraîchi');
  assert.ok(out.includes('/fragment'), 'endpoint poll');
  assert.ok(out.includes('10000'), 'intervalle injecté dans le JS');
});

test('renderShell : aucun asset externe (tout inline)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.ok(!/src="https?:/.test(out), 'pas de script externe');
  assert.ok(!/href="https?:[^"]*\.css/.test(out), 'pas de feuille de style externe');
});

test('renderShell : intervalMs par défaut si absent', () => {
  const out = renderShell();
  assert.ok(out.startsWith('<!doctype html'));
});

test('renderShell : embarque le style + l’usage du spinner', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /@keyframes ghn-spin/);     // animation définie
  assert.match(out, /class="spinner"/);          // utilisé (indicateur d'activité)
});

test('renderLoading : spinner + libellé + sentinelle data-loading', () => {
  const out = renderLoading();
  assert.match(out, /class="spinner"/);
  assert.match(out, /Chargement/);
  assert.match(out, /data-loading/);
});
