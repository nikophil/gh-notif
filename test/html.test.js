import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderFragment, renderShell, renderLoading, renderDebug, renderDebugShell, renderFavorites } from '../src/html.js';

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

test('renderFragment : badge 🎉 prête à merger si PR à moi ouverte & ≥2 approbations', () => {
  const out = renderFragment({ mine: [myRow({ state: 'open', approvals: 2 })], others: [] }, { now: NOW });
  assert.ok(out.includes('🎉'), 'badge présent');
  assert.match(out, /title="Prête à merger"/);
});

test('renderFragment : pas de badge 🎉 sous le seuil ni sur draft/mergée', () => {
  assert.ok(!renderFragment({ mine: [myRow({ state: 'open', approvals: 1 })], others: [] }, { now: NOW }).includes('🎉'));
  assert.ok(!renderFragment({ mine: [myRow({ state: 'draft', approvals: 3 })], others: [] }, { now: NOW }).includes('🎉'));
  assert.ok(!renderFragment({ mine: [myRow({ state: 'merged', approvals: 3 })], others: [] }, { now: NOW }).includes('🎉'));
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
test('renderShell : page HTML complète avec polling de /view', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.ok(out.startsWith('<!doctype html'), 'commence par le doctype');
  assert.ok(out.includes('id="content"'), 'conteneur rafraîchi');
  // Le poll client passe par /view ({chips, fragment, updatedAt}) : la barre de
  // favoris (compteurs) se rafraîchit au même rythme que les tableaux.
  assert.ok(out.includes("'/view'"), 'endpoint poll unifié');
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

test('renderShell : le stamp « maj » reflète updatedAt du snapshot, pas l’heure du reload', () => {
  const out = renderShell({ intervalMs: 10000 });
  // setContent reçoit l'updatedAt du serveur : après un ctrl+R, « maj HH:MM:SS »
  // est l'heure du vrai poll GitHub, pas celle de l'affichage.
  assert.ok(out.includes('setContent(d.fragment, d.updatedAt)'), 'updatedAt propagé au stamp');
});

test('renderShell : le chargement de page force un vrai poll (débouncé serveur)', () => {
  const out = renderShell({ intervalMs: 10000 });
  // Boot : affiche le snapshot tout de suite, puis POST /refresh (le serveur
  // ignore si le snapshot est frais) → ctrl+R rafraîchit vraiment les données.
  assert.match(out, /load\(\)\.then\([\s\S]*act\('\/refresh'\)/, 'boot = load puis /refresh');
});

test('renderLoading : spinner + libellé + sentinelle data-loading', () => {
  const out = renderLoading();
  assert.match(out, /class="spinner"/);
  assert.match(out, /Chargement/);
  assert.match(out, /data-loading/);
});

test('renderShell : lien 🐛 vers /debug dans l’en-tête', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /href="\/debug"/);
});

test('renderShell : checkbox notifs desktop cochée quand activées', () => {
  const out = renderShell({ intervalMs: 10000, notifyEnabled: true });
  assert.match(out, /id="notify"/);
  assert.match(out, /id="notify"[^>]*\schecked/);          // cochée
  assert.match(out, /\/notify/);                           // poste vers la route /notify
});

test('renderShell : checkbox notifs desktop décochée quand désactivées', () => {
  const out = renderShell({ intervalMs: 10000, notifyEnabled: false });
  assert.match(out, /id="notify"/);
  assert.ok(!/id="notify"[^>]*\schecked/.test(out), 'ne doit pas être cochée');
});

test('renderShell : notifs activées par défaut (notifyEnabled absent)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /id="notify"[^>]*\schecked/);
});

test('renderShell : data-theme sur <html> selon la préférence', () => {
  assert.match(renderShell({ theme: 'dark' }), /<html lang="fr" data-theme="dark"/);
  assert.match(renderShell({ theme: 'light' }), /<html lang="fr" data-theme="light"/);
});

test('renderShell : data-theme="auto" par défaut', () => {
  assert.match(renderShell({}), /<html lang="fr" data-theme="auto"/);
});

test('renderShell : CSS gère auto (media) + override light/dark explicites', () => {
  const out = renderShell({ theme: 'auto' });
  assert.match(out, /:root\[data-theme="auto"\]/);   // dark suit le système en auto
  assert.match(out, /:root\[data-theme="light"\]/);  // force clair
  assert.match(out, /:root\[data-theme="dark"\]/);   // force sombre
});

test('renderShell : switcher 3 boutons, l’actif surligné (.on) selon le thème', () => {
  const out = renderShell({ theme: 'dark' });
  assert.match(out, /data-theme-val="auto"/);
  assert.match(out, /data-theme-val="light"/);
  assert.match(out, /data-theme-val="dark"/);
  // le bouton du thème courant porte la classe on
  assert.match(out, /data-theme-val="dark"[^>]*class="[^"]*\bon\b/);
  assert.ok(!/data-theme-val="light"[^>]*\bon\b/.test(out), 'seul le thème courant est actif');
});

