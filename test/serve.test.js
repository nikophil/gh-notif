import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { handleRequest, serve, parseScope, scopeLabel } from '../src/serve.js';
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
