import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderFragment, renderShell, renderLoading, renderDebug, renderDebugShell, renderFavorites } from '../src/html.js';

const NOW = new Date('2026-06-24T12:00:00Z').getTime();

const myRow = (over = {}) => ({
  repo: 'symfony/web', number: 120, url: 'https://github.com/symfony/web/pull/120',
  title: 'fix header', triggers: ['comment'], ci: 'pass', state: 'open', approvals: 0,
  createdAt: '2026-06-22T12:00:00Z', updatedAt: '2026-06-23T12:00:00Z', additions: 17, deletions: 4, ...over,
});
const otherRow = (over = {}) => ({
  repo: 'symfony/api', number: 55, url: 'https://github.com/symfony/api/pull/55',
  title: 'perf: cache', triggers: ['review'], ci: 'pass', author: 'alice',
  createdAt: '2026-06-21T12:00:00Z', updatedAt: '2026-06-22T00:00:00Z', additions: 412, deletions: 38, state: 'open', approvals: 2, ...over,
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
  assert.ok(out.includes('href="https://github.com/symfony/web/pull/120"'));
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

test('renderFragment: changes-requested icon (red file-diff) + tooltip', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 2, changesRequested: 1 })], others: [] }, { now: NOW });
  assert.match(out, /title="1 change requested"/);
  assert.ok(out.includes('<svg'), 'the file-diff svg is embedded');
  assert.ok(out.includes('var(--danger)'), 'icon tinted with the danger color');
});

test('renderFragment: changes-requested plural in the tooltip', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 0, changesRequested: 2 })], others: [] }, { now: NOW });
  assert.match(out, /title="2 changes requested"/);
});

test('renderFragment: changes-requested icon shown even with 0 approvals', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 0, changesRequested: 1 })], others: [] }, { now: NOW });
  assert.match(out, /title="1 change requested"/);
  assert.ok(!out.includes('title="No approval"'), 'no « No approval » placeholder when changes are requested');
});

test('renderFragment: no changes-requested icon when count is zero', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 0, changesRequested: 0 })], others: [] }, { now: NOW });
  assert.match(out, /title="No approval"/);
  assert.ok(!out.includes('change requested'));
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

test('renderFragment: « mine » table shows Opened, Updated and Diff like the others table', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  const mineSection = out.split('👥')[0];
  assert.match(mineSection, /<th>Opened<\/th>/);
  assert.match(mineSection, /<th>Updated<\/th>/);
  assert.match(mineSection, /<th>Diff<\/th>/);
  assert.match(mineSection, /Opened 2d ago/);        // tooltip on the relative date
  assert.match(mineSection, /Updated 1d ago/);       // idem for the last update
  assert.ok(mineSection.includes('<span class="add">+17</span>'));
  assert.ok(mineSection.includes('<span class="del">−4</span>'));
});

test('renderFragment: « others » table shows Updated too', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW });
  assert.match(out, /<th>Updated<\/th>/);
  assert.match(out, /Updated 2d ago/);
});

test('renderFragment: Branch column (both tables), GitHub-like chip + copy button', () => {
  const out = renderFragment(
    { mine: [myRow({ branch: 'feat/login' })], others: [otherRow({ branch: 'fix/cache' })] },
    { now: NOW },
  );
  const mineSection = out.split('👥')[0];
  const othersSection = out.split('👥')[1];
  assert.match(mineSection, /<th>Branch<\/th>/);
  assert.match(othersSection, /<th>Branch<\/th>/);
  assert.match(mineSection, /class="branch"[^>]*>feat\/login</);
  assert.ok(mineSection.includes('data-copy="feat/login"'));
  assert.match(othersSection, /class="branch"[^>]*>fix\/cache</);
  assert.ok(othersSection.includes('data-copy="fix/cache"'));
});

test('renderFragment: the branch chip links to the tree of the head repo', () => {
  const out = renderFragment(
    {
      mine: [myRow({ branch: 'feat/login', branchRepo: 'symfony/web' })],
      others: [otherRow({ branch: 'fix/cache', branchRepo: 'fork/api' })], // PR from a fork
    },
    { now: NOW },
  );
  assert.ok(out.includes('href="https://github.com/symfony/web/tree/feat/login"'));
  assert.ok(out.includes('href="https://github.com/fork/api/tree/fix/cache"'));
});

test('renderFragment: branch link falls back on the base repo, URL-encodes the ref', () => {
  const out = renderFragment(
    { mine: [myRow({ branch: 'feat/a#b', branchRepo: null })], others: [] },
    { now: NOW },
  );
  assert.ok(out.includes('href="https://github.com/symfony/web/tree/feat/a%23b"'));
});

