import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { handleRequest, serve, parseScope, scopeLabel, shouldRefresh } from '../src/serve.js';
import { loadPrefs, prefsPath } from '../src/prefs.js';

const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const OPTS = { now: NOW, intervalMs: 10000 };

const okSnapshot = () => ({
  data: {
    mine: [{ repo: 'symfony/web', number: 1, url: 'u', title: 't', triggers: ['comment'], ci: 'pass', state: 'open', approvals: 0 }],
    others: [],
  },
  updatedAt: NOW,
  error: null,
});

test('GET / → full HTML page', () => {
  const res = handleRequest('/', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.ok(res.body.startsWith('<!doctype html'));
});

test('GET /fragment (snapshot OK) → 200 + a section title', () => {
  const res = handleRequest('/fragment', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.match(res.body, /Your open PRs/);
});

test('GET /fragment (snapshot in error) → 200, escaped message, no crash', () => {
  const res = handleRequest('/fragment', { data: null, updatedAt: null, error: 'boom <x> & co' }, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /boom &lt;x&gt; &amp; co/);
  assert.ok(!res.body.includes('<x>'), 'error message escaped');
});

test('GET /fragment before the first poll (updatedAt null) → loading spinner', () => {
  const res = handleRequest('/fragment', { data: null, updatedAt: null, error: null }, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /data-loading/);
  assert.match(res.body, /class="spinner"/);
});

test('GET /fragment forwards ignoredChecks → ignored check struck in the CI popover', () => {
  const snap = okSnapshot();
  snap.data.mine[0].ci = 'fail';
  snap.data.mine[0].checks = [
    { name: 'real', state: 'fail', url: 'https://x.test/2' },
    { name: 'flaky', state: 'fail', url: 'https://x.test/1' },
  ];
  const res = handleRequest('/fragment', snap, { ...OPTS, ignoredChecks: { 'symfony/web': ['flaky'] } });
  assert.match(res.body, /<li class="ci-check ignored">[^]*?flaky/);
});

test('GET /api/state → JSON round-trip', () => {
  const snap = okSnapshot();
  const res = handleRequest('/api/state', snap, OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json; charset=utf-8');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.data.mine[0].number, 1);
});

test('unknown path → 404', () => {
  const res = handleRequest('/unknown', okSnapshot(), OPTS);
  assert.equal(res.status, 404);
});

// ── debug (always-on) ──────────────────────────────────────────────────────
test('GET /debug → standalone page that polls /debug-fragment', () => {
  const res = handleRequest('/debug', okSnapshot(), OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.ok(res.body.startsWith('<!doctype html'));
  assert.match(res.body, /\/debug-fragment/);
});

test('GET /debug-fragment → verdicts (and escaped message if error)', () => {
  const snap = okSnapshot();
  snap.data.debug = [{ repo: 'o/r', number: 42, title: 't', ghReason: 'review_requested', commentsCount: 0, verdict: { kept: true, category: 'review_request', reason: 'r' } }];
  const res = handleRequest('/debug-fragment', snap, OPTS);
  assert.equal(res.status, 200);
  assert.match(res.body, /o\/r#42/);
  const err = handleRequest('/debug-fragment', { data: null, updatedAt: null, error: 'boom <x>' }, OPTS);
  assert.match(err.body, /boom &lt;x&gt;/);
});

test('GET /api/debug → JSON of the debug table', () => {
  const snap = okSnapshot();
  snap.data.debug = [{ repo: 'o/r', number: 42, verdict: { kept: false, category: null, reason: 'noise' } }];
  const res = handleRequest('/api/debug', snap, OPTS);
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json; charset=utf-8');
  assert.equal(JSON.parse(res.body)[0].number, 42);
});

test('GET / pre-fills the scope field with the current scope', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, scope: { type: 'org', value: 'symfony' } });
  assert.match(res.body, /id="scope"[^>]*value="symfony"/);
});

test('GET / : notifs checkbox checked by default, unchecked if notifyEnabled=false', () => {
  const checked = handleRequest('/', okSnapshot(), { ...OPTS, notifyEnabled: true });
  assert.match(checked.body, /id="notify"[^>]*\schecked/);
  const off = handleRequest('/', okSnapshot(), { ...OPTS, notifyEnabled: false });
  assert.ok(!/id="notify"[^>]*\schecked/.test(off.body), 'unchecked when notifyEnabled=false');
});

test('GET / : data-theme reflects the theme passed to handleRequest', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, theme: 'dark' });
  assert.match(res.body, /<html lang="en" data-theme="dark"/);
  assert.match(res.body, /data-theme-val="dark"[^>]*class="[^"]*\bon\b/);
});

test('GET /fragment?hidden (showHidden) renders the hidden rows', () => {
  const snap = okSnapshot();
  snap.data.hidden = [{ repo: 'o/x', number: 9, url: 'u', title: 'hidden', triggers: ['review'], ci: 'none', author: 'bob', createdAt: NOW, additions: 0, deletions: 0, state: 'open', approvals: 0 }];
  snap.data.hiddenCount = 1;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true });
  assert.match(res.body, /data-key="o\/x#9"[^>]*data-act="show"/);
});

test('GET /fragment?hidden (showHidden) also renders MY hidden rows', () => {
  const snap = okSnapshot();
  snap.data.hiddenMine = [{ repo: 'o/x', number: 12, url: 'u', title: 'my hidden', triggers: [], ci: 'none', createdAt: NOW, additions: 0, deletions: 0, state: 'open', approvals: 0 }];
  snap.data.hiddenMineCount = 1;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true });
  assert.match(res.body, /data-key="o\/x#12"[^>]*data-act="show"/);
});

// ── parseScope / scopeLabel ────────────────────────────────────────────────
test('parseScope : empty → null, org, owner/repo', () => {
  assert.equal(parseScope(''), null);
  assert.equal(parseScope('   '), null);
  assert.equal(parseScope(null), null);
  assert.deepEqual(parseScope('symfony'), { type: 'org', value: 'symfony' });
  assert.deepEqual(parseScope('symfony/web'), { type: 'repo', value: 'symfony/web' });
  assert.deepEqual(parseScope('  symfony/web  '), { type: 'repo', value: 'symfony/web' });
});

test('scopeLabel : null → "", otherwise the value', () => {
  assert.equal(scopeLabel(null), '');
  assert.equal(scopeLabel({ type: 'org', value: 'symfony' }), 'symfony');
});

