import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, serve, parseScope, scopeLabel } from '../src/serve.js';

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

test('GET /fragment avant le premier poll (data null, pas d’erreur) → ne crash pas', () => {
  const res = handleRequest('/fragment', { data: null, updatedAt: null, error: null }, OPTS);
  assert.equal(res.status, 200);
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

test('GET / préremplit le champ de scope avec le scope courant', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, scope: { type: 'org', value: 'mapado' } });
  assert.match(res.body, /id="scope"[^>]*value="mapado"/);
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
