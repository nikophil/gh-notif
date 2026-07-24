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

test('escapeHtml: escapes & < > " \'', () => {
  assert.equal(escapeHtml('a <b> & "c" \'d\''), 'a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;');
});

test('escapeHtml: non-string → empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('renderFragment: section titles with counters', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow(), otherRow({ number: 9 })] }, { now: NOW });
  assert.match(out, /📥 Your open PRs \(1\)/);
  assert.match(out, /👥 Activity on others' PRs \(2\)/);
});

test('renderFragment: link to the PR', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.ok(out.includes('href="https://github.com/mapado/web/pull/120"'));
});

test('renderFragment: dangerous title escaped (no injection)', () => {
  const out = renderFragment({ mine: [myRow({ title: '[X] <script>alert(1)</script> & co' })], others: [] }, { now: NOW });
  assert.ok(out.includes('&lt;script&gt;'), 'the title must be escaped');
  assert.ok(!out.includes('<script>alert(1)'), 'no raw script tag injected');
  assert.ok(out.includes('&amp; co'));
});

test('renderFragment: state / CI / triggers emojis', () => {
  const out = renderFragment({ mine: [myRow({ state: 'draft', ci: 'fail', triggers: ['mention', 'reply'] })], others: [] }, { now: NOW });
  assert.ok(out.includes('📝'));        // draft state
  assert.ok(out.includes('❌'));        // CI fail
  assert.ok(out.includes('💬'));        // trigger mention
  assert.ok(out.includes('↩️'));        // trigger reply
});

test('renderFragment: tooltips (title) on the icons', () => {
  const out = renderFragment(
    { mine: [myRow({ state: 'merged', ci: 'pass', triggers: ['review', 'comment'], approvals: 2 })], others: [] },
    { now: NOW },
  );
  assert.match(out, /title="Merged"/);
  assert.match(out, /title="CI: success"/);
  assert.match(out, /title="Review requested"/);
  assert.match(out, /title="Comment on your PR"/);
  assert.match(out, /title="2 approvals"/);
});

test('renderFragment: « No approval » tooltip when 0', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 0 })], others: [] }, { now: NOW });
  assert.match(out, /title="No approval"/);
});

test('renderFragment: 🎉 ready-to-merge badge if my open PR & ≥2 approvals', () => {
  const out = renderFragment({ mine: [myRow({ state: 'open', approvals: 2 })], others: [] }, { now: NOW });
  assert.ok(out.includes('🎉'), 'badge present');
  assert.match(out, /title="Ready to merge"/);
});

test('renderFragment: no 🎉 badge below threshold nor on draft/merged', () => {
  assert.ok(!renderFragment({ mine: [myRow({ state: 'open', approvals: 1 })], others: [] }, { now: NOW }).includes('🎉'));
  assert.ok(!renderFragment({ mine: [myRow({ state: 'draft', approvals: 3 })], others: [] }, { now: NOW }).includes('🎉'));
  assert.ok(!renderFragment({ mine: [myRow({ state: 'merged', approvals: 3 })], others: [] }, { now: NOW }).includes('🎉'));
});

test('renderFragment: approvals (number, · if zero)', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 3 })], others: [myRow({ number: 7, approvals: 0 })] }, { now: NOW });
  assert.ok(out.includes('3'));
});

test('renderFragment: others → author, relative date, diff +/−', () => {
  const out = renderFragment({ mine: [], others: [otherRow({ state: 'merged', approvals: 4 })] }, { now: NOW });
  assert.ok(out.includes('@alice'));
  assert.ok(out.includes('3d ago'));        // relativeDate
  assert.ok(out.includes('+412'));          // diff additions
  assert.ok(out.includes('−38'));           // diff deletions (U+2212)
  assert.ok(out.includes('🟣'));            // merged state
});

test('renderFragment: diff in two distinct spans (green additions / red deletions)', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW });
  assert.match(out, /class="add"[^>]*>\+412</);
  assert.match(out, /class="del"[^>]*>−38</);
});

test('renderFragment: empty state → « Nothing to report »', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW });
  assert.match(out, /Nothing to report/);
});

test('renderFragment: only « mine » (others empty) doesn’t show the others section', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.match(out, /Your open PRs/);
  assert.doesNotMatch(out, /Activity on others' PRs/);
});

test('renderFragment: links in a new tab (_blank + noopener)', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener"/);
});

