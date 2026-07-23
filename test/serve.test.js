import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { handleRequest, serve, parseScope, scopeLabel, shouldRefresh } from '../src/serve.js';
import { loadPrefs, prefsPath } from '../src/prefs.js';

const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const OPTS = { now: NOW, intervalMs: 10000 };

const okSnapshot = () => ({
  data: {
    mine: [{ repo: 'mapado/web', number: 1, url: 'u', title: 't', triggers: ['comment'], ci: 'pass', state: 'open', approvals: 0 }],
    others: [],
  },
  updatedAt: NOW,
  error: null,
});

test('GET / → page HTML complète', () => {
  const res = handleRequest('/', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.ok(res.body.startsWith('<!doctype html'));
});

test('GET /fragment (snapshot OK) → 200 + un titre de section', () => {
  const res = handleRequest('/fragment', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.match(res.body, /Tes PR ouvertes/);
});

test('GET /fragment (snapshot en erreur) → 200, message échappé, pas de crash', () => {
  const res = handleRequest('/fragment', { data: null, updatedAt: null, error: 'boom <x> & co' }, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /boom &lt;x&gt; &amp; co/);
  assert.ok(!res.body.includes('<x>'), 'message d’erreur échappé');
});

test('GET /fragment avant le premier poll (updatedAt null) → spinner de chargement', () => {
  const res = handleRequest('/fragment', { data: null, updatedAt: null, error: null }, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /data-loading/);
  assert.match(res.body, /class="spinner"/);
});

test('GET /api/state → JSON round-trip', () => {
  const snap = okSnapshot();
  const res = handleRequest('/api/state', snap, OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json; charset=utf-8');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.data.mine[0].number, 1);
});

test('chemin inconnu → 404', () => {
  const res = handleRequest('/inconnu', okSnapshot(), OPTS);
  assert.equal(res.status, 404);
});

// ── debug (always-on) ──────────────────────────────────────────────────────
test('GET /debug → page autonome qui poll /debug-fragment', () => {
  const res = handleRequest('/debug', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.ok(res.body.startsWith('<!doctype html'));
  assert.match(res.body, /\/debug-fragment/);
});

test('GET /debug-fragment → verdicts (et message échappé si erreur)', () => {
  const snap = okSnapshot();
  snap.data.debug = [{ repo: 'o/r', number: 42, title: 't', ghReason: 'review_requested', commentsCount: 0, verdict: { kept: true, category: 'review_request', reason: 'r' } }];
  const res = handleRequest('/debug-fragment', snap, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /o\/r#42/);
  const err = handleRequest('/debug-fragment', { data: null, updatedAt: null, error: 'boom <x>' }, OPTS);
  assert.match(err.body, /boom &lt;x&gt;/);
});

test('GET /api/debug → JSON du tableau debug', () => {
  const snap = okSnapshot();
  snap.data.debug = [{ repo: 'o/r', number: 42, verdict: { kept: false, category: null, reason: 'bruit' } }];
  const res = handleRequest('/api/debug', snap, OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json; charset=utf-8');
  assert.equal(JSON.parse(res.body)[0].number, 42);
});

test('GET / préremplit le champ de scope avec le scope courant', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, scope: { type: 'org', value: 'mapado' } });
  assert.match(res.body, /id="scope"[^>]*value="mapado"/);
});

test('GET / : checkbox notifs cochée par défaut, décochée si notifyEnabled=false', () => {
  const checked = handleRequest('/', okSnapshot(), { ...OPTS, notifyEnabled: true });
  assert.match(checked.body, /id="notify"[^>]*\schecked/);
  const off = handleRequest('/', okSnapshot(), { ...OPTS, notifyEnabled: false });
  assert.ok(!/id="notify"[^>]*\schecked/.test(off.body), 'décochée quand notifyEnabled=false');
});

test('GET / : data-theme reflète le thème passé à handleRequest', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, theme: 'dark' });
  assert.match(res.body, /<html lang="fr" data-theme="dark"/);
  assert.match(res.body, /data-theme-val="dark"[^>]*class="[^"]*\bon\b/);
});