test('renderShell : le switcher poste vers /theme', () => {
  assert.match(renderShell({ theme: 'auto' }), /\/theme/);
});

test('renderShell : favicon logo GitHub inline (data-URI SVG, theme-aware)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(out, /prefers-color-scheme:dark/);          // adaptatif clair/sombre
  assert.match(out, /%231f2328/);                          // `#` encodé (pas un fragment)
  assert.ok(!/href="https?:[^"]*\.(svg|ico|png)/.test(out), 'favicon non externe');
});

test('renderDebugShell : favicon logo GitHub inline (data-URI SVG)', () => {
  const out = renderDebugShell({ intervalMs: 9000 });
  assert.match(out, /<link rel="icon" href="data:image\/svg\+xml,/);
});

// ── renderDebug / renderDebugShell ─────────────────────────────────────────
test('renderDebug : verdict gardé/droppé, PR liée, échappement', () => {
  const debug = [
    { repo: 'o/r', number: 42, title: '[X] <script>alert(1)</script>', ghReason: 'review_requested', commentsCount: 3, verdict: { kept: true, category: 'review_request', reason: 'demande de review' } },
    { repo: 'o/x', number: 7, title: 'Ma PR', ghReason: 'author', commentsCount: 0, verdict: { kept: false, category: null, reason: 'ta propre action' } },
  ];
  const out = renderDebug(debug, { now: NOW });
  assert.match(out, /1\/2 threads gardés/);
  assert.match(out, /href="https:\/\/github.com\/o\/r\/pull\/42"/);
  assert.match(out, /✓ review_request/);
  assert.match(out, /✗ droppé/);
  assert.match(out, /ta propre action/);
  assert.match(out, /&lt;script&gt;/);            // titre dangereux échappé
  assert.ok(!out.includes('<script>alert(1)'), 'pas d’injection');
});

test('renderDebug : vide → message neutre', () => {
  assert.match(renderDebug([], {}), /Aucun thread/);
});

test('renderDebugShell : page autonome qui poll /debug-fragment, lien retour, sans asset externe', () => {
  const out = renderDebugShell({ intervalMs: 9000 });
  assert.ok(out.startsWith('<!doctype html'));
  assert.match(out, /\/debug-fragment/);
  assert.match(out, /9000/);
  assert.match(out, /href="\/"/);                 // retour aux tableaux
  assert.ok(!/src="https?:/.test(out), 'pas de script externe');
});

// ── Barre de favoris (web) ───────────────────────────────────────────────

test('renderFavorites : chip active marquée .on, « ⭐ tous » actif si aucun favori', () => {
  const list = ['mapado', 'zenstruck'];
  const actif = renderFavorites(list, 'mapado');
  assert.match(actif, /<button data-fav="mapado" class="on">mapado\/\*<\/button>/);
  assert.doesNotMatch(actif, /<button data-fav="" class="on"/); // « tous » pas actif
  const tous = renderFavorites(list, null);
  assert.match(tous, /<button data-fav="" class="on"/);
  assert.doesNotMatch(tous, /data-fav="mapado" class="on"/);
});

test('renderFavorites : une org s’affiche « org/* », un dépôt tel quel — data-fav reste brut', () => {
  const html = renderFavorites(['mapado', 'noctud/collection'], null);
  assert.match(html, /data-fav="mapado"[^>]*>mapado\/\*</);            // libellé décoré…
  assert.match(html, /data-fav-rm="mapado"/);                          // …valeur brute pour l'API
  assert.match(html, /data-fav="noctud\/collection"[^>]*>noctud\/collection</); // repo inchangé
});

test('renderFavorites : compteurs (activité des autres) par chip et sur « tous »', () => {
  const counts = { total: 8, byFav: { mapado: 5, zenstruck: 3 } };
  const html = renderFavorites(['mapado', 'zenstruck'], null, { counts });
  assert.match(html, /⭐ tous <span class="fav-n">\(8\)<\/span>/);
  assert.match(html, /mapado\/\* <span class="fav-n">\(5\)<\/span>/);
  assert.match(html, /zenstruck\/\* <span class="fav-n">\(3\)<\/span>/);
});

test('renderFavorites : favori absent des compteurs → (0) ; sans counts → pas de badge', () => {
  const html = renderFavorites(['mapado'], null, { counts: { total: 0, byFav: {} } });
  assert.match(html, /mapado\/\* <span class="fav-n">\(0\)<\/span>/);
  assert.doesNotMatch(renderFavorites(['mapado'], null), /fav-n/);
});

test('renderFavorites : chaque chip a sa croix de retrait', () => {
  const html = renderFavorites(['mapado'], null);
  assert.match(html, /data-fav-rm="mapado"/);
});

test('renderFavorites : liste vide → chaîne vide (aucun changement visuel)', () => {
  assert.equal(renderFavorites([], null), '');
  assert.equal(renderFavorites(undefined, null), '');
});

test('renderFavorites : mode ad-hoc → barre grisée, aucune chip active', () => {
  const html = renderFavorites(['mapado'], 'mapado', { adhoc: true });
  assert.match(html, /class="favs adhoc"/);
  assert.doesNotMatch(html, /class="on"/);
});

test('renderFavorites échappe les valeurs (anti-injection : saisie utilisateur)', () => {
  const html = renderFavorites(['<script>alert(1)</script>', 'a&b'], null);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a&amp;b/);
});

test('renderShell : intègre la barre de favoris et le bouton ⭐ d’épinglage', () => {
  const html = renderShell({ favorites: ['mapado'], activeFav: 'mapado' });
  assert.match(html, /id="favs"/);
  assert.match(html, /data-fav="mapado" class="on"/);
  assert.match(html, /id="scope-fav"/);
});

test('renderShell sans favoris : la barre reste vide', () => {
  const html = renderShell({});
  assert.match(html, /<div id="favs"><\/div>/);
});

test('renderFragment : lien « fermées ↗ » dans le titre quand closedUrl est fourni', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW, closedUrl: 'https://github.com/pulls?q=x%20%26%20y' });
  assert.match(out, /Tes PR ouvertes \(1\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=x%20%26%20y"'), 'href du lien fermées');
  assert.ok(out.includes('target="_blank"'));
  assert.match(out, /fermées ↗/);
});