test('renderFragment: hide button (✕) on « others » rows, not on mine', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  // an action button targeting the others' PR
  assert.match(out, /class="act"[^>]*data-key="mapado\/api#55"[^>]*data-act="hide"/);
  // the « mine » section (1st section) has no act button
  const mineSection = out.split('👥')[0];
  assert.ok(!mineSection.includes('class="act"'));
});

test('renderFragment: showHidden shows hidden rows (greyed out + restore)', () => {
  const data = {
    mine: [],
    others: [otherRow()],
    hidden: [otherRow({ repo: 'mapado/old', number: 9, title: 'old PR' })],
    hiddenCount: 1,
  };
  const shown = renderFragment(data, { now: NOW, showHidden: true });
  assert.match(shown, /class="hid"/);                       // greyed-out row
  assert.match(shown, /data-key="mapado\/old#9"[^>]*data-act="show"/); // restore button
  assert.match(shown, /1 hidden/);                          // counter in the title
  // without showHidden: the hidden row does not appear
  const hiddenView = renderFragment(data, { now: NOW, showHidden: false });
  assert.ok(!hiddenView.includes('mapado/old#9'));
  assert.match(hiddenView, /1 hidden/); // counter shown even collapsed
});

// ── renderShell (page + polling) ───────────────────────────────────────────
test('renderShell: complete HTML page with polling of /view', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.ok(out.startsWith('<!doctype html'), 'starts with the doctype');
  assert.ok(out.includes('id="content"'), 'refreshed container');
  // The client poll goes through /view ({chips, fragment, updatedAt}): the favorites
  // bar (counters) refreshes at the same rhythm as the tables.
  assert.ok(out.includes("'/view'"), 'unified poll endpoint');
  assert.ok(out.includes('10000'), 'interval injected in the JS');
});

test('renderShell: no external asset (all inline)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.ok(!/src="https?:/.test(out), 'no external script');
  assert.ok(!/href="https?:[^"]*\.css/.test(out), 'no external stylesheet');
});

test('renderShell: default intervalMs if absent', () => {
  const out = renderShell();
  assert.ok(out.startsWith('<!doctype html'));
});

test('renderShell: embeds the style + the spinner usage', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /@keyframes ghn-spin/);     // animation defined
  assert.match(out, /class="spinner"/);          // used (activity indicator)
});

test('renderShell: the « upd » stamp reflects the snapshot updatedAt, not the reload time', () => {
  const out = renderShell({ intervalMs: 10000 });
  // setContent receives the server updatedAt: after a ctrl+R, « upd HH:MM:SS »
  // is the time of the real GitHub poll, not the display time.
  assert.ok(out.includes('setContent(d.fragment, d.updatedAt)'), 'updatedAt propagated to the stamp');
});

test('renderShell: page load forces a real poll (server-debounced)', () => {
  const out = renderShell({ intervalMs: 10000 });
  // Boot: shows the snapshot right away, then POST /refresh (the server
  // ignores it if the snapshot is fresh) → ctrl+R really refreshes the data.
  assert.match(out, /load\(\)\.then\([\s\S]*act\('\/refresh'\)/, 'boot = load then /refresh');
});

test('renderLoading: spinner + label + data-loading sentinel', () => {
  const out = renderLoading();
  assert.match(out, /class="spinner"/);
  assert.match(out, /Loading/);
  assert.match(out, /data-loading/);
});

test('renderShell: 🐛 link to /debug in the header', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /href="\/debug"/);
});

test('renderShell: desktop notifs checkbox checked when enabled', () => {
  const out = renderShell({ intervalMs: 10000, notifyEnabled: true });
  assert.match(out, /id="notify"/);
  assert.match(out, /id="notify"[^>]*\schecked/);          // checked
  assert.match(out, /\/notify/);                           // posts to the /notify route
});

test('renderShell: desktop notifs checkbox unchecked when disabled', () => {
  const out = renderShell({ intervalMs: 10000, notifyEnabled: false });
  assert.match(out, /id="notify"/);
  assert.ok(!/id="notify"[^>]*\schecked/.test(out), 'must not be checked');
});

test('renderShell: notifs enabled by default (notifyEnabled absent)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /id="notify"[^>]*\schecked/);
});

test('renderShell: data-theme on <html> according to preference', () => {
  assert.match(renderShell({ theme: 'dark' }), /<html lang="en" data-theme="dark"/);
  assert.match(renderShell({ theme: 'light' }), /<html lang="en" data-theme="light"/);
});