test('renderFragment: Status/Triggers headers are icon-only (label in the tooltip)', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.doesNotMatch(out, /<th>Status<\/th>/);
  assert.doesNotMatch(out, /<th>Triggers<\/th>/);
  assert.match(out, /<abbr title="Status"[^>]*>🚦<\/abbr>/);
  assert.match(out, /<abbr title="Triggers"[^>]*>⚡<\/abbr>/);
});

test('renderFragment: no copy button on the PR number (branch only)', () => {
  const out = renderFragment({ mine: [myRow({ branch: 'feat/x' })], others: [] }, { now: NOW });
  assert.ok(!out.includes('data-copy="120"'));
  assert.equal((out.match(/data-copy=/g) || []).length, 1); // the branch one
});

test('renderFragment: missing branch → empty cell, no copy button at all', () => {
  const out = renderFragment({ mine: [myRow({ branch: null })], others: [] }, { now: NOW });
  assert.equal((out.match(/data-copy=/g) || []).length, 0);
});

test('renderFragment: branch name escaped (anti-injection)', () => {
  const out = renderFragment({ mine: [myRow({ branch: 'a"b<c' })], others: [] }, { now: NOW });
  assert.ok(out.includes('a&quot;b&lt;c'));
  assert.ok(!out.includes('a"b<c'));
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
  assert.match(out, /class="act"[^>]*data-key="symfony\/api#55"[^>]*data-act="hide"/);
  // the « mine » section (1st section) has no act button
  const mineSection = out.split('👥')[0];
  assert.ok(!mineSection.includes('class="act"'));
});

test('renderFragment: showHidden shows hidden rows (greyed out + restore)', () => {
  const data = {
    mine: [],
    others: [otherRow()],
    hidden: [otherRow({ repo: 'symfony/old', number: 9, title: 'old PR' })],
    hiddenCount: 1,
  };
  const shown = renderFragment(data, { now: NOW, showHidden: true });
  assert.match(shown, /class="hid"/);                       // greyed-out row
  assert.match(shown, /data-key="symfony\/old#9"[^>]*data-act="show"/); // restore button
  assert.match(shown, /1 hidden/);                          // counter in the title
  // without showHidden: the hidden row does not appear
  const hiddenView = renderFragment(data, { now: NOW, showHidden: false });
  assert.ok(!hiddenView.includes('symfony/old#9'));
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
  // Generic message hints that the first fetch takes a moment.
  assert.match(out, /first fetch/i);
});

test('renderLoading: contextual scope label (and escapes it)', () => {
  assert.match(renderLoading('noctud'), /Loading pull requests for noctud/);
  // A favorite value is user-controlled → escaped like everywhere else.
  assert.match(renderLoading('a&b'), /a&amp;b/);
});

test('renderShell: 🐛 link to /debug in the header', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /href="\/debug"/);
});

test('renderShell: the scope input cannot be resurrected by browser form restore', () => {
  const out = renderShell({ intervalMs: 10000 });
  // Browsers restore user-typed values on reload/session restore: a long-gone
  // ad-hoc scope would reappear after a server restart. autocomplete="off"
  // disables it (Firefox), and the boot script forces the server-rendered value
  // back (defaultValue = the value="" attribute).
  assert.match(out, /id="scope"[^>]*autocomplete="off"/);
  assert.ok(out.includes('scopeInput.value = scopeInput.defaultValue'), 'boot resync to the server state');
});

