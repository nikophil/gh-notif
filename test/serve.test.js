import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/serve.js';

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
