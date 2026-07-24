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
    assert.match(added.fragment, /at symfony/);
    assert.match(added.fragment, /at zenstruck/); // no active favorite → union

    // The background refresh completes: the collection indeed covers the union
    // (a single OR-ed search). We let the async poll settle.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(searches.at(-1), ' org:symfony org:zenstruck');

    // /view (client poll): chips with counters (others' activity) + updatedAt.
    const view = await (await fetch(`http://localhost:${PORT}/view`)).json();
    assert.match(view.chips, /⭐ all <span class="fav-n">\(2\)<\/span>/);
    assert.match(view.chips, /symfony\/\* <span class="fav-n">\(1\)<\/span>/);
    assert.match(view.chips, /zenstruck\/\* <span class="fav-n">\(1\)<\/span>/);
    assert.ok(view.updatedAt > 0, 'updatedAt exposed for the client probe');

    // Selects a favorite: display filter, WITHOUT a new search.
    const before = searches.length;
    const selected = await (await post('/fav?value=symfony')).json();
    assert.equal(searches.length, before, 'switching favorite must cost no request');
    assert.match(selected.fragment, /at symfony/);
    assert.doesNotMatch(selected.fragment, /at zenstruck/);
    assert.match(selected.chips, /data-fav="symfony" class="on"/);
    // The counter of the other favorite stays visible even when we are not looking at it.
    assert.match(selected.chips, /zenstruck\/\* <span class="fav-n">\(1\)<\/span>/);

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
  // Counters = others' activity, computed on the UNION (symfony counts even
  // if the active favorite is zenstruck).
  assert.match(d.chips, /symfony\/\* <span class="fav-n">\(1\)<\/span>/);
  assert.match(d.chips, /zenstruck\/\* <span class="fav-n">\(0\)<\/span>/);
  assert.match(d.chips, /data-fav="zenstruck" class="on"/);
  // The fragment, itself, is filtered on the active favorite.
  assert.match(d.fragment, /at zenstruck/);
  assert.doesNotMatch(d.fragment, /at symfony/);
});

test('GET /fragment : « closed » link contextualized (ad-hoc > active favorite > union of favorites)', () => {
  // No scope nor favorite → link without qualifier.
  let res = handleRequest('/fragment', okSnapshot(), OPTS);
  assert.ok(res.body.includes('href="https://github.com/pulls?q=is%3Apr%20author%3A%40me%20is%3Aclosed"'));
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
    // Default date desc: the recent one (#2) first.
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(frag1.indexOf('o/new#2') < frag1.indexOf('o/old#1'), 'default: date desc');

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
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