test('renderFragment : sans closedUrl → pas de lien (compat)', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.ok(!out.includes('fermées ↗'));
});

test('renderFragment : closedUrl dangereuse échappée', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW, closedUrl: 'https://x/?a="<b>&c' });
  assert.ok(out.includes('href="https://x/?a=&quot;&lt;b&gt;&amp;c"'), 'URL échappée');
});

test('renderFragment : mine vide + closedUrl → section (0) avec lien, sans tableau', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW, closedUrl: 'https://github.com/pulls?q=z' });
  assert.match(out, /Tes PR ouvertes \(0\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=z"'));
  assert.ok(!out.includes('<table'), 'pas de tableau vide');
  assert.ok(!out.includes('Rien à signaler'));
});

test('renderFragment : mine vide sans closedUrl → comportement inchangé', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW });
  assert.match(out, /Rien à signaler/);
});

// ── En-têtes triables (colonne « autres ») ─────────────────────────────────

test('renderFragment avec opts.sort : th cliquables + indicateur sur la colonne active', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: '2026-07-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'date', dir: 'desc' } });
  assert.match(html, /<th[^>]*data-sort-key="author"[^>]*>Auteur<\/th>/);
  assert.match(html, /<th[^>]*data-sort-key="date"[^>]*>Ouverte ▾<\/th>/); // colonne active + sens
  assert.match(html, /<th[^>]*data-sort-key="approvals"/);
  // asc → ▴
  const asc = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'author', dir: 'asc' } });
  assert.match(asc, /<th[^>]*data-sort-key="author"[^>]*>Auteur ▴<\/th>/);
  assert.match(asc, /<th[^>]*data-sort-key="date"[^>]*>Ouverte<\/th>/); // inactive : pas d'indicateur
});

test('renderFragment sans opts.sort : sortie inchangée (aucun data-sort-key)', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: null, additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: 0 });
  assert.ok(!html.includes('data-sort-key'), 'compat : pas de th triable sans opts.sort');
});

test('le tableau « Tes PR » n’a jamais d’en-tête triable', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  const html = renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } });
  assert.ok(!html.includes('data-sort-key'), 'mine : aucun tri');
});

test('renderShell : le JS gère le clic sur th[data-sort-key] → POST /sort', () => {
  const page = renderShell({});
  assert.match(page, /data-sort-key/);
  assert.match(page, /\/sort/);
});