// ── integration: POST /hide hides the PR (stub gh, real server) ─────────────
test('POST /hide hides one of the others\' PRs then restores it', async () => {
  // gh stub: a requested review → an « others » PR (author ≠ me).
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/symfony/web', number: 42, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: 't', author: { login: 'alice' }, createdAt: '2026-06-24T00:00:00Z',
      additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  // Avoids writing into the user's real state during the test.
  const tmp = `/tmp/gh-notif-test-${process.pid}`;
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7791;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.match(frag1, /symfony\/web#42/, 'the PR is visible at first');

    // hides the PR
    await fetch(`http://localhost:${PORT}/hide?key=${encodeURIComponent('symfony/web#42')}`, { method: 'POST' });
    const frag2 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(!frag2.includes('symfony/web#42'), 'the PR is hidden (absent)');

    // visible again in showHidden mode
    const frag3 = await (await fetch(`http://localhost:${PORT}/fragment?hidden=1`)).text();
    assert.match(frag3, /symfony\/web#42/, 'reappears in « show hidden » mode');
  } finally {
    server.close();
  }
});

// ── integration: POST /hide also works on MY PRs ────────────────────────────
test('POST /hide hides one of MY PRs then shows it in hidden mode', async () => {
  // gh stub: an authored PR (author = me) → a « mine » row.
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [
      { repository_url: 'https://api.github.com/repos/symfony/web', number: 43, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: 't', author: { login: 'me' }, createdAt: '2026-06-24T00:00:00Z',
      additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-hide-mine-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7799;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.match(frag1, /symfony\/web#43/, 'my PR is visible at first');

    // hides MY PR (same endpoint as the others)
    await fetch(`http://localhost:${PORT}/hide?key=${encodeURIComponent('symfony/web#43')}`, { method: 'POST' });
    const frag2 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(!frag2.includes('symfony/web#43'), 'my PR is hidden (absent)');

    // visible again in showHidden mode, with a restore button
    const frag3 = await (await fetch(`http://localhost:${PORT}/fragment?hidden=1`)).text();
    assert.match(frag3, /data-key="symfony\/web#43"[^>]*data-act="show"/, 'reappears greyed in « show hidden » mode');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: every response forbids browser caching ─────────────────────
test('all HTTP responses carry Cache-Control: no-store', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-cache-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7798;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Without no-store, the browser may resurrect a `/` shell cached in a past
    // state (e.g. ad-hoc scope) after a server restart, instead of the restored
    // view (activeFav) — real bug.
    for (const path of ['/', '/view', '/fragment']) {
      const res = await fetch(`http://localhost:${PORT}${path}`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `GET ${path}`);
    }
    const post = await fetch(`http://localhost:${PORT}/refresh`, { method: 'POST' });
    assert.equal(post.headers.get('cache-control'), 'no-store', 'POST /refresh');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: POST /notify (de)activates the notifs + persists the preference ─
test('POST /notify persists the preference and is reflected in the page', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-notify-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true }); // clean start: no prefs
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7792;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Default: checked.
    const page1 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page1, /id="notify"[^>]*\schecked/, 'checked by default');

    // Deactivates.
    const res = await fetch(`http://localhost:${PORT}/notify?enabled=0`, { method: 'POST' });
    assert.equal(res.status, 204);
    const page2 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.ok(!/id="notify"[^>]*\schecked/.test(page2), 'unchecked after deactivation');

    // Persisted on disk.
    assert.equal(loadPrefs(prefsPath()).notify, false);

    // Reactivates.
    await fetch(`http://localhost:${PORT}/notify?enabled=1`, { method: 'POST' });
    assert.equal(loadPrefs(prefsPath()).notify, true);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: POST /theme persists the theme without overwriting notify ──
test('POST /theme persists the theme, is reflected in the page, does not lose notify', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
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
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Default auto.
    const page1 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page1, /<html lang="en" data-theme="auto"/);

    // First turn off the notifs to check that /theme does not overwrite it.
    await fetch(`http://localhost:${PORT}/notify?enabled=0`, { method: 'POST' });

    // Switch to dark.
    const res = await fetch(`http://localhost:${PORT}/theme?value=dark`, { method: 'POST' });
    assert.equal(res.status, 204);
    const page2 = await (await fetch(`http://localhost:${PORT}/`)).text();
    assert.match(page2, /<html lang="en" data-theme="dark"/);

    // Persisted AND notify preserved (no lost key).
    const prefs = loadPrefs(prefsPath());
    assert.equal(prefs.theme, 'dark');
    assert.equal(prefs.notify, false);

    // Invalid value → ignored/normalized to auto (robustness).
    await fetch(`http://localhost:${PORT}/theme?value=fuchsia`, { method: 'POST' });
    assert.equal(loadPrefs(prefsPath()).theme, 'auto');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Favorites: collection over the union, filter at display ──────────────
const mixedSnapshot = () => ({
  data: {
    mine: [
      { repo: 'symfony/web', number: 1, url: 'u', title: 'at symfony', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
      { repo: 'zenstruck/foundry', number: 2, url: 'u', title: 'at zenstruck', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
    ],
    others: [],
    debug: [{ repo: 'symfony/web', number: 1, verdict: { kept: true, reason: 'r' } },
            { repo: 'zenstruck/foundry', number: 2, verdict: { kept: true, reason: 'r' } }],
  },
  updatedAt: NOW,
  error: null,
});

test('GET / : the favorite chips are in the page, the active one marked', () => {
  const res = handleRequest('/', okSnapshot(), { ...OPTS, favorites: ['symfony', 'zenstruck'], activeFav: 'symfony' });
  assert.match(res.body, /data-fav="symfony" class="on"/);
  assert.match(res.body, /data-fav="zenstruck"/);
});

test('GET /fragment : filtered on the active favorite (the snapshot, itself, keeps the union)', () => {
  const snap = mixedSnapshot();
  const res = handleRequest('/fragment', snap, { ...OPTS, favorites: ['symfony', 'zenstruck'], activeFav: 'symfony' });
  assert.match(res.body, /at symfony/);
  assert.doesNotMatch(res.body, /at zenstruck/);
  // ⚠️ the snapshot is NOT mutated: it is what feeds the desktop notifs
  assert.equal(snap.data.mine.length, 2);
});

test('GET /fragment without active favorite → the whole union is displayed', () => {
  const res = handleRequest('/fragment', mixedSnapshot(), { ...OPTS, favorites: ['symfony', 'zenstruck'], activeFav: null });
  assert.match(res.body, /at symfony/);
  assert.match(res.body, /at zenstruck/);
});

test('ad-hoc mode: an entered scope takes precedence, the active favorite does not re-filter', () => {
  const res = handleRequest('/fragment', mixedSnapshot(), {
    ...OPTS, favorites: ['symfony'], activeFav: 'symfony', adhoc: true, scope: { type: 'org', value: 'zenstruck' },
  });
  assert.match(res.body, /at zenstruck/); // the collection already did the filtering
});

test('GET / in ad-hoc mode: greyed chips and none active', () => {
  const res = handleRequest('/', okSnapshot(), {
    ...OPTS, favorites: ['symfony'], activeFav: 'symfony', adhoc: true, scope: { type: 'org', value: 'zenstruck' },
  });
  assert.match(res.body, /class="favs adhoc"/);
  assert.doesNotMatch(res.body, /data-fav="symfony" class="on"/);
});

test('GET /debug-fragment also follows the active favorite', () => {
  const res = handleRequest('/debug-fragment', mixedSnapshot(), { ...OPTS, favorites: ['symfony'], activeFav: 'symfony' });
  assert.match(res.body, /symfony\/web/);
  assert.doesNotMatch(res.body, /zenstruck/);
});

test('scopeLabel : in favorites mode (scope = array) the field stays empty', () => {
  assert.equal(scopeLabel([{ type: 'org', value: 'symfony' }, { type: 'org', value: 'zenstruck' }]), '');
  assert.equal(scopeLabel({ type: 'org', value: 'symfony' }), 'symfony');
});

// ── integration: /fav* routes (add, select, remove, persistence) ────────────
test('POST /fav* : pins, filters, removes — and loses neither notify nor theme', async () => {
  // Two PRs in two orgs: the collection covers the union, the display filters.
  const pr = (repo, number, title) => ({
    repository_url: `https://api.github.com/repos/${repo}`, number, title,
    html_url: `https://github.com/${repo}/pull/${number}`, updated_at: '2026-06-24T10:00:00Z',
  });
  const searches = [];
  const checked = [];
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async (q) => { searches.push(q); return [pr('symfony/web', 1, 'at symfony'), pr('zenstruck/foundry', 2, 'at zenstruck')]; },
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
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  const post = (p) => fetch(`http://localhost:${PORT}${p}`, { method: 'POST' });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // Pre-existing settings: they must not change.
    await post('/notify?enabled=0');
    await post('/theme?value=dark');

    // Pins two favorites. The response leaves BEFORE the re-poll (instant chip):
    // the chip is already in the response, the existence was verified.
    await post('/fav/add?value=symfony');
    const added = await (await post('/fav/add?value=zenstruck')).json();
    assert.match(added.chips, /data-fav="symfony"/);
    assert.match(added.chips, /data-fav="zenstruck"/);
    assert.deepEqual(checked, [{ type: 'org', value: 'symfony' }, { type: 'org', value: 'zenstruck' }]);
    // Adding a favorite SELECTS it: the view filters on the just-pinned scope.
    assert.match(added.chips, /data-fav="zenstruck" class="on"/);
    assert.match(added.fragment, /at zenstruck/);
    assert.doesNotMatch(added.fragment, /at symfony/);

    // The background refresh completes: the collection indeed covers the union
    // (a single OR-ed search). We let the async poll settle.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(searches.at(-1), ' org:symfony org:zenstruck');

    // /view (client poll): chips with per-panel counters + updatedAt.
    const view = await (await fetch(`http://localhost:${PORT}/view`)).json();
    assert.match(view.chips, /⭐ all <span class="fav-n">\(<span[^>]*>📥\u20090<\/span> <span[^>]*>👥\u20092<\/span>\)<\/span>/);
    assert.match(view.chips, /symfony\/\* <span class="fav-n">\(<span[^>]*>📥\u20090<\/span> <span[^>]*>👥\u20091<\/span>\)<\/span>/);
    assert.match(view.chips, /zenstruck\/\* <span class="fav-n">\(<span[^>]*>📥\u20090<\/span> <span[^>]*>👥\u20091<\/span>\)<\/span>/);
    assert.ok(view.updatedAt > 0, 'updatedAt exposed for the client probe');

    // Selects a favorite: display filter, WITHOUT a new search.
    const before = searches.length;
    const selected = await (await post('/fav?value=symfony')).json();
    assert.equal(searches.length, before, 'switching favorite must cost no request');
    assert.match(selected.fragment, /at symfony/);
    assert.doesNotMatch(selected.fragment, /at zenstruck/);
    assert.match(selected.chips, /data-fav="symfony" class="on"/);
    // The counter of the other favorite stays visible even when we are not looking at it.
    assert.match(selected.chips, /zenstruck\/\* <span class="fav-n">\(<span[^>]*>📥\u20090<\/span> <span[^>]*>👥\u20091<\/span>\)<\/span>/);

    // Persisted, without overwriting notify/theme (lost-key trap).
    let prefs = loadPrefs(prefsPath());
    assert.deepEqual(prefs.favorites, ['symfony', 'zenstruck']);
    assert.equal(prefs.activeFav, 'symfony');
    assert.equal(prefs.notify, false);
    assert.equal(prefs.theme, 'dark');

    // Removing the active favorite falls back to « all ».
    const removed = await (await post('/fav/rm?value=symfony')).json();
    assert.doesNotMatch(removed.chips, /data-fav="symfony"/);
    prefs = loadPrefs(prefsPath());
    assert.deepEqual(prefs.favorites, ['zenstruck']);
    assert.equal(prefs.activeFav, null);

    // Unknown value → « all », no error.
    await post('/fav?value=whatever');
    assert.equal(loadPrefs(prefsPath()).activeFav, null);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: refusal of a favorite that does not exist on GitHub ────────
test('POST /fav/add : scope not found → 400, nothing is persisted', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async () => [],
    getComment: async () => null,
    getReviewComments: async () => [],
    // GitHub 404 → false; indeterminate (network) → null (fail-open).
    scopeExists: async (s) => (s.value.includes('network-down') ? null : false),
  };
  const tmp = `/tmp/gh-notif-test-fav404-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7795;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 150));

    // Nonexistent org → 400 with a clear message, favorites intact.
    const org = await fetch(`http://localhost:${PORT}/fav/add?value=does-not-exist`, { method: 'POST' });
    assert.equal(org.status, 400);
    assert.match(await org.text(), /org\/user does-not-exist not found/);
    assert.deepEqual(loadPrefs(prefsPath()).favorites, []);

    // Nonexistent repository → same refusal, adapted message.
    const repo = await fetch(`http://localhost:${PORT}/fav/add?value=${encodeURIComponent('o/does-not-exist')}`, { method: 'POST' });
    assert.equal(repo.status, 400);
    assert.match(await repo.text(), /repository o\/does-not-exist not found/);

    // Indeterminate check (network) → fail-open: the add goes through anyway.
    const ok = await fetch(`http://localhost:${PORT}/fav/add?value=network-down`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.deepEqual(loadPrefs(prefsPath()).favorites, ['network-down']);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── shouldRefresh (debounce of POST /refresh, pure) ─────────────────────────
test('shouldRefresh : never polled or old snapshot → true, fresh → false', () => {
  // Never polled (updatedAt null): must poll.
  assert.equal(shouldRefresh(null, NOW), true);
  // Fresh snapshot (< 10 s): a page reload does not re-poll GitHub.
  assert.equal(shouldRefresh(NOW - 3000, NOW), false);
  // Old snapshot: we re-poll.
  assert.equal(shouldRefresh(NOW - 15000, NOW), true);
  // Overridable threshold.
  assert.equal(shouldRefresh(NOW - 3000, NOW, 2000), true);
});

// ── integration: POST /refresh debounced when the snapshot is fresh ─────────
test('POST /refresh right after a poll → no new GitHub collection', async () => {
  let polls = 0;
  const gh = {
    getCurrentUser: async () => 'me',
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
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 150)); // 1st poll
    assert.equal(polls, 1, 'a single poll at startup');

    // Page reload (ctrl+R) → the client forces /refresh; fresh snapshot → 0 collection.
    const res = await fetch(`http://localhost:${PORT}/refresh`, { method: 'POST' });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.updatedAt, 'responds with the current view anyway (full JSON)');
    assert.equal(polls, 1, 'fresh snapshot → no re-poll of GitHub');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── /view (handleRequest, pure) ─────────────────────────────────────────────
test('GET /view : JSON {chips, fragment, updatedAt}, counters from the snapshot', () => {
  const snap = mixedSnapshot();
  snap.data.others = [
    { repo: 'symfony/front', number: 7, url: 'u', title: 'also', triggers: ['review'], ci: 'pass', author: 'bob', createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, state: 'open', approvals: 0 },
  ];
  const res = handleRequest('/view', snap, { ...OPTS, favorites: ['symfony', 'zenstruck'], activeFav: 'zenstruck' });
  assert.equal(res.type, 'application/json; charset=utf-8');
  const d = JSON.parse(res.body);
  assert.equal(d.updatedAt, NOW);
  // Counters = one per panel, computed on the UNION (symfony counts even
  // if the active favorite is zenstruck).
  assert.match(d.chips, /symfony\/\* <span class="fav-n">\(<span[^>]*>📥\u20091<\/span> <span[^>]*>👥\u20091<\/span>\)<\/span>/);
  assert.match(d.chips, /zenstruck\/\* <span class="fav-n">\(<span[^>]*>📥\u20091<\/span> <span[^>]*>👥\u20090<\/span>\)<\/span>/);
  assert.match(d.chips, /data-fav="zenstruck" class="on"/);
  // The fragment, itself, is filtered on the active favorite.
  assert.match(d.fragment, /at zenstruck/);
  assert.doesNotMatch(d.fragment, /at symfony/);
});

test('GET /fragment : « closed » link contextualized (ad-hoc > active favorite > union of favorites)', () => {
  // No scope nor favorite → link without qualifier.
  let res = handleRequest('/fragment', okSnapshot(), OPTS);
  assert.ok(res.body.includes('href="/search?q=is%3Apr%20author%3A%40me%20is%3Aclosed"'));
  // Active favorite → its qualifier alone.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['symfony', 'a/b'], activeFav: 'symfony' });
  assert.ok(res.body.includes('is%3Aclosed%20org%3Asymfony"'));
  // « All » with favorites → union.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['symfony', 'a/b'], activeFav: null });
  assert.ok(res.body.includes('org%3Asymfony%20repo%3Aa%2Fb"'));
  // Ad-hoc mode → the entered scope takes precedence over the favorites.
  res = handleRequest('/fragment', okSnapshot(), { ...OPTS, favorites: ['symfony'], activeFav: 'symfony', scope: { type: 'repo', value: 'x/y' }, adhoc: true });
  assert.ok(res.body.includes('is%3Aclosed%20repo%3Ax%2Fy"'));
});

// ── sort of the « others » table ────────────────────────────────────────────
const sortedSnapshot = () => ({
  data: {
    mine: [],
    others: [
      { repo: 'o/old', number: 1, url: 'u', title: 'old', author: 'zoe', createdAt: '2026-06-01T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 2 },
      { repo: 'o/new', number: 2, url: 'u', title: 'recent', author: 'alice', createdAt: '2026-06-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
    ],
  },
  updatedAt: NOW,
  error: null,
});

test('GET /fragment : opts.sort sorts the others and marks the active column', () => {
  const desc = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'date', dir: 'desc' } });
  assert.ok(desc.body.indexOf('o/new#2') < desc.body.indexOf('o/old#1'), 'date desc: recent first');
  assert.match(desc.body, /data-sort-key="date"[^>]*>Opened ▾/);
  const byAuthor = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'author', dir: 'asc' } });
  assert.ok(byAuthor.body.indexOf('o/new#2') < byAuthor.body.indexOf('o/old#1'), 'alice before zoe');
});

test('GET /fragment?hidden : the hidden rows follow the same sort', () => {
  const snap = sortedSnapshot();
  snap.data.hidden = [
    { repo: 'o/hb', number: 8, url: 'u', title: 'b', author: 'bob', createdAt: '2026-06-05T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
    { repo: 'o/ha', number: 9, url: 'u', title: 'a', author: 'ann', createdAt: '2026-06-10T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
  ];
  snap.data.hiddenCount = 2;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true, sort: { key: 'date', dir: 'desc' } });
  assert.ok(res.body.indexOf('o/ha#9') < res.body.indexOf('o/hb#8'), 'hidden ones sorted too (date desc)');
});

test('POST /sort : sorts, reverses on re-click, persists, 400 on unknown key', async () => {
  let polls = 0;
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => { polls += 1; return []; },
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/o/old', number: 1, title: 'old', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
      { repository_url: 'https://api.github.com/repos/o/new', number: 2, title: 'recent', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: p.number === 1 ? 'old' : 'recent',
      author: { login: p.number === 1 ? 'zoe' : 'alice' },
      createdAt: p.number === 1 ? '2026-06-01T00:00:00Z' : '2026-06-20T00:00:00Z',
      updatedAt: p.number === 1 ? '2026-06-02T00:00:00Z' : '2026-06-23T00:00:00Z',
      additions: 0, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-sort-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7797;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    // Default updated desc: the last-touched one (#2) first.
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(frag1.indexOf('o/new#2') < frag1.indexOf('o/old#1'), 'default: updated desc');

    // Click « Author » → alice before zoe, and the state is persisted on disk.
    const r1 = await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.ok(d1.fragment.indexOf('o/new#2') < d1.fragment.indexOf('o/old#1'), 'author asc: alice first');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'asc' });

    // Re-click « Author » → reversed direction.
    const d2 = await (await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' })).json();
    assert.ok(d2.fragment.indexOf('o/old#1') < d2.fragment.indexOf('o/new#2'), 'author desc: zoe first');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });

    // Unknown key → 400, preference intact.
    const bad = await fetch(`http://localhost:${PORT}/sort?key=nope`, { method: 'POST' });
    assert.equal(bad.status, 400);
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });

    // POST /sort triggers no GitHub poll (local recompute only).
    assert.equal(polls, 1, 'POST /sort triggers no GitHub poll');

    // table=mine: its own persisted state (prefs.sortMine), the others' one untouched.
    const m1 = await fetch(`http://localhost:${PORT}/sort?key=date&table=mine`, { method: 'POST' });
    assert.equal(m1.status, 200);
    assert.deepEqual(loadPrefs(prefsPath()).sortMine, { key: 'date', dir: 'desc' });
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });
    // Re-click → reversed direction.
    await fetch(`http://localhost:${PORT}/sort?key=date&table=mine`, { method: 'POST' });
    assert.deepEqual(loadPrefs(prefsPath()).sortMine, { key: 'date', dir: 'asc' });
    // A key outside MINE_SORT_KEYS (valid for others) → 400, preference intact.
    const badMine = await fetch(`http://localhost:${PORT}/sort?key=author&table=mine`, { method: 'POST' });
    assert.equal(badMine.status, 400);
    assert.deepEqual(loadPrefs(prefsPath()).sortMine, { key: 'date', dir: 'asc' });
    assert.equal(polls, 1, 'POST /sort?table=mine triggers no GitHub poll either');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /fragment : opts.sortMine sorts « Your PRs » (independent of opts.sort)', () => {
  const snap = () => ({
    data: {
      mine: [
        { repo: 'o/m1', number: 11, url: 'u', title: 'stale', createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z', additions: 0, deletions: 0, triggers: [], ci: 'pass', state: 'open', approvals: 0 },
        { repo: 'o/m2', number: 12, url: 'u', title: 'fresh', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-22T00:00:00Z', additions: 0, deletions: 0, triggers: [], ci: 'pass', state: 'open', approvals: 0 },
      ],
      others: [],
    },
    updatedAt: NOW,
    error: null,
  });
  const res = handleRequest('/fragment', snap(), { ...OPTS, sortMine: { key: 'updated', dir: 'desc' } });
  assert.ok(res.body.indexOf('>fresh<') < res.body.indexOf('>stale<'), 'updated desc: last-touched first');
  assert.match(res.body, /data-sort-key="updated"[^>]*data-sort-table="mine"[^>]*>Updated ▾/);
  // By opened date: the older-updated but newer-opened one comes back first.
  const byDate = handleRequest('/fragment', snap(), { ...OPTS, sortMine: { key: 'date', dir: 'desc' } });
  assert.ok(byDate.body.indexOf('>stale<') < byDate.body.indexOf('>fresh<'), 'date desc: newest opened first');
  // Without sortMine: collection order kept, no sortable th on mine.
  const bare = handleRequest('/fragment', snap(), { ...OPTS });
  assert.ok(bare.body.indexOf('>stale<') < bare.body.indexOf('>fresh<'));
  assert.ok(!bare.body.includes('data-sort-table'), 'compat: mine not sortable without opts.sortMine');
});

// ── integration: « all » mode per favorite (POST /fav/mode) ─────────────────
test('POST /fav/mode: toggles « all » mode, auto-watches, silent seed (no burst)', async () => {
  const issueThread = {
    id: 'w1', reason: 'subscribed', updated_at: '2026-08-01T12:00:00Z', last_read_at: null,
    subject: {
      title: 'Bug report', url: 'https://api.github.com/repos/zenstruck/foundry/issues/900',
      latest_comment_url: 'https://api.github.com/repos/zenstruck/foundry/issues/900', type: 'Issue',
    },
    repository: { full_name: 'zenstruck/foundry' },
  };
  const watched = [];
  const notified = [];
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [issueThread],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map(() => null),
    getComment: async () => ({ user: { login: 'alice' }, created_at: '2026-08-01T12:00:00Z', html_url: 'https://github.com/zenstruck/foundry/issues/900' }),
    getReviewComments: async () => [],
    scopeExists: async () => true,
    setRepoSubscription: async (repo) => { watched.push(repo); return true; },
  };
  const tmp = `/tmp/gh-notif-test-favmode-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7801;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false, notifier: (i) => notified.push(i) });
  const post = (p) => fetch(`http://localhost:${PORT}${p}`, { method: 'POST' });
  const view = async () => (await fetch(`http://localhost:${PORT}/view`)).json();
  const fav = encodeURIComponent('zenstruck/foundry');
  try {
    await new Promise((r) => setTimeout(r, 150)); // 1st poll (silent seed of the state)
    await post(`/fav/add?value=${fav}`);
    await new Promise((r) => setTimeout(r, 200)); // background refresh, normal mode
    assert.doesNotMatch((await view()).fragment, /Issues \(/, 'normal mode: the issue stays dropped');

    // Enable « all » mode: chip marked, persisted, repo auto-watched.
    const on = await (await post(`/fav/mode?value=${fav}`)).json();
    assert.match(on.chips, /chip-mode all/);
    assert.equal(loadPrefs(prefsPath()).favModes['zenstruck/foundry'], 'all');
    assert.deepEqual(watched, ['zenstruck/foundry']);
    await new Promise((r) => setTimeout(r, 250)); // background refresh, all mode
    const v2 = await view();
    assert.match(v2.fragment, /Issues \(1\)/);
    assert.match(v2.fragment, /🆕/);
    // Anti-burst: the pre-existing backlog was seeded silently.
    assert.deepEqual(notified.filter((n) => n.category === 'new_issue'), []);

    // Back to normal: key deleted, watched rows gone at the next refresh,
    // and NO second auto-watch call.
    const off = await (await post(`/fav/mode?value=${fav}`)).json();
    assert.doesNotMatch(off.chips, /chip-mode all/);
    assert.deepEqual(loadPrefs(prefsPath()).favModes, {});
    await new Promise((r) => setTimeout(r, 250));
    assert.doesNotMatch((await view()).fragment, /Issues \(/);
    assert.deepEqual(watched, ['zenstruck/foundry']);

    // Unknown favorite → clean 400.
    assert.equal((await post('/fav/mode?value=nope')).status, 400);

    // Removing a favorite cleans its mode key up.
    await post(`/fav/mode?value=${fav}`); // re-enable
    assert.equal(loadPrefs(prefsPath()).favModes['zenstruck/foundry'], 'all');
    await post(`/fav/rm?value=${fav}`);
    assert.deepEqual(loadPrefs(prefsPath()).favModes, {});
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

const stackSnapshot = () => {
  const parent = { repo: 'o/r', number: 10, url: 'u10', title: 'PARENT-PR', triggers: [], ci: 'pass', state: 'open', approvals: 0, branch: 'feat/p', base: 'main', defaultBranch: 'main' };
  const child = { repo: 'o/r', number: 11, url: 'u11', title: 'CHILD-PR', triggers: [], ci: 'pass', state: 'open', approvals: 0, branch: 'feat/c', base: 'feat/p', defaultBranch: 'main' };
  const solo = { repo: 'o/r', number: 12, url: 'u12', title: 'SOLO-PR', triggers: [], ci: 'pass', state: 'open', approvals: 0, branch: 'feat/s', base: 'main', defaultBranch: 'main' };
  // child deliberately BEFORE its parent in collection order
  return { data: { mine: [], others: [child, parent, solo] }, updatedAt: NOW, error: null };
};

test('GET /fragment + stacks enabled: stacks first (root on top), solo rows below', () => {
  const res = handleRequest('/fragment', stackSnapshot(), { ...OPTS, stacks: { others: true } });
  const idx = (s) => res.body.indexOf(s);
  assert.ok(idx('PARENT-PR') >= 0 && idx('CHILD-PR') >= 0);
  assert.ok(idx('PARENT-PR') < idx('CHILD-PR') && idx('CHILD-PR') < idx('SOLO-PR'), 'root, child, then solo');
  assert.ok(res.body.includes('stack-indent'));
});

test('GET /fragment without stacks (default): flat order, no marker', () => {
  const res = handleRequest('/fragment', stackSnapshot(), OPTS);
  const iParent = res.body.indexOf('PARENT-PR');
  const iChild = res.body.indexOf('CHILD-PR');
  assert.ok(iChild < iParent, 'collection order untouched');
  assert.ok(!res.body.includes('stack-indent'));
});

// ── integration: a never-seen child PR turns stacks on by itself; POST /stacks toggles ──
test('1st poll with a stack → « Your PRs » stacked by itself; POST /stacks?table=mine flattens, a second POST regroups', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [
      { repository_url: 'https://api.github.com/repos/o/r', number: 2, title: 'CHILD-PR', html_url: 'u2', updated_at: '2026-06-24T00:00:00Z' },
      { repository_url: 'https://api.github.com/repos/o/r', number: 1, title: 'PARENT-PR', html_url: 'u1', updated_at: '2026-06-23T00:00:00Z' },
    ],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: p.number === 1 ? 'PARENT-PR' : 'CHILD-PR', author: { login: 'me' },
      createdAt: '2026-06-24T00:00:00Z', updatedAt: p.number === 2 ? '2026-06-24T00:00:00Z' : '2026-06-23T00:00:00Z',
      additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
      branch: p.number === 1 ? 'feat/p' : 'feat/c', base: p.number === 1 ? 'main' : 'feat/p', defaultBranch: 'main',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-stacks-${process.pid}`;
  process.env.XDG_STATE_HOME = tmp;
  rmSync(tmp, { recursive: true, force: true });

  const PORT = 7793;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    const auto = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(auto.includes('stacks-toggle on'), 'a never-seen child PR turns the stacks mode on by itself');
    assert.ok(auto.includes('stack-indent') && auto.indexOf('PARENT-PR') < auto.indexOf('CHILD-PR'), 'canonical stacked view: root on top');
    assert.equal(loadPrefs(prefsPath()).stacksMine, true, 'persisted under the table\'s own key');
    assert.deepEqual(loadPrefs(prefsPath()).stacksSeen, ['o/r#2'], 'the child PR is now seen');

    await fetch(`http://localhost:${PORT}/stacks?table=mine`, { method: 'POST' });
    const flat = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(!flat.includes('stack-indent'), 'the toggle flattens');
    assert.ok(flat.indexOf('CHILD-PR') < flat.indexOf('PARENT-PR'), 'sorted updated desc: child first');
    assert.ok(!('stacksMine' in loadPrefs(prefsPath())), 'key deleted when off (clean file)');

    await fetch(`http://localhost:${PORT}/stacks?table=mine`, { method: 'POST' });
    const grouped = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(grouped.includes('stack-indent'), 'second POST → grouped again');
  } finally {
    server.close();
  }
});

test('GET /fragment + stacks: the column sorts are DROPPED (no arrow, headers still clickable)', () => {
  const snap = () => {
    const s = stackSnapshot();
    s.data.others[0].createdAt = '2026-06-24T00:00:00Z'; // CHILD-PR
    s.data.others[1].createdAt = '2026-06-23T00:00:00Z'; // PARENT-PR
    s.data.others[2].createdAt = '2026-06-22T00:00:00Z'; // SOLO-PR
    return s;
  };
  // whatever sort was active: the stacked view ignores it — root-first blocks,
  // solos below, no active column (clicking a column exits stacks mode).
  const res = handleRequest('/fragment', snap(), { ...OPTS, stacks: { others: true }, sort: { key: 'date', dir: 'desc' } });
  const idx = (s) => res.body.indexOf(s);
  assert.ok(idx('PARENT-PR') < idx('CHILD-PR') && idx('CHILD-PR') < idx('SOLO-PR'), 'root, child, then solo');
  assert.ok(!res.body.includes('▾') && !res.body.includes('▴'), 'no sort arrow');
  assert.ok(!res.body.includes('col class="sorted"'), 'no highlighted column');
  assert.ok(res.body.includes('data-sort-key'), 'headers stay clickable (clicking exits stacks mode)');
});

test('GET /fragment + stacks per table: « Your PRs » stacked while « others » keeps its own sort', () => {
  const s = stackSnapshot(); // stack in « others » (child, parent, solo)
  s.data.others[0].createdAt = '2026-06-24T00:00:00Z'; // CHILD-PR
  s.data.others[1].createdAt = '2026-06-23T00:00:00Z'; // PARENT-PR
  s.data.others[2].createdAt = '2026-06-22T00:00:00Z'; // SOLO-PR
  const myParent = { repo: 'o/r', number: 20, url: 'u20', title: 'MY-PARENT', triggers: [], ci: 'pass', state: 'open', approvals: 0, branch: 'feat/mp', base: 'main', defaultBranch: 'main', createdAt: '2026-06-23T00:00:00Z' };
  const myChild = { repo: 'o/r', number: 21, url: 'u21', title: 'MY-CHILD', triggers: [], ci: 'pass', state: 'open', approvals: 0, branch: 'feat/mc', base: 'feat/mp', defaultBranch: 'main', createdAt: '2026-06-24T00:00:00Z' };
  s.data.mine = [myChild, myParent];
  const res = handleRequest('/fragment', s, { ...OPTS, stacks: { mine: true }, sort: { key: 'date', dir: 'desc' }, sortMine: { key: 'date', dir: 'desc' } });
  const [mineHtml, othersHtml] = res.body.split('👥');
  const idx = (h, x) => h.indexOf(x);
  // « Your PRs »: canonical stacked view (root on top), its sort neutralized (no arrow).
  assert.ok(idx(mineHtml, 'MY-PARENT') < idx(mineHtml, 'MY-CHILD'), 'mine grouped: root first');
  assert.ok(mineHtml.includes('stack-indent'));
  assert.ok(!mineHtml.includes('▾') && !mineHtml.includes('▴'), 'mine: no sort arrow');
  assert.ok(mineHtml.includes('class="stacks-toggle on" data-stacks-table="mine"'));
  // « others »: untouched by the other table's stacks mode — flat, date desc, arrow shown.
  assert.ok(idx(othersHtml, 'CHILD-PR') < idx(othersHtml, 'PARENT-PR') && idx(othersHtml, 'PARENT-PR') < idx(othersHtml, 'SOLO-PR'), 'others sorted date desc');
  assert.ok(!othersHtml.includes('stack-indent'));
  assert.ok(othersHtml.includes('▾'), 'others: its sort arrow stays');
  assert.ok(othersHtml.includes('class="stacks-toggle" data-stacks-table="others"'));
});

// ── integration: clicking a sort column exits the stacks mode ───────────────
test('POST /sort while stacks is on → THAT table\'s stacks turns off, the other table is untouched', async () => {
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [
      { repository_url: 'https://api.github.com/repos/o/r', number: 2, title: 'CHILD-PR', html_url: 'u2', updated_at: '2026-06-24T00:00:00Z' },
      { repository_url: 'https://api.github.com/repos/o/r', number: 1, title: 'PARENT-PR', html_url: 'u1', updated_at: '2026-06-23T00:00:00Z' },
    ],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: p.number === 1 ? 'PARENT-PR' : 'CHILD-PR', author: { login: 'me' },
      createdAt: p.number === 2 ? '2026-06-24T00:00:00Z' : '2026-06-23T00:00:00Z',
      updatedAt: p.number === 2 ? '2026-06-24T00:00:00Z' : '2026-06-23T00:00:00Z',
      additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
      branch: p.number === 1 ? 'feat/p' : 'feat/c', base: p.number === 1 ? 'main' : 'feat/p', defaultBranch: 'main',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-stacks-sort-${process.pid}`;
  process.env.XDG_STATE_HOME = tmp;
  rmSync(tmp, { recursive: true, force: true });

  const PORT = 7794;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    const grouped = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(grouped.includes('stack-indent'), 'stacks mode on by itself (never-seen child PR)');

    // Sorting the « others » table leaves « Your PRs » stacked (independent states).
    await fetch(`http://localhost:${PORT}/sort?key=date`, { method: 'POST' });
    const still = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(still.includes('stack-indent'), 'a sort on the other table keeps this one stacked');
    assert.ok(still.includes('stacks-toggle on'), 'the button stays selected');

    await fetch(`http://localhost:${PORT}/sort?key=date&table=mine`, { method: 'POST' });
    const flat = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(!flat.includes('stack-indent'), 'clicking a column exits stacks mode');
    assert.ok(!flat.includes('stacks-toggle on'), 'the button is deselected');
    assert.ok(flat.indexOf('CHILD-PR') < flat.indexOf('PARENT-PR'), 'the clicked sort applies (date desc)');
  } finally {
    server.close();
  }
});

// ── integration: auto-surfaced stacks leave the user in charge afterwards ──
test('auto-surfaced stacks: toggled off → stays off on the next poll; a NEW child PR turns it back on', async () => {
  let prs = [1, 2]; // chain 1 ← 2 (mine)
  const detail = (n) => ({
    number: n, title: `PR-${n}`, author: { login: 'me' },
    createdAt: `2026-06-2${n}T00:00:00Z`, updatedAt: `2026-06-2${n}T00:00:00Z`,
    additions: 1, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    branch: `feat/${n}`, base: n === 1 ? 'main' : `feat/${n - 1}`, defaultBranch: 'main',
  });
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => prs.map((n) => ({ repository_url: 'https://api.github.com/repos/o/r', number: n, title: `PR-${n}`, html_url: `u${n}`, updated_at: `2026-06-2${n}T00:00:00Z` })),
    getPullDetailsBatch: async (list) => list.map((p) => detail(p.number)),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-stacks-auto-${process.pid}`;
  process.env.XDG_STATE_HOME = tmp;
  rmSync(tmp, { recursive: true, force: true });

  const PORT = 7811;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  const post = async (p) => (await fetch(`http://localhost:${PORT}${p}`, { method: 'POST' })).json();
  const repoll = () => post('/scope?value='); // forces a synchronous refresh (empty scope = favorites mode)
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    assert.ok((await post('/stacks?table=mine')).fragment.includes('class="stacks-toggle" data-stacks-table="mine"'), 'auto-on, the toggle turns it off');
    assert.ok(!(await repoll()).fragment.includes('stack-indent'), 'same PRs on the next poll → the user\'s choice is respected');

    prs = [1, 2, 3]; // a never-seen child on top of the known stack
    const again = (await repoll()).fragment;
    assert.ok(again.includes('stack-indent') && again.includes('stacks-toggle on'), 'a new child PR turns the stacks mode back on');
    assert.deepEqual(loadPrefs(prefsPath()).stacksSeen, ['o/r#2', 'o/r#3']);

    // Sorting the table also leaves stacks mode, and the next poll respects it too.
    assert.ok(!(await post('/sort?key=date&table=mine')).fragment.includes('stack-indent'));
    assert.ok(!(await repoll()).fragment.includes('stack-indent'), 'still off after a sort');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /cols : hides/shows a column per table, persists, 400 on invalid key', async () => {
  let polls = 0;
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => { polls += 1; return []; },
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/o/r', number: 1, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [
      { repository_url: 'https://api.github.com/repos/o/r', number: 2, title: 'm', html_url: 'u2', updated_at: '2026-06-24T00:00:00Z' },
    ],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: 't', author: { login: p.number === 2 ? 'me' : 'alice' },
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z',
      additions: 3, deletions: 1, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-cols-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7798;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    // Baseline: both tables show the Diff column, and each carries its gear.
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.equal((frag1.match(/data-sort-key="diff"/g) || []).length, 2);
    assert.equal((frag1.match(/cols-btn/g) || []).length, 2);

    // Hide « diff » on others → gone from others only, persisted.
    const r1 = await fetch(`http://localhost:${PORT}/cols?key=diff`, { method: 'POST' });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal((d1.fragment.match(/data-sort-key="diff"/g) || []).length, 1, 'mine keeps its Diff column');
    assert.deepEqual(loadPrefs(prefsPath()).cols, ['diff']);
    assert.equal(loadPrefs(prefsPath()).colsMine, undefined);

    // table=mine: its own state.
    await fetch(`http://localhost:${PORT}/cols?key=branch&table=mine`, { method: 'POST' });
    assert.deepEqual(loadPrefs(prefsPath()).colsMine, ['branch']);
    assert.deepEqual(loadPrefs(prefsPath()).cols, ['diff']);

    // Re-toggle → the column comes back, the pref key disappears.
    const d2 = await (await fetch(`http://localhost:${PORT}/cols?key=diff`, { method: 'POST' })).json();
    assert.equal((d2.fragment.match(/data-sort-key="diff"/g) || []).length, 2);
    assert.equal(loadPrefs(prefsPath()).cols, undefined);

    // The ✕ (hide-button) column is hideable too.
    const rAct = await fetch(`http://localhost:${PORT}/cols?key=act`, { method: 'POST' });
    assert.equal(rAct.status, 200);
    assert.deepEqual(loadPrefs(prefsPath()).cols, ['act']);
    await fetch(`http://localhost:${PORT}/cols?key=act`, { method: 'POST' }); // back

    // Invalid keys → 400, prefs intact (title is the pivot, never hideable).
    for (const bad of ['title', 'nope', '']) {
      const r = await fetch(`http://localhost:${PORT}/cols?key=${bad}`, { method: 'POST' });
      assert.equal(r.status, 400, `key=${bad}`);
    }
    // author is valid on others but not on mine.
    const badMine = await fetch(`http://localhost:${PORT}/cols?key=author&table=mine`, { method: 'POST' });
    assert.equal(badMine.status, 400);
    assert.equal(loadPrefs(prefsPath()).colsMine.includes('author'), false);

    // POST /cols triggers no GitHub poll (local recompute only).
    assert.equal(polls, 1);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: search page (§29) ──────────────────────────────────────────
test('search page: one fetch per query, sort/page from the cache, refresh refetches, errors not cached', async () => {
  let searches = 0;
  let fail = false;
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [],
    searchAuthored: async () => [],
    searchPRs: async () => {
      searches++;
      if (fail) throw new Error('gh: API rate limit exceeded (HTTP 403)');
      return { items: Array.from({ length: 30 }, (_, i) => ({ repository_url: 'https://api.github.com/repos/symfony/web', number: i + 1, title: `t${i + 1}`, html_url: `https://github.com/symfony/web/pull/${i + 1}` })), total: 30 };
    },
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: `t${p.number}`, author: { login: 'alice' }, createdAt: '2026-06-01T00:00:00Z',
      updatedAt: `2026-06-${String(p.number).padStart(2, '0')}T00:00:00Z`, additions: p.number, deletions: 0,
      isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-search-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7813;
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  const base = `http://localhost:${PORT}`;
  const q = encodeURIComponent('author:alice');
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    assert.equal(searches, 0, 'the poll never searches');

    const shell = await fetch(`${base}/search?q=${q}`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /value="author:alice"/);

    const f1 = await (await fetch(`${base}/search-fragment?q=${q}`)).text();
    assert.equal(searches, 1);
    assert.match(f1, /30 PRs/);
    assert.match(f1, /<span class="on">1<\/span>/);
    assert.match(f1, /page=2">2<\/a>/);
    assert.match(f1, />t30</, 'updated-desc by default: #30 first');
    assert.ok(!f1.includes('>t1<'), 'page 1 holds 25 rows: #1 (oldest) is on page 2');

    const f2 = await (await fetch(`${base}/search-fragment?q=${q}&sort=diff&dir=asc&page=2`)).text();
    assert.equal(searches, 1, 'sort/page served from the cache');
    assert.match(f2, /<span class="on">2<\/span>/);
    assert.match(f2, />t26</, 'diff asc (additions = number): page 2 = #26–#30');

    const f3 = await (await fetch(`${base}/search/refresh?q=${q}`, { method: 'POST' })).text();
    assert.equal(searches, 2, 'refresh bypasses the cache');
    assert.match(f3, /30 PRs/);

    fail = true;
    const f4 = await (await fetch(`${base}/search-fragment?q=${encodeURIComponent('author:bob')}`)).text();
    assert.equal(searches, 3);
    assert.match(f4, /⚠️ .*rate limit/);
    fail = false;
    await fetch(`${base}/search-fragment?q=${encodeURIComponent('author:bob')}`);
    assert.equal(searches, 4, 'an error is not cached');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── integration: POST /ready + /draft flip the state of MY PR through gh ────
test('POST /ready and /draft call gh, update the row at once, 400 on unknown PR or gh failure', async () => {
  const calls = [];
  let fail = null;
  const gh = {
    getCurrentUser: async () => 'me',
    listNotifications: async () => [],
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/symfony/web', number: 7, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [
      { repository_url: 'https://api.github.com/repos/symfony/web', number: 43, title: 't', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: 't', author: { login: p.number === 7 ? 'alice' : 'me' }, createdAt: '2026-06-24T00:00:00Z',
      additions: 1, deletions: 0, isDraft: p.number === 43, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
    markReady: async (repo, number) => { calls.push(['ready', repo, number]); if (fail) throw new Error(`Command failed: gh pr ready\n${fail}`); },
    convertToDraft: async (repo, number) => { calls.push(['draft', repo, number]); },
  };
  const tmp = `/tmp/gh-notif-test-draft-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7812;
  const base = `http://localhost:${PORT}`;
  const key = encodeURIComponent('symfony/web#43');
  const server = serve({ gh, me: 'me', scope: null, port: PORT, intervalSeconds: 3600, open: false });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1st poll
    const frag0 = await (await fetch(`${base}/fragment`)).text();
    assert.match(frag0, /data-key="symfony\/web#43" data-to="ready"/, 'draft at first');
    assert.equal((frag0.match(/In review since/g) || []).length, 1, 'only the others\' open PR is in review');

    // draft → ready: gh called, the row shows 🟢 right away (no re-poll needed)
    const r1 = await fetch(`${base}/ready?key=${key}`, { method: 'POST' });
    assert.equal(r1.status, 200);
    assert.deepEqual(calls, [['ready', 'symfony/web', 43]]);
    const d1 = await r1.json();
    assert.match(d1.fragment, /data-key="symfony\/web#43" data-to="draft"/, 'now open');
    assert.doesNotMatch(d1.fragment, /data-to="ready"/);
    assert.equal((d1.fragment.match(/In review since/g) || []).length, 2, 'the review clock of my PR starts now');

    // ready → draft
    const r2 = await fetch(`${base}/draft?key=${key}`, { method: 'POST' });
    assert.equal(r2.status, 200);
    assert.deepEqual(calls.at(-1), ['draft', 'symfony/web', 43]);
    assert.match((await r2.json()).fragment, /data-key="symfony\/web#43" data-to="ready"/, 'draft again');

    // not one of MY PRs (others' #7) or unknown → 400, gh untouched
    const bad1 = await fetch(`${base}/ready?key=${encodeURIComponent('symfony/web#7')}`, { method: 'POST' });
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(`${base}/draft?key=nope`, { method: 'POST' });
    assert.equal(bad2.status, 400);
    assert.equal(calls.length, 2);

    // gh failure → 400 with gh's last line, state unchanged
    fail = 'GraphQL: Resource not accessible by integration (markPullRequestReadyForReview)';
    const r3 = await fetch(`${base}/ready?key=${key}`, { method: 'POST' });
    assert.equal(r3.status, 400);
    assert.equal(await r3.text(), fail);
    const frag3 = await (await fetch(`${base}/fragment`)).text();
    assert.match(frag3, /data-key="symfony\/web#43" data-to="ready"/, 'still a draft');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