test('renderShell: data-theme="auto" by default', () => {
  assert.match(renderShell({}), /<html lang="en" data-theme="auto"/);
});

test('renderShell: CSS handles auto (media) + explicit light/dark overrides', () => {
  const out = renderShell({ theme: 'auto' });
  assert.match(out, /:root\[data-theme="auto"\]/);   // dark follows the system in auto
  assert.match(out, /:root\[data-theme="light"\]/);  // force light
  assert.match(out, /:root\[data-theme="dark"\]/);   // force dark
});

test('renderShell: 3-button switcher, the active one highlighted (.on) per theme', () => {
  const out = renderShell({ theme: 'dark' });
  assert.match(out, /data-theme-val="auto"/);
  assert.match(out, /data-theme-val="light"/);
  assert.match(out, /data-theme-val="dark"/);
  // the current theme's button carries the on class
  assert.match(out, /data-theme-val="dark"[^>]*class="[^"]*\bon\b/);
  assert.ok(!/data-theme-val="light"[^>]*\bon\b/.test(out), 'only the current theme is active');
});

test('renderShell: the switcher posts to /theme', () => {
  assert.match(renderShell({ theme: 'auto' }), /\/theme/);
});

test('renderShell: inline GitHub logo favicon (SVG data-URI, theme-aware)', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(out, /prefers-color-scheme:dark/);          // light/dark adaptive
  assert.match(out, /%231f2328/);                          // `#` encoded (not a fragment)
  assert.ok(!/href="https?:[^"]*\.(svg|ico|png)/.test(out), 'favicon not external');
});