test('GET /fragment?hidden (showHidden) rend les lignes masquées', () => {
  const snap = okSnapshot();
  snap.data.hidden = [{ repo: 'o/x', number: 9, url: 'u', title: 'cachée', triggers: ['review'], ci: 'none', author: 'bob', createdAt: NOW, additions: 0, deletions: 0, state: 'open', approvals: 0 }];
  snap.data.hiddenCount = 1;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true });
  assert.match(res.body, /data-key="o\/x#9"[^>]*data-act="show"/);
});

// ── parseScope / scopeLabel ────────────────────────────────────────────────
test('parseScope : vide → null, org, owner/repo', () => {
  assert.equal(parseScope(''), null);
  assert.equal(parseScope('   '), null);
  assert.equal(parseScope(null), null);
  assert.deepEqual(parseScope('mapado'), { type: 'org', value: 'mapado' });
  assert.deepEqual(parseScope('mapado/web'), { type: 'repo', value: 'mapado/web' });
  assert.deepEqual(parseScope('  mapado/web  '), { type: 'repo', value: 'mapado/web' });
});

test('scopeLabel : null → "", sinon la valeur', () => {
  assert.equal(scopeLabel(null), '');
  assert.equal(scopeLabel({ type: 'org', value: 'mapado' }), 'mapado');
});

// ── intégration : POST /hide masque la PR (stub gh, vrai serveur) ───────────
test('POST /hide masque une PR des autres puis la restaure', async () => {
  // gh stub : une review demandée → une PR « des autres » (auteur ≠ moi).
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/mapado/web', number: 42, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: 't', author: { login: 'alice' }, createdAt: '2026-06-24T00:00:00Z',
      additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  // Évite d'écrire dans l'état réel de l'utilisateur pendant le test.
  const tmp = `/tmp/gh-notif-test-${process.pid}`;
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7791;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1er poll
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.match(frag1, /mapado\/web#42/, 'la PR est visible au départ');

    // masque la PR
    await fetch(`http://localhost:${PORT}/hide?key=${encodeURIComponent('mapado/web#42')}`, { method: 'POST' });
    const frag2 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(!frag2.includes('mapado/web#42'), 'la PR est masquée (absente)');

    // visible de nouveau en mode showHidden
    const frag3 = await (await fetch(`http://localhost:${PORT}/fragment?hidden=1`)).text();
    assert.match(frag3, /mapado\/web#42/, 'réapparait en mode « voir masquées »');
  } finally {
    server.close();
  }
});

// ── intégration : POST /notify (dés)active les notifs + persiste la préférence ─
test('POST /notify persiste la préférence et se reflète dans la page', async () => {
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-notify-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true }); // départ propre : pas de prefs
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7792;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Défaut : cochée.
    const page1 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page1, /id="notify"[^>]*\schecked/, 'cochée par défaut');

    // Désactive.
    const res = await fetch(`http://localhost:${PORT}/notify?enabled=0`, { method: 'POST' });
    assert.equal(res.status, 204);
    const page2 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.ok(!/id="notify"[^>]*\schecked/.test(page2), 'décochée après désactivation');

    // Persisté sur disque.
    assert.equal(loadPrefs(prefsPath()).notify, false);

    // Réactive.
    await fetch(`http://localhost:${PORT}/notify?enabled=1`, { method: 'POST' });
    assert.equal(loadPrefs(prefsPath()).notify, true);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── intégration : POST /theme persiste le thème sans écraser notify ─────────
test('POST /theme persiste le thème, se reflète dans la page, ne perd pas notify', async () => {
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-theme-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7793;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Défaut auto.
    const page1 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page1, /<html lang="fr" data-theme="auto"/);

    // Coupe d'abord les notifs pour vérifier que /theme ne l'écrase pas.
    await fetch(`http://localhost:${PORT}/notify?enabled=0`, { method: 'POST' });

    // Passe en sombre.
    const res = await fetch(`http://localhost:${PORT}/theme?value=dark`, { method: 'POST' });
    assert.equal(res.status, 204);
    const page2 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page2, /<html lang="fr" data-theme="dark"/);

    // Persisté ET notify préservé (pas de clé perdue).
    const prefs = loadPrefs(prefsPath());
    assert.equal(prefs.theme, 'dark');
    assert.equal(prefs.notify, false);

    // Valeur invalide → ignorée/normalisée en auto (robustesse).
    await fetch(`http://localhost:${PORT}/theme?value=fuchsia`, { method: 'POST' });
    assert.equal(loadPrefs(prefsPath()).theme, 'auto');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Favoris : collecte sur l'union, filtre à l'affichage ─────────────────