test('renderShell: 📬 link to the real GitHub notifications page', () => {
  const out = renderShell({ intervalMs: 10000 });
  assert.match(out, /href="https:\/\/github\.com\/notifications"/);
  // External link → new tab + noopener, like every GitHub link on the page.
  assert.match(out, /id="github-link"[^>]*target="_blank"[^>]*rel="noopener"/);
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

// ── CI checks popover (click on the ✗/🟡 icon of the CI column) ─────────────

const failChecks = [
  { name: 'behat', state: 'fail', url: 'https://github.com/symfony/web/runs/1' },
  { name: 'jenkins/branch', state: 'fail', url: null },
  { name: 'blocking label', state: 'pending', url: 'https://github.com/symfony/web/runs/2' },
  { name: 'phpstan', state: 'pass', url: 'https://github.com/symfony/web/runs/3' },
  { name: 'mago', state: 'pass', url: 'https://github.com/symfony/web/runs/4' },
];

test('renderFragment: CI fail → clickable icon + popover grouped à la GitHub', () => {
  const out = renderFragment({ mine: [myRow({ ci: 'fail', checks: failChecks })], others: [] }, { now: NOW });
  assert.match(out, /button class="ci-btn"/);
  // groups with GitHub wording (plural handled), in order fail → pending → pass
  assert.match(out, /2 failing checks/);
  assert.match(out, /1 pending check</);
  assert.match(out, /2 successful checks/);
  assert.ok(out.indexOf('failing check') < out.indexOf('pending check'), 'failing before pending');
  assert.ok(out.indexOf('pending check') < out.indexOf('successful check'), 'pending before successful');
  // each check with a URL links to its run in a new tab
  assert.match(out, /href="https:\/\/github\.com\/symfony\/web\/runs\/1" target="_blank" rel="noopener">behat</);
  // a check without URL stays plain text (no dead link)
  assert.ok(!/href[^>]*>jenkins\/branch</.test(out), 'no link without URL');
  assert.ok(out.includes('jenkins/branch'), 'the linkless check is still listed');
});

test('renderFragment: CI pending → popover too (running checks clickable)', () => {
  const checks = [
    { name: 'build', state: 'pending', url: 'https://github.com/symfony/api/runs/9' },
    { name: 'lint', state: 'pass', url: null },
  ];
  const out = renderFragment({ mine: [], others: [otherRow({ ci: 'pending', checks })] }, { now: NOW });
  assert.match(out, /button class="ci-btn"/);
  assert.match(out, /1 pending check</);
  assert.match(out, /href="https:\/\/github\.com\/symfony\/api\/runs\/9" target="_blank" rel="noopener">build</);
});

test('renderFragment: CI pass/none or no checks → icon not clickable (no popover)', () => {
  const pass = renderFragment({ mine: [myRow({ ci: 'pass', checks: failChecks })], others: [] }, { now: NOW });
  assert.ok(!pass.includes('ci-btn'), 'pass → plain icon');
  const none = renderFragment({ mine: [myRow({ ci: 'none', checks: [] })], others: [] }, { now: NOW });
  assert.ok(!none.includes('ci-btn'), 'none → plain icon');
  const noChecks = renderFragment({ mine: [myRow({ ci: 'fail', checks: [] })], others: [] }, { now: NOW });
  assert.ok(!noChecks.includes('ci-btn'), 'fail without check detail → plain icon');
});

test('renderFragment: ignored checks (repo blocklist) struck/greyed in the popover', () => {
  const checks = [
    { name: 'real', state: 'fail', url: 'https://x.test/2' },
    { name: 'flaky', state: 'fail', url: 'https://x.test/1' },
  ];
  const out = renderFragment(
    { mine: [], others: [otherRow({ ci: 'fail', checks })] },
    { now: NOW, ignoredChecks: { 'symfony/api': ['flaky'] } },
  );
  // the ignored check is struck (its line carries .ignored), the real one is not
  assert.match(out, /<li class="ci-check ignored">[^]*?flaky/);
  assert.ok(!/<li class="ci-check ignored">[^]*?real/.test(out), 'real check not struck');
  assert.match(out, /<li class="ci-check">[^]*?real/);
});

test('renderFragment: dangerous check name and URL escaped in the popover', () => {
  const checks = [{ name: 'x<script>alert(1)</script>', state: 'fail', url: 'https://x.test/"><script>' }];
  const out = renderFragment({ mine: [myRow({ ci: 'fail', checks })], others: [] }, { now: NOW });
  assert.ok(out.includes('x&lt;script&gt;'), 'check name escaped');
  assert.ok(!out.includes('<script>alert(1)'), 'no raw script tag');
  assert.ok(!out.includes('"><script>'), 'URL escaped in the attribute');
});

test('renderDebug: « Checks by repo » section — DISTINCT checks per repo, ignored checked/struck', () => {
  const rows = [
    { repo: 'symfony/ticketing', number: 60, ci: 'pass', checks: [
      { name: 'continuous-integration/jenkins/branch', state: 'pass' },
      { name: 'Check Pull Requests label for merge block', state: 'fail' },
      { name: 'x<script>', state: 'pending' },
    ] },
    { repo: 'symfony/ticketing', number: 61, ci: 'fail', checks: [
      { name: 'continuous-integration/jenkins/branch', state: 'fail' }, // same check, other PR
      { name: 'behat', state: 'fail' },
    ] },
  ];
  const out = renderDebug([], { rows, ignoredChecks: { 'symfony/ticketing': ['Check Pull Requests label for merge block'] } });
  assert.match(out, /Checks by repo/);
  assert.match(out, /symfony\/ticketing/);
  // jenkins appears ONLY once despite 2 PRs (distinct checks per repo)
  assert.equal((out.match(/data-name="continuous-integration\/jenkins\/branch"/g) || []).length, 1);
  assert.match(out, /data-name="behat"/); // check from another PR of the same repo
  // the ignored job is checked + struck; the important job is not
  assert.match(out, /<del>Check Pull Requests label for merge block<\/del>/);
  assert.match(out, /data-repo="symfony\/ticketing"[^>]*data-name="Check Pull Requests label for merge block"[^>]*checked/);
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
  const list = ['symfony', 'zenstruck'];
  const active = renderFavorites(list, 'symfony');
  assert.match(active, /<button data-fav="symfony" class="on">symfony\/\*<\/button>/);
  assert.doesNotMatch(active, /<button data-fav="" class="on"/); // « all » not active
  const all = renderFavorites(list, null);
  assert.match(all, /<button data-fav="" class="on"/);
  assert.doesNotMatch(all, /data-fav="symfony" class="on"/);
});

test('renderFavorites: an org shows as « org/* », a repo as-is — data-fav stays raw', () => {
  const html = renderFavorites(['symfony', 'noctud/collection'], null);
  assert.match(html, /data-fav="symfony"[^>]*>symfony\/\*</);            // decorated label…
  assert.match(html, /data-fav-rm="symfony"/);                          // …raw value for the API
  assert.match(html, /data-fav="noctud\/collection"[^>]*>noctud\/collection</); // repo unchanged
});

test('renderFavorites: counters (others’ activity) per chip and on « all »', () => {
  const counts = { total: 8, byFav: { symfony: 5, zenstruck: 3 } };
  const html = renderFavorites(['symfony', 'zenstruck'], null, { counts });
  assert.match(html, /⭐ all <span class="fav-n">\(8\)<\/span>/);
  assert.match(html, /symfony\/\* <span class="fav-n">\(5\)<\/span>/);
  assert.match(html, /zenstruck\/\* <span class="fav-n">\(3\)<\/span>/);
});

test('renderFavorites: favorite absent from counters → (0); without counts → no badge', () => {
  const html = renderFavorites(['symfony'], null, { counts: { total: 0, byFav: {} } });
  assert.match(html, /symfony\/\* <span class="fav-n">\(0\)<\/span>/);
  assert.doesNotMatch(renderFavorites(['symfony'], null), /fav-n/);
});

test('renderFavorites: each chip has its removal cross', () => {
  const html = renderFavorites(['symfony'], null);
  assert.match(html, /data-fav-rm="symfony"/);
});

test('renderFavorites: empty list → empty string (no visual change)', () => {
  assert.equal(renderFavorites([], null), '');
  assert.equal(renderFavorites(undefined, null), '');
});

test('renderFavorites: ad-hoc mode → greyed-out bar, no active chip', () => {
  const html = renderFavorites(['symfony'], 'symfony', { adhoc: true });
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
  const html = renderShell({ favorites: ['symfony'], activeFav: 'symfony' });
  assert.match(html, /id="favs"/);
  assert.match(html, /data-fav="symfony" class="on"/);
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
  assert.match(html, /<th[^>]*data-sort-key="updated"[^>]*>Updated<\/th>/);
  assert.match(html, /<th[^>]*data-sort-key="approvals"/);
  assert.match(html, /<th[^>]*data-sort-key="diff"[^>]*>Diff<\/th>/);
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

test('« Your PRs » is sortable only via opts.sortMine (opts.sort alone does not touch it)', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  // opts.sort targets « others » only: without sortMine, mine stays bare.
  const html = renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } });
  assert.ok(!html.includes('data-sort-key'), 'mine: no sort without sortMine');
  // With sortMine: Opened/Updated/Diff clickable, tagged data-sort-table="mine".
  const sorted = renderFragment(data, { now: 0, sortMine: { key: 'updated', dir: 'desc' } });
  assert.match(sorted, /<th[^>]*data-sort-key="date"[^>]*data-sort-table="mine"[^>]*>Opened<\/th>/);
  assert.match(sorted, /<th[^>]*data-sort-key="updated"[^>]*data-sort-table="mine"[^>]*>Updated ▾<\/th>/);
  assert.match(sorted, /<th[^>]*data-sort-key="diff"[^>]*data-sort-table="mine"[^>]*>Diff<\/th>/);
  assert.ok(!sorted.includes('data-sort-key="author"'), 'mine: author is never sortable (always me)');
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
  for (const key of ['author', 'date', 'updated', 'approvals']) {
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

test('« Your PRs »: no colgroup without sortMine; with it, aligned on the active th', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  assert.ok(!renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } }).includes('<colgroup>'));
  for (const key of ['date', 'updated']) {
    const html = renderFragment(data, { now: 0, sortMine: { key, dir: 'desc' } });
    const col = sortedColIndex(html);
    assert.ok(col > 0, `colgroup present and marked for mine/${key}`);
    assert.equal(col, thIndex(html, key), `col.sorted aligned with th ${key}`);
  }
});

test('renderShell: col.sorted style present (discreet veil on the sorted column)', () => {
  assert.match(renderShell({}), /col\.sorted/);
});