test('renderDebugShell: inline GitHub logo favicon (SVG data-URI)', () => {
  const out = renderDebugShell({ intervalMs: 9000 });
  assert.match(out, /<link rel="icon" href="data:image\/svg\+xml,/);
});

// ── renderDebug / renderDebugShell ─────────────────────────────────────────
test('renderDebug: kept/dropped verdict, linked PR, escaping', () => {
  const debug = [
    { repo: 'o/r', number: 42, title: '[X] <script>alert(1)</script>', ghReason: 'review_requested', commentsCount: 3, verdict: { kept: true, category: 'review_request', reason: 'review request' } },
    { repo: 'o/x', number: 7, title: 'My PR', ghReason: 'author', commentsCount: 0, verdict: { kept: false, category: null, reason: 'your own action' } },
  ];
  const out = renderDebug(debug, { now: NOW });
  assert.match(out, /1\/2 threads kept/);
  assert.match(out, /href="https:\/\/github.com\/o\/r\/pull\/42"/);
  assert.match(out, /✓ review_request/);
  assert.match(out, /✗ dropped/);
  assert.match(out, /your own action/);
  assert.match(out, /&lt;script&gt;/);            // dangerous title escaped
  assert.ok(!out.includes('<script>alert(1)'), 'no injection');
});

test('renderDebug: empty → neutral message', () => {
  assert.match(renderDebug([], {}), /No notification thread/);
});

test('renderDebug: « Checks by repo » section — DISTINCT checks per repo, ignored checked/struck', () => {
  const rows = [
    { repo: 'mapado/ticketing', number: 60, ci: 'pass', checks: [
      { name: 'continuous-integration/jenkins/branch', state: 'pass' },
      { name: 'Check Pull Requests label for merge block', state: 'fail' },
      { name: 'x<script>', state: 'pending' },
    ] },
    { repo: 'mapado/ticketing', number: 61, ci: 'fail', checks: [
      { name: 'continuous-integration/jenkins/branch', state: 'fail' }, // same check, other PR
      { name: 'behat', state: 'fail' },
    ] },
  ];
  const out = renderDebug([], { rows, ignoredChecks: { 'mapado/ticketing': ['Check Pull Requests label for merge block'] } });
  assert.match(out, /Checks by repo/);
  assert.match(out, /mapado\/ticketing/);
  // jenkins appears ONLY once despite 2 PRs (distinct checks per repo)
  assert.equal((out.match(/data-name="continuous-integration\/jenkins\/branch"/g) || []).length, 1);
  assert.match(out, /data-name="behat"/); // check from another PR of the same repo
  // the ignored job is checked + struck; the important job is not
  assert.match(out, /<del>Check Pull Requests label for merge block<\/del>/);
  assert.match(out, /data-repo="mapado\/ticketing"[^>]*data-name="Check Pull Requests label for merge block"[^>]*checked/);
  assert.ok(!/data-name="continuous-integration\/jenkins\/branch"[^>]*checked/.test(out), 'jenkins not checked');
  // dangerous check name escaped (anti-injection)
  assert.match(out, /x&lt;script&gt;/);
  assert.ok(!out.includes('x<script>'), 'no injection');
});

test('renderDebug: checks section stays empty (compat) when no row is provided', () => {
  const out = renderDebug([{ repo: 'o/r', number: 1, title: 't', ghReason: 'author', commentsCount: 0, verdict: { kept: true, category: 'x', reason: 'r' } }], { now: NOW });
  assert.ok(!out.includes('Checks by repo'), 'no section without rows');
});

test('renderDebugShell: standalone page that polls /debug-fragment, back link, no external asset', () => {
  const out = renderDebugShell({ intervalMs: 9000 });
  assert.ok(out.startsWith('<!doctype html'));
  assert.match(out, /\/debug-fragment/);
  assert.match(out, /9000/);
  assert.match(out, /href="\/"/);                 // back to tables
  assert.ok(!/src="https?:/.test(out), 'no external script');
  // interactive: the checkboxes post to /ignore-check and re-render
  assert.match(out, /\/ignore-check/);
  assert.match(out, /addEventListener\('change'/);
  assert.match(out, /encodeURIComponent/);
});

// ── Favorites bar (web) ───────────────────────────────────────────────────

test('renderFavorites: active chip marked .on, « ⭐ all » active if no favorite', () => {
  const list = ['mapado', 'zenstruck'];
  const active = renderFavorites(list, 'mapado');
  assert.match(active, /<button data-fav="mapado" class="on">mapado\/\*<\/button>/);
  assert.doesNotMatch(active, /<button data-fav="" class="on"/); // « all » not active
  const all = renderFavorites(list, null);
  assert.match(all, /<button data-fav="" class="on"/);
  assert.doesNotMatch(all, /data-fav="mapado" class="on"/);
});

test('renderFavorites: an org shows as « org/* », a repo as-is — data-fav stays raw', () => {
  const html = renderFavorites(['mapado', 'noctud/collection'], null);
  assert.match(html, /data-fav="mapado"[^>]*>mapado\/\*</);            // decorated label…
  assert.match(html, /data-fav-rm="mapado"/);                          // …raw value for the API
  assert.match(html, /data-fav="noctud\/collection"[^>]*>noctud\/collection</); // repo unchanged
});

test('renderFavorites: counters (others’ activity) per chip and on « all »', () => {
  const counts = { total: 8, byFav: { mapado: 5, zenstruck: 3 } };
  const html = renderFavorites(['mapado', 'zenstruck'], null, { counts });
  assert.match(html, /⭐ all <span class="fav-n">\(8\)<\/span>/);
  assert.match(html, /mapado\/\* <span class="fav-n">\(5\)<\/span>/);
  assert.match(html, /zenstruck\/\* <span class="fav-n">\(3\)<\/span>/);
});

test('renderFavorites: favorite absent from counters → (0); without counts → no badge', () => {
  const html = renderFavorites(['mapado'], null, { counts: { total: 0, byFav: {} } });
  assert.match(html, /mapado\/\* <span class="fav-n">\(0\)<\/span>/);
  assert.doesNotMatch(renderFavorites(['mapado'], null), /fav-n/);
});

test('renderFavorites: each chip has its removal cross', () => {
  const html = renderFavorites(['mapado'], null);
  assert.match(html, /data-fav-rm="mapado"/);
});

test('renderFavorites: empty list → empty string (no visual change)', () => {
  assert.equal(renderFavorites([], null), '');
  assert.equal(renderFavorites(undefined, null), '');
});

test('renderFavorites: ad-hoc mode → greyed-out bar, no active chip', () => {
  const html = renderFavorites(['mapado'], 'mapado', { adhoc: true });
  assert.match(html, /class="favs adhoc"/);
  assert.doesNotMatch(html, /class="on"/);
});

test('renderFavorites escapes the values (anti-injection: user input)', () => {
  const html = renderFavorites(['<script>alert(1)</script>', 'a&b'], null);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a&amp;b/);
});

test('renderShell: integrates the favorites bar and the ⭐ pin button', () => {
  const html = renderShell({ favorites: ['mapado'], activeFav: 'mapado' });
  assert.match(html, /id="favs"/);
  assert.match(html, /data-fav="mapado" class="on"/);
  assert.match(html, /id="scope-fav"/);
});

test('renderShell without favorites: the bar stays empty', () => {
  const html = renderShell({});
  assert.match(html, /<div id="favs"><\/div>/);
});

test('renderFragment: « closed ↗ » link in the title when closedUrl is provided', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW, closedUrl: 'https://github.com/pulls?q=x%20%26%20y' });
  assert.match(out, /Your open PRs \(1\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=x%20%26%20y"'), 'href of the closed link');
  assert.ok(out.includes('target="_blank"'));
  assert.match(out, /closed ↗/);
});

test('renderFragment: without closedUrl → no link (compat)', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.ok(!out.includes('closed ↗'));
});