const mixedSnapshot = () => ({
  data: {
    mine: [
      { repo: 'mapado/web', number: 1, url: 'u', title: 'chez mapado', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
      { repo: 'zenstruck/foundry', number: 2, url: 'u', title: 'chez zenstruck', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
    ],
    others: [],
    debug: [{ repo: 'mapado/web', number: 1, verdict: { kept: true, reason: 'r' } },
            { repo: 'zenstruck/foundry', number: 2, verdict: { kept: true, reason: 'r' } }],
  },
  updatedAt: NOW,
  error: null,
});

test('GET / : les chips de favoris sont dans la page, l’active marquée', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, favorites: ['mapado', 'zenstruck'], activeFav: 'mapado' });
  assert.match(res.body, /data-fav="mapado" class="on"/);
  assert.match(res.body, /data-fav="zenstruck"/);
});

test('GET /fragment : filtré sur le favori actif (le snapshot, lui, garde l’union)', () => {
  const snap = mixedSnapshot();
  const res = handleRequest('/fragment', snap, { ...OPTS, favorites: ['mapado', 'zenstruck'], activeFav: 'mapado' });
  assert.match(res.body, /chez mapado/);
  assert.doesNotMatch(res.body, /chez zenstruck/);
  // ⚠️ le snapshot n'est PAS muté : c'est lui qui alimente les notifs desktop
  assert.equal(snap.data.mine.length, 2);
});

test('GET /fragment sans favori actif → toute l’union est affichée', () => {
  const res = handleRequest('/fragment', mixedSnapshot(), { ...OPTS, favorites: ['mapado', 'zenstruck'], activeFav: null });
  assert.match(res.body, /chez mapado/);
  assert.match(res.body, /chez zenstruck/);
});

test('mode ad-hoc : un scope saisi prime, le favori actif ne re-filtre pas', () => {
  const res = handleRequest('/fragment', mixedSnapshot(), {
    ...OPTS, favorites: ['mapado'], activeFav: 'mapado', adhoc: true, scope: { type: 'org', value: 'zenstruck' },
  });
  assert.match(res.body, /chez zenstruck/); // la collecte a déjà fait le filtrage
});

test('GET / en mode ad-hoc : chips grisées et aucune active', () => {
  const res = handleRequest('/', okSnapshot(), {
    ...OPTS, favorites: ['mapado'], activeFav: 'mapado', adhoc: true, scope: { type: 'org', value: 'zenstruck' },
  });
  assert.match(res.body, /class="favs adhoc"/);
  assert.doesNotMatch(res.body, /data-fav="mapado" class="on"/);
});

test('GET /debug-fragment suit aussi le favori actif', () => {
  const res = handleRequest('/debug-fragment', mixedSnapshot(), { ...OPTS, favorites: ['mapado'], activeFav: 'mapado' });
  assert.match(res.body, /mapado\/web/);
  assert.doesNotMatch(res.body, /zenstruck/);
});

test('scopeLabel : en mode favoris (scope = tableau) le champ reste vide', () => {
  assert.equal(scopeLabel([{ type: 'org', value: 'mapado' }, { type: 'org', value: 'zenstruck' }]), '');
  assert.equal(scopeLabel({ type: 'org', value: 'mapado' }), 'mapado');
});

// ── intégration : routes /fav* (ajout, sélection, retrait, persistance) ─────
test('POST /fav* : épingle, filtre, retire — et ne perd ni notify ni theme', async () => {
  // Deux PR dans deux orgs : la collecte porte sur l'union, l'affichage filtre.
  const pr = (repo, number, title) => ({
    repository_url: `https://api.github.com/repos/${repo}`, number, title,
    html_url: `https://github.com/${repo}/pull/${number}`, updated_at: '2026-06-24T10:00:00Z',
  });
  const searches = [];
  const checked = [];
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async (q) => { searches.push(q); return [pr('mapado/web', 1, 'chez mapado'), pr('zenstruck/foundry', 2, 'chez zenstruck')]; },
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map(() => ({ author: { login: 'alice' }, state: 'OPEN', additions: 1, deletions: 0, reviews: [] })),
    getComment: async () => null,
    getReviewComments: async () => [],
    scopeExists: async (s) => { checked.push(s); return true; },
  };
  const tmp = `/tmp/gh-notif-test-fav-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7794;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  const post = (p) => fetch(`http://localhost:${PORT}${p}`, { method: 'POST' });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Réglages préexistants : ils ne doivent pas bouger.
    await post('/notify?enabled=0');
    await post('/theme?value=dark');

    // Épingle deux favoris. La réponse part AVANT le re-poll (puce instantanée) :
    // la chip est déjà dans la réponse, l'existence a été vérifiée.
    await post('/fav/add?value=mapado');
    const added = await (await post('/fav/add?value=zenstruck')).json();
    assert.match(added.chips, /data-fav="mapado"/);
    assert.match(added.chips, /data-fav="zenstruck"/);
    assert.deepEqual(checked, [{ type: 'org', value: 'mapado' }, { type: 'org', value: 'zenstruck' }]);
    assert.match(added.fragment, /chez mapado/);
    assert.match(added.fragment, /chez zenstruck/); // aucun favori actif → union

    // Le refresh d'arrière-plan aboutit : la collecte porte bien sur l'union
    // (une seule recherche OR-isée). On laisse le poll asynchrone se poser.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(searches.at(-1), ' org:mapado org:zenstruck');

    // /view (poll du client) : chips avec compteurs (activité des autres) + updatedAt.
    const view = await (await fetch(`http://localhost:${PORT}/view`)).json();
    assert.match(view.chips, /⭐ tous <span class="fav-n">\(2\)<\/span>/);
    assert.match(view.chips, /mapado\/\* <span class="fav-n">\(1\)<\/span>/);
    assert.match(view.chips, /zenstruck\/\* <span class="fav-n">\(1\)<\/span>/);
    assert.ok(view.updatedAt > 0, 'updatedAt exposé pour la sonde du client');

    // Sélectionne un favori : filtre d'affichage, SANS nouvelle recherche.
    const before = searches.length;
    const selected = await (await post('/fav?value=mapado')).json();
    assert.equal(searches.length, before, 'changer de favori ne doit coûter aucune requête');
    assert.match(selected.fragment, /chez mapado/);
    assert.doesNotMatch(selected.fragment, /chez zenstruck/);
    assert.match(selected.chips, /data-fav="mapado" class="on"/);
    // Le compteur de l'autre favori reste visible même quand on ne le regarde pas.
    assert.match(selected.chips, /zenstruck\/\* <span class="fav-n">\(1\)<\/span>/);

    // Persisté, sans écraser notify/theme (piège de la clé perdue).
    let prefs = loadPrefs(prefsPath());
    assert.deepEqual(prefs.favorites, ['mapado', 'zenstruck']);
    assert.equal(prefs.activeFav, 'mapado');
    assert.equal(prefs.notify, false);
    assert.equal(prefs.theme, 'dark');

    // Retirer le favori actif rebascule sur « tous ».
    const removed = await (await post('/fav/rm?value=mapado')).json();
    assert.doesNotMatch(removed.chips, /data-fav="mapado"/);
    prefs = loadPrefs(prefsPath());
    assert.deepEqual(prefs.favorites, ['zenstruck']);
    assert.equal(prefs.activeFav, null);

    // Valeur inconnue → « tous », pas d'erreur.
    await post('/fav?value=nimportequoi');
    assert.equal(loadPrefs(prefsPath()).activeFav, null);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── intégration : refus d'un favori qui n'existe pas sur GitHub ─────────────
test('POST /fav/add : scope introuvable → 400, rien n’est persisté', async () => {
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
    // 404 GitHub → false ; indéterminé (réseau) → null (fail-open).
    scopeExists: async (s) => (s.value.includes('reseau-hs') ? null : false),
  };
  const tmp = `/tmp/gh-notif-test-fav404-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7795;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 150));

    // Org inexistante → 400 avec message clair, favoris intacts.
    const org = await fetch(`http://localhost:${PORT}/fav/add?value=nexiste-pas`, { method: 'POST' });
    assert.equal(org.status, 400);
    assert.match(await org.text(), /org\/utilisateur nexiste-pas introuvable/);
    assert.deepEqual(loadPrefs(prefsPath()).favorites, []);

    // Dépôt inexistant → même refus, message adapté.
    const repo = await fetch(`http://localhost:${PORT}/fav/add?value=${encodeURIComponent('o/nexiste-pas')}`, { method: 'POST' });
    assert.equal(repo.status, 400);
    assert.match(await repo.text(), /dépôt o\/nexiste-pas introuvable/);

    // Vérification indéterminée (réseau) → fail-open : l'ajout passe quand même.
    const ok = await fetch(`http://localhost:${PORT}/fav/add?value=reseau-hs`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.deepEqual(loadPrefs(prefsPath()).favorites, ['reseau-hs']);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── shouldRefresh (débounce du POST /refresh, pur) ──────────────────────────
test('shouldRefresh : jamais pollé ou snapshot vieux → true, frais → false', () => {
  // Jamais pollé (updatedAt null) : il faut poller.
  assert.equal(shouldRefresh(null, NOW), true);
  // Snapshot frais (< 10 s) : un reload de page ne re-poll pas GitHub.
  assert.equal(shouldRefresh(NOW - 3000, NOW), false);
  // Snapshot vieux : on re-poll.
  assert.equal(shouldRefresh(NOW - 15000, NOW), true);
  // Seuil surchargeable.
  assert.equal(shouldRefresh(NOW - 3000, NOW, 2000), true);
});

// ── intégration : POST /refresh débouncé quand le snapshot est frais ────────
test('POST /refresh juste après un poll → pas de nouvelle collecte GitHub', async () => {
  let polls = 0;
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => { polls += 1; return []; },
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-refresh-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7796;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 150)); // 1er poll
    assert.equal(polls, 1, 'un seul poll au démarrage');

    // Reload de page (ctrl+R) → le client force /refresh ; snapshot frais → 0 collecte.
    const res = await fetch(`http://localhost:${PORT}/refresh`, { method: 'POST' });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.updatedAt, 'répond quand même la vue courante (JSON complet)');
    assert.equal(polls, 1, 'snapshot frais → pas de re-poll GitHub');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── /view (handleRequest, pur) ──────────────────────────────────────────────
test('GET /view : JSON {chips, fragment, updatedAt}, compteurs depuis le snapshot', () => {
  const snap = mixedSnapshot();
  snap.data.others = [
    { repo: 'mapado/front', number: 7, url: 'u', title: 'aussi', triggers: ['review'], ci: 'pass', author: 'bob', createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, state: 'open', approvals: 0 },
  ];
  const res = handleRequest('/view', snap, { ...OPTS, favorites: ['mapado', 'zenstruck'], activeFav: 'zenstruck' });
  assert.equal(res.type, 'application/json; charset=utf-8');
  const d = JSON.parse(res.body);
  assert.equal(d.updatedAt, NOW);
  // Compteurs = activité des autres, calculés sur l'UNION (mapado compte même
  // si le favori actif est zenstruck).
  assert.match(d.chips, /mapado\/\* <span class="fav-n">\(1\)<\/span>/);
  assert.match(d.chips, /zenstruck\/\* <span class="fav-n">\(0\)<\/span>/);
  assert.match(d.chips, /data-fav="zenstruck" class="on"/);
  // Le fragment, lui, est filtré sur le favori actif.
  assert.match(d.fragment, /chez zenstruck/);
  assert.doesNotMatch(d.fragment, /chez mapado/);
});

test('GET /fragment : lien « fermées » contextualisé (ad-hoc > favori actif > union des favoris)', () => {
  // Aucun scope ni favori → lien sans qualifier.
  let res = handleRequest('/fragment', okSnapshot(), OPTS);
  assert.ok(res.body.includes('href="https://github.com/pulls?q=is%3Apr%20author%3A%40me%20is%3Aclosed"'));
  // Favori actif → son qualifier seul.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['mapado', 'a/b'], activeFav: 'mapado' });
  assert.ok(res.body.includes('is%3Aclosed%20org%3Amapado"'));
  // « Tous » avec favoris → union.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['mapado', 'a/b'], activeFav: null });
  assert.ok(res.body.includes('org%3Amapado%20repo%3Aa%2Fb"'));
  // Mode ad-hoc → le scope saisi prime sur les favoris.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['mapado'], activeFav: 'mapado', scope: { type: 'repo', value: 'x/y' }, adhoc: true });
  assert.ok(res.body.includes('is%3Aclosed%20repo%3Ax%2Fy"'));
});

// ── tri du tableau « autres » ──────────────────────────────────────────────
const sortedSnapshot = () => ({
  data: {
    mine: [],
    others: [
      { repo: 'o/old', number: 1, url: 'u', title: 'vieille', author: 'zoe', createdAt: '2026-06-01T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 2 },
      { repo: 'o/new', number: 2, url: 'u', title: 'récente', author: 'alice', createdAt: '2026-06-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
    ],
  },
  updatedAt: NOW,
  error: null,
});

test('GET /fragment : opts.sort trie les autres et marque la colonne active', () => {
  const desc = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'date', dir: 'desc' } });
  assert.ok(desc.body.indexOf('o/new#2') < desc.body.indexOf('o/old#1'), 'date desc : récente d’abord');
  assert.match(desc.body, /data-sort-key="date"[^>]*>Ouverte ▾/);
  const byAuthor = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'author', dir: 'asc' } });
  assert.ok(byAuthor.body.indexOf('o/new#2') < byAuthor.body.indexOf('o/old#1'), 'alice avant zoe');
});