test('renderFragment: dangerous closedUrl escaped', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW, closedUrl: 'https://x/?a="<b>&c' });
  assert.ok(out.includes('href="https://x/?a=&quot;&lt;b&gt;&amp;c"'), 'URL escaped');
});

test('renderFragment: mine empty + closedUrl → section (0) with link, without table', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW, closedUrl: 'https://github.com/pulls?q=z' });
  assert.match(out, /Your open PRs \(0\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=z"'));
  assert.ok(!out.includes('<table'), 'no empty table');
  assert.ok(!out.includes('Nothing to report'));
});

test('renderFragment: mine empty without closedUrl → unchanged behavior', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW });
  assert.match(out, /Nothing to report/);
});

// ── Sortable headers (« others » column) ───────────────────────────────────

test('renderFragment with opts.sort: clickable th + indicator on the active column', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: '2026-07-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'date', dir: 'desc' } });
  assert.match(html, /<th[^>]*data-sort-key="author"[^>]*>Author<\/th>/);
  assert.match(html, /<th[^>]*data-sort-key="date"[^>]*>Opened ▾<\/th>/); // active column + direction
  assert.match(html, /<th[^>]*data-sort-key="approvals"/);
  // asc → ▴
  const asc = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'author', dir: 'asc' } });
  assert.match(asc, /<th[^>]*data-sort-key="author"[^>]*>Author ▴<\/th>/);
  assert.match(asc, /<th[^>]*data-sort-key="date"[^>]*>Opened<\/th>/); // inactive: no indicator
});

test('renderFragment without opts.sort: unchanged output (no data-sort-key)', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: null, additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: 0 });
  assert.ok(!html.includes('data-sort-key'), 'compat: no sortable th without opts.sort');
});

test('the « Your PRs » table never has a sortable header', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  const html = renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } });
  assert.ok(!html.includes('data-sort-key'), 'mine: no sort');
});

test('renderShell: the JS handles the click on th[data-sort-key] → POST /sort', () => {
  const page = renderShell({});
  assert.match(page, /data-sort-key/);
  assert.match(page, /\/sort/);
});

// ── Sorted column highlight (colgroup) ─────────────────────────────────────

// Position (1-based) of the col.sorted in the colgroup, or -1.
function sortedColIndex(html) {
  const m = html.match(/<colgroup>(.*?)<\/colgroup>/);
  if (!m) return -1;
  const cols = m[1].match(/<col[^>]*>/g) || [];
  return cols.findIndex((c) => c.includes('sorted')) + 1 || -1;
}

// Position (1-based) of the active th — that of the requested data-sort-key.
// ⚠️ `(?:\s…)?` and not `[^>]*`: otherwise <thead> would count as a th.
function thIndex(html, key) {
  const ths = html.match(/<th(?:\s[^>]*)?>/g) || [];
  return ths.findIndex((t) => t.includes(`data-sort-key="${key}"`)) + 1 || -1;
}

test('active sort: the colgroup marks the active th column (derived position, not hard-coded)', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: '2026-07-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  for (const key of ['author', 'date', 'approvals']) {
    const html = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key, dir: 'asc' } });
    const col = sortedColIndex(html);
    assert.ok(col > 0, `colgroup present and marked for ${key}`);
    assert.equal(col, thIndex(html, key), `col.sorted aligned with th ${key}`);
    // only one marked col
    assert.equal((html.match(/<col class="sorted">/g) || []).length, 1);
  }
});

test('without opts.sort: no colgroup (unchanged output)', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: null, additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  assert.ok(!renderFragment(data, { now: 0 }).includes('<colgroup>'));
});

test('the « Your PRs » table never has a colgroup, even with active sort', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  assert.ok(!renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } }).includes('<colgroup>'));
});

test('renderShell: col.sorted style present (discreet veil on the sorted column)', () => {
  assert.match(renderShell({}), /col\.sorted/);
});