test('GET /fragment?hidden : les lignes masquées suivent le même tri', () => {
  const snap = sortedSnapshot();
  snap.data.hidden = [
    { repo: 'o/hb', number: 8, url: 'u', title: 'b', author: 'bob', createdAt: '2026-06-05T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
    { repo: 'o/ha', number: 9, url: 'u', title: 'a', author: 'ann', createdAt: '2026-06-10T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
  ];
  snap.data.hiddenCount = 2;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true, sort: { key: 'date', dir: 'desc' } });
  assert.ok(res.body.indexOf('o/ha#9') < res.body.indexOf('o/hb#8'), 'masquées triées aussi (date desc)');
});

test('POST /sort : trie, inverse au re-clic, persiste, 400 sur clé inconnue', async () => {
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/o/old', number: 1, title: 'vieille', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
      { repository_url: 'https://api.github.com/repos/o/new', number: 2, title: 'récente', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: p.number === 1 ? 'vieille' : 'récente',
      author: { login: p.number === 1 ? 'zoe' : 'alice' },
      createdAt: p.number === 1 ? '2026-06-01T00:00:00Z' : '2026-06-20T00:00:00Z',
      additions: 0, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-sort-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7797;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1er poll
    // Défaut date desc : la récente (#2) d'abord.
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(frag1.indexOf('o/new#2') < frag1.indexOf('o/old#1'), 'défaut : date desc');

    // Clic « Auteur » → alice avant zoe, et l'état est persisté sur disque.
    const r1 = await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.ok(d1.fragment.indexOf('o/new#2') < d1.fragment.indexOf('o/old#1'), 'author asc : alice d’abord');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'asc' });

    // Re-clic « Auteur » → sens inversé.
    const d2 = await (await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' })).json();
    assert.ok(d2.fragment.indexOf('o/old#1') < d2.fragment.indexOf('o/new#2'), 'author desc : zoe d’abord');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });

    // Clé inconnue → 400, préférence intacte.
    const bad = await fetch(`http://localhost:${PORT}/sort?key=nope`, { method: 'POST' });
    assert.equal(bad.status, 400);
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
