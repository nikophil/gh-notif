import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, isMergeable, addBusinessDays, partyWorthy, labelColors, renderFragment, renderShell, renderLoading, renderDebug, renderDebugShell, renderFavorites } from '../src/html.js';

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

test('renderFragment: ✕ hide button on my PRs too', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  assert.match(out, /data-key="symfony\/web#120"[^>]*data-act="hide"/);
});

test('renderFragment: my hidden rows greyed with restore button in showHidden mode', () => {
  const data = { mine: [myRow()], others: [], hiddenMine: [myRow({ number: 121, title: 'snoozed' })], hiddenMineCount: 1 };
  const on = renderFragment(data, { now: NOW, showHidden: true });
  assert.match(on, /📥 Your open PRs \(1, 1 hidden\)/);
  assert.match(on, /data-key="symfony\/web#121"[^>]*data-act="show"/);
  const off = renderFragment(data, { now: NOW });
  assert.match(off, /📥 Your open PRs \(1, 1 hidden\)/); // counter always announced
  assert.ok(!off.includes('#121'), 'hidden row absent without showHidden');
});

test('renderFragment: « Your open PRs » section rendered when only hidden rows in showHidden mode', () => {
  const data = { mine: [], others: [otherRow()], hiddenMine: [myRow({ number: 121 })], hiddenMineCount: 1 };
  const on = renderFragment(data, { now: NOW, showHidden: true });
  assert.match(on, /📥 Your open PRs \(0, 1 hidden\)/);
  assert.match(on, /data-key="symfony\/web#121"[^>]*data-act="show"/);
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

test('renderFragment: a conflicting PR shows the ⚠ merge-conflict icon next to its state', () => {
  const out = renderFragment({ mine: [myRow({ conflicting: true })], others: [otherRow()] }, { now: NOW });
  assert.match(out, /title="Merge conflicts"/);
  assert.equal(out.match(/title="Merge conflicts"/g).length, 1, 'only the conflicting row carries it');
});

test('renderFragment: no merge-conflict icon without conflicting', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.ok(!out.includes('Merge conflicts'));
});

test('renderFragment: the conflict icon also appears on others\' PRs', () => {
  const out = renderFragment({ mine: [], others: [otherRow({ conflicting: true })] }, { now: NOW });
  assert.match(out, /title="Merge conflicts"/);
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

test('isMergeable: open + CI green + ≥2 approvals + no conflict', () => {
  assert.equal(isMergeable(myRow({ approvals: 2 })), true);
  assert.equal(isMergeable(myRow({ approvals: 1 })), false);
  assert.equal(isMergeable(myRow({ approvals: 2, ci: 'fail' })), false);
  assert.equal(isMergeable(myRow({ approvals: 2, ci: 'pending' })), false);
  assert.equal(isMergeable(myRow({ approvals: 2, conflicting: true })), false);
  assert.equal(isMergeable(myRow({ approvals: 2, state: 'draft' })), false);
  assert.equal(isMergeable(myRow({ approvals: 2, state: 'merged' })), false);
});

test('addBusinessDays: skips the weekend (Friday noon + 2 → Tuesday noon)', () => {
  // 2026-06-19 = Friday, 2026-06-22 = Monday.
  assert.equal(addBusinessDays(Date.parse('2026-06-19T12:00:00Z'), 2), Date.parse('2026-06-23T12:00:00Z'));
  assert.equal(addBusinessDays(Date.parse('2026-06-22T12:00:00Z'), 2), Date.parse('2026-06-24T12:00:00Z'));
});

test('partyWorthy: ≥2 business days in review, readyAt takes precedence over createdAt', () => {
  // NOW = Wednesday 2026-06-24 noon; myRow createdAt = Monday 22 noon → exactly 2 business days.
  assert.equal(partyWorthy(myRow(), NOW), true);
  // Opened Tuesday (1 business day) → too fresh.
  assert.equal(partyWorthy(myRow({ createdAt: '2026-06-23T12:00:00Z' }), NOW), false);
  // Old draft, marked ready yesterday → the ready date wins, too fresh.
  assert.equal(partyWorthy(myRow({ createdAt: '2026-06-01T12:00:00Z', readyAt: '2026-06-23T12:00:00Z' }), NOW), false);
  // No date at all → never.
  assert.equal(partyWorthy(myRow({ createdAt: null }), NOW), false);
});

test('renderFragment: no data-party on a mergeable PR in review for less than 2 business days', () => {
  const fresh = myRow({ approvals: 2, createdAt: '2026-06-23T12:00:00Z' });
  assert.ok(!renderFragment({ mine: [fresh], others: [] }, { now: NOW }).includes('data-party'));
  const readied = myRow({ approvals: 2, createdAt: '2026-06-01T12:00:00Z', readyAt: '2026-06-23T12:00:00Z' });
  assert.ok(!renderFragment({ mine: [readied], others: [] }, { now: NOW }).includes('data-party'));
});

test('renderFragment: mergeable row of MINE tagged data-party (easter egg)', () => {
  const out = renderFragment({ mine: [myRow({ approvals: 2 })], others: [] }, { now: NOW });
  assert.match(out, /<tr data-party="symfony\/web#120">/);
});

test('renderFragment: no data-party below threshold, on conflict, red CI, or others\' PRs', () => {
  assert.ok(!renderFragment({ mine: [myRow({ approvals: 1 })], others: [] }, { now: NOW }).includes('data-party'));
  assert.ok(!renderFragment({ mine: [myRow({ approvals: 2, conflicting: true })], others: [] }, { now: NOW }).includes('data-party'));
  assert.ok(!renderFragment({ mine: [myRow({ approvals: 2, ci: 'fail' })], others: [] }, { now: NOW }).includes('data-party'));
  // Others' PRs never party (mergeable is only meaningful on MY PRs).
  assert.ok(!renderFragment({ mine: [], others: [otherRow({ approvals: 2 })] }, { now: NOW }).includes('data-party'));
});

test('renderFragment: a hidden mergeable row is NOT tagged data-party', () => {
  const out = renderFragment(
    { mine: [], hiddenMine: [myRow({ approvals: 2 })], hiddenMineCount: 1 },
    { now: NOW, showHidden: true },
  );
  assert.ok(!out.includes('data-party'));
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
  assert.match(mineSection, /title="Opened \d{4}-\d{2}-\d{2} \d{2}:\d{2}"/);   // precise date in the tooltip
  assert.match(mineSection, /title="Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}"/);  // idem for the last update
  assert.ok(mineSection.includes('<span class="add">+17</span>'));
  assert.ok(mineSection.includes('<span class="del">−4</span>'));
});

test('renderFragment: « In review » column — bare duration since readyAt, fallback createdAt', () => {
  // Never draft → basis createdAt (2026-06-22, NOW 06-24 → 2d).
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  const mineSection = out.split('👥')[0];
  assert.match(mineSection, /<th>In review<\/th>/);
  assert.match(mineSection, /title="In review since 2026-06-22 \d{2}:\d{2}">2d</);
  assert.match(out.split('👥')[1], /<th>In review<\/th>/); // others table too
  // Long-drafted PR → basis readyAt, not createdAt.
  const ready = renderFragment({ mine: [myRow({ createdAt: '2026-06-01T12:00:00Z', readyAt: '2026-06-23T12:00:00Z' })], others: [] }, { now: NOW });
  assert.match(ready, /title="In review since 2026-06-23 \d{2}:\d{2}">1d</);
});

test('renderFragment: « In review » shows « – » for a draft, empty for a finished PR', () => {
  const out = renderFragment({
    mine: [myRow({ state: 'draft' })],
    others: [otherRow({ state: 'merged' })],
  }, { now: NOW });
  assert.ok(!out.includes('In review since'));
  assert.match(out.split('👥')[0], /<td>–<\/td>/);      // draft → –
  assert.doesNotMatch(out.split('👥')[1], /<td>–<\/td>/); // merged → empty
});

test('renderFragment: « others » table shows Updated too', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW });
  assert.match(out, /<th>Updated<\/th>/);
  assert.match(out, /title="Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}"/);
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

test('labelColors: Primer formulas — dark color → white text (light) / lightened pastel (dark)', () => {
  // « bug » red: perceived lightness < 0.453 → white text on the full color in
  // light mode; alpha-tinted bg + same-hue pastel text/border in dark mode.
  assert.deepEqual(labelColors('d73a4a'), {
    bgLight: '#d73a4a', fgLight: '#ffffff',
    bgDark: 'rgba(215,58,74,0.18)', fgDark: 'hsl(354,66%,78%)', bdDark: 'hsla(354,66%,78%,0.3)',
  });
  // light grey (« duplicate »): black text in light mode; already above the 0.6
  // threshold → dark mode keeps its lightness untouched.
  assert.deepEqual(labelColors('EDEDED'), {
    bgLight: '#ededed', fgLight: '#000000',
    bgDark: 'rgba(237,237,237,0.18)', fgDark: 'hsl(0,0%,93%)', bdDark: 'hsla(0,0%,93%,0.3)',
  });
});

test('labelColors: invalid/absent color → null (neutral chip fallback)', () => {
  assert.equal(labelColors(null), null);
  assert.equal(labelColors(undefined), null);
  assert.equal(labelColors('fff'), null);
  assert.equal(labelColors('xyz123'), null);
  assert.equal(labelColors('#d73a4a'), null); // the API ships WITHOUT '#'
});

test('renderFragment: Labels column — GitHub-look chips with per-label colors (both tables)', () => {
  const labels = [{ name: 'bug', color: 'd73a4a' }, { name: 'help wanted', color: '008672' }];
  const out = renderFragment({ mine: [myRow({ labels })], others: [otherRow({ labels })] }, { now: NOW });
  assert.match(out, /<th>Labels<\/th>/);
  const chips = out.match(/<span class="lbl"[^>]*>bug<\/span>/g);
  assert.equal(chips.length, 2); // one per table
  assert.match(out, /--lbl-bg-l:#d73a4a;--lbl-fg-l:#ffffff;--lbl-bg-d:rgba\(215,58,74,0\.18\)/);
  assert.match(out, /<span class="lbl"[^>]*title="help wanted">help wanted<\/span>/);
});

test('renderFragment: Labels column dropped when NO row of the table has a label (per table)', () => {
  // no label anywhere → no Labels header at all (page as before the feature)
  const none = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.doesNotMatch(none, /Labels/);
  // per-table: only others has a labeled PR → its table shows the column, mine doesn't
  const mixed = renderFragment({ mine: [myRow()], others: [otherRow({ labels: [{ name: 'bug', color: 'd73a4a' }] })] }, { now: NOW });
  assert.equal(mixed.match(/<th>Labels<\/th>/g).length, 1);
  const mineSection = mixed.slice(0, mixed.indexOf("others' PRs"));
  assert.doesNotMatch(mineSection, /Labels/);
});

test('renderFragment: no label → empty Labels cell; invalid color → chip without inline style', () => {
  const empty = renderFragment({ mine: [myRow({ labels: [] })], others: [otherRow()] }, { now: NOW });
  assert.doesNotMatch(empty, /class="labels"/); // no labels anywhere → no chip wrap at all
  const plain = renderFragment({ mine: [], others: [otherRow({ labels: [{ name: 'plain', color: null }] })] }, { now: NOW });
  assert.match(plain, /<span class="lbl" title="plain">plain<\/span>/); // neutral pill, CSS fallbacks
});

test('renderFragment: label name escaped (anti-injection)', () => {
  const labels = [{ name: '<img src=x>&"quote"', color: 'd73a4a' }];
  const out = renderFragment({ mine: [myRow({ labels })], others: [] }, { now: NOW });
  assert.doesNotMatch(out, /<img src=x>/);
  assert.match(out, /&lt;img src=x&gt;&amp;&quot;quote&quot;/);
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

test('renderFragment: hide button (✕) on « others » AND « mine » rows', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  // an action button targeting the others' PR
  assert.match(out, /class="act"[^>]*data-key="symfony\/api#55"[^>]*data-act="hide"/);
  // and one targeting mine (same mechanism since « hide your own PRs »)
  assert.match(out, /class="act"[^>]*data-key="symfony\/web#120"[^>]*data-act="hide"/);
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

test('renderFragment: CI pass → popover too (all runs reachable from the green check)', () => {
  const checks = [
    { name: 'phpstan', state: 'pass', url: 'https://github.com/symfony/web/runs/3' },
    { name: 'mago', state: 'pass', url: null },
  ];
  const out = renderFragment({ mine: [myRow({ ci: 'pass', checks })], others: [] }, { now: NOW });
  assert.match(out, /button class="ci-btn"/);
  assert.match(out, /2 successful checks/);
  assert.match(out, /href="https:\/\/github\.com\/symfony\/web\/runs\/3" target="_blank" rel="noopener">phpstan</);
});

test('renderFragment: no check detail → icon not clickable (no popover)', () => {
  const none = renderFragment({ mine: [myRow({ ci: 'none', checks: [] })], others: [] }, { now: NOW });
  assert.ok(!none.includes('ci-btn'), 'none → plain icon');
  const noChecks = renderFragment({ mine: [myRow({ ci: 'fail', checks: [] })], others: [] }, { now: NOW });
  assert.ok(!noChecks.includes('ci-btn'), 'fail without check detail → plain icon');
  const noField = renderFragment({ mine: [myRow({ ci: 'pass' })], others: [] }, { now: NOW });
  assert.ok(!noField.includes('ci-btn'), 'row without checks field (compat) → plain icon');
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

test('renderFavorites: one counter per panel (📥/👥/📋) per chip and on « all »', () => {
  const counts = {
    total: { mine: 2, others: 8, issues: 3 },
    byFav: { symfony: { mine: 1, others: 5, issues: 0 }, zenstruck: { mine: 1, others: 3, issues: 3 } },
  };
  const html = renderFavorites(['symfony', 'zenstruck'], null, { counts });
  // the triplet is parenthesized, icon and digit separated by U+2009 (thin space)
  assert.match(html, /⭐ all <span class="fav-n">\(<span title="Your open PRs">📥\u20092<\/span> <span title="Activity on others' PRs">👥\u20098<\/span> <span title="Issues">📋\u20093<\/span>\)<\/span>/);
  // issues at 0 → no 📋 badge (the Issues panel itself only renders when non-empty)
  assert.match(html, /symfony\/\* <span class="fav-n">\(<span title="Your open PRs">📥\u20091<\/span> <span title="Activity on others' PRs">👥\u20095<\/span>\)<\/span>/);
  assert.match(html, /zenstruck\/\* <span class="fav-n">\(<span title="Your open PRs">📥\u20091<\/span> <span title="Activity on others' PRs">👥\u20093<\/span> <span title="Issues">📋\u20093<\/span>\)<\/span>/);
});

test('renderFavorites: favorite absent from counters → zeros; without counts → no badge', () => {
  const html = renderFavorites(['symfony'], null, { counts: { total: { mine: 0, others: 0, issues: 0 }, byFav: {} } });
  assert.match(html, /symfony\/\* <span class="fav-n">\(<span title="Your open PRs">📥\u20090<\/span> <span title="Activity on others' PRs">👥\u20090<\/span>\)<\/span>/);
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

test('renderFragment: « my reviews ↗ » link in the « others » title when reviewedUrl is provided', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW, reviewedUrl: 'https://github.com/pulls?q=r%20%26%20s' });
  assert.match(out, /Activity on others' PRs \(1\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=r%20%26%20s"'), 'href of the reviews link');
  assert.match(out, /my reviews ↗/);
});

test('renderFragment: without reviewedUrl → no link (compat)', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW });
  assert.ok(!out.includes('my reviews ↗'));
});

test('renderFragment: others empty + reviewedUrl → section (0) with link, without table', () => {
  const out = renderFragment({ mine: [], others: [] }, { now: NOW, reviewedUrl: 'https://github.com/pulls?q=r' });
  assert.match(out, /Activity on others' PRs \(0\)/);
  assert.ok(out.includes('href="https://github.com/pulls?q=r"'));
  assert.ok(!out.includes('<table'), 'no empty table');
  assert.ok(!out.includes('Nothing to report'));
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
  assert.match(html, /<th[^>]*data-sort-key="status"/); // icon th (🚦), like approvals
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
  assert.match(sorted, /<th[^>]*data-sort-key="status"[^>]*data-sort-table="mine"/);
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
  for (const key of ['author', 'date', 'updated', 'approvals', 'status']) {
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

// ── « All » mode (watched favorites): issues section, 🆕/👀 triggers, chip button ──

const issueRow = (over = {}) => ({
  repo: 'zenstruck/foundry', number: 900, url: 'https://github.com/zenstruck/foundry/issues/900',
  title: 'Bug report', actor: 'alice', createdAt: '2026-06-23T12:00:00Z', updatedAt: '2026-06-24T10:00:00Z',
  triggers: ['new'],
  ...over,
});

test('renderFragment: issues section rendered only when there are rows', () => {
  const html = renderFragment({ mine: [], others: [], issues: [issueRow()] }, { now: NOW });
  assert.match(html, /Issues \(1\)/);
  assert.match(html, /https:\/\/github\.com\/zenstruck\/foundry\/issues\/900/);
  assert.match(html, /#900/);
  assert.match(html, /Bug report/);
  assert.match(html, /@alice/);
  assert.match(html, /🆕/);
  // without issues: nothing new (compat)
  assert.doesNotMatch(renderFragment({ mine: [], others: [] }, { now: NOW }), /Issues \(/);
  assert.doesNotMatch(renderFragment({ mine: [], others: [], issues: [] }, { now: NOW }), /Issues \(/);
});

test('renderFragment: issue actor absent → « ? », activity trigger → 👀', () => {
  const html = renderFragment({ mine: [], others: [], issues: [issueRow({ actor: null, triggers: ['activity'] })] }, { now: NOW });
  assert.match(html, /👀/);
  assert.doesNotMatch(html, /🆕/);
});

test('renderFragment: 🆕/👀 triggers shown on an « others » PR row', () => {
  const html = renderFragment({ mine: [], others: [otherRow({ triggers: ['new', 'activity'] })] }, { now: NOW });
  assert.match(html, /🆕/);
  assert.match(html, /👀/);
});

test('renderFavorites: mode button per chip (data-fav-mode raw), « all » state marked', () => {
  const html = renderFavorites(['symfony', 'zenstruck/foundry'], null, { favModes: { 'zenstruck/foundry': 'all' } });
  assert.match(html, /data-fav-mode="symfony"/);
  assert.match(html, /data-fav-mode="zenstruck\/foundry"/);
  // the « all » chip carries the .all class on its mode button, the normal one doesn't
  assert.match(html, /class="chip-mode all" data-fav-mode="zenstruck\/foundry"/);
  assert.match(html, /class="chip-mode" data-fav-mode="symfony"/);
});

test('renderFavorites: without favModes → mode buttons in normal state (compat)', () => {
  const html = renderFavorites(['symfony'], null);
  assert.match(html, /class="chip-mode" data-fav-mode="symfony"/);
  assert.doesNotMatch(html, /chip-mode all/);
});

test('renderShell: forwards favModes to the chips and wires POST /fav/mode', () => {
  const html = renderShell({ favorites: ['zenstruck/foundry'], favModes: { 'zenstruck/foundry': 'all' } });
  assert.match(html, /class="chip-mode all" data-fav-mode="zenstruck\/foundry"/);
  assert.match(html, /\/fav\/mode/);
});

test('renderFragment: a stacked child row gets a single fixed indent marker, whatever the depth', () => {
  const out = renderFragment({ mine: [myRow({ stackDepth: 1 })], others: [otherRow({ stackDepth: 2 })] }, { now: NOW });
  assert.equal((out.match(/class="stack-indent"/g) || []).length, 2);
  assert.ok(out.includes('↳'));
  assert.ok(!out.includes('padding-left'), 'no per-depth offset: one fixed indent');
});

test('renderFragment: base ≠ default branch → discreet « base: » chip in the FLAT view too, branch escaped', () => {
  const out = renderFragment({ mine: [], others: [otherRow({ base: 'feat/<x>', defaultBranch: 'main' })] }, { now: NOW });
  assert.ok(out.includes('class="stack-base"'));
  assert.ok(out.includes('base: feat/&lt;x&gt;'));
  assert.ok(!out.includes('feat/<x>'));
  // base = default branch, or unknown default (old data) → no chip
  assert.ok(!renderFragment({ mine: [], others: [otherRow({ base: 'main', defaultBranch: 'main' })] }, { now: NOW }).includes('stack-base'));
  assert.ok(!renderFragment({ mine: [], others: [otherRow({ base: 'feat/x', defaultBranch: null })] }, { now: NOW }).includes('stack-base'));
});

test('renderFragment: a stacked CHILD row gets the indent, not the chip (the order already tells its base)', () => {
  const child = otherRow({ number: 2, branch: 'c', base: 'p', defaultBranch: 'main', stackDepth: 1 });
  const grouped = renderFragment({ mine: [], others: [child] }, { now: NOW });
  assert.ok(grouped.includes('stack-indent') && !grouped.includes('stack-base'));
  const flat = renderFragment({ mine: [], others: [otherRow({ number: 2, branch: 'c', base: 'p', defaultBranch: 'main' })] }, { now: NOW });
  assert.ok(!flat.includes('stack-indent') && flat.includes('base: p'), 'same PR in the flat view → chip');
});

test('renderFragment: no stack annotation → no marker nor chip (compat)', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.ok(!out.includes('stack-indent'));
  assert.ok(!out.includes('stack-base'));
});

test('renderFragment: « ⤷ stacks » toggle shown only where a stack exists (per table)', () => {
  const parent = otherRow({ number: 1, branch: 'p', base: 'main', defaultBranch: 'main' });
  const child = otherRow({ number: 2, branch: 'c', base: 'p', defaultBranch: 'main' });
  const out = renderFragment({ mine: [myRow()], others: [parent, child] }, { now: NOW });
  assert.equal((out.match(/stacks-toggle/g) || []).length, 1); // others yes, mine no
});

test('renderFragment: no stack anywhere → no toggle (compat)', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.ok(!out.includes('stacks-toggle'));
});

test('renderFragment: opts.stacks marks the toggle active PER TABLE (data-stacks-table targets the POST)', () => {
  const parent = otherRow({ number: 1, branch: 'p', base: 'main', defaultBranch: 'main' });
  const child = otherRow({ number: 2, branch: 'c', base: 'p', defaultBranch: 'main' });
  const myParent = myRow({ number: 3, branch: 'mp', base: 'main', defaultBranch: 'main' });
  const myChild = myRow({ number: 4, branch: 'mc', base: 'mp', defaultBranch: 'main' });
  const data = { mine: [myParent, myChild], others: [parent, child] };
  const on = renderFragment(data, { now: NOW, stacks: { others: true } });
  assert.ok(on.includes('class="stacks-toggle on" data-stacks-table="others"'));
  assert.ok(on.includes('class="stacks-toggle" data-stacks-table="mine"'));
  const off = renderFragment(data, { now: NOW });
  assert.ok(off.includes('class="stacks-toggle" data-stacks-table="others"'));
  assert.ok(!off.includes('stacks-toggle on'));
});

test('renderFragment: the rows of a stack carry the .stack class (block background)', () => {
  const out = renderFragment({
    mine: [myRow({ inStack: true }), myRow({ number: 121, stackDepth: 1 }), myRow({ number: 122 })],
    others: [],
  }, { now: NOW });
  assert.equal((out.match(/<tr class="stack stack-a">/g) || []).length, 2, 'parent + child, not the solo row');
});

test('renderFragment: adjacent stacks alternate two block tints (stack-a / stack-b)', () => {
  const out = renderFragment({
    mine: [
      myRow({ inStack: true, stackIndex: 0 }), myRow({ number: 121, stackDepth: 1, inStack: true, stackIndex: 0 }),
      myRow({ number: 122, inStack: true, stackIndex: 1 }), myRow({ number: 123, stackDepth: 1, inStack: true, stackIndex: 1 }),
      myRow({ number: 124 }),
    ],
    others: [],
  }, { now: NOW });
  assert.equal((out.match(/<tr class="stack stack-a">/g) || []).length, 2);
  assert.equal((out.match(/<tr class="stack stack-b">/g) || []).length, 2);
});

test('renderFragment: single ↳ marker, root always above', () => {
  const out = renderFragment({ mine: [myRow({ stackDepth: 1 })], others: [] }, { now: NOW });
  assert.ok(out.includes('↳'));
  assert.match(out, /title="Stacked on the PR above"/);
  assert.ok(!out.includes('↱'), 'no mirrored marker anymore');
});

test('renderFragment: per-depth indent ONLY on branched blocks', () => {
  const branched = renderFragment({
    mine: [myRow({ stackDepth: 2, stackBranched: true }), myRow({ number: 121, stackDepth: 3, stackBranched: true })],
    others: [],
  }, { now: NOW });
  assert.ok(branched.includes('padding-left:14px'), 'depth 2 → one extra offset');
  assert.ok(branched.includes('padding-left:28px'), 'depth 3 → two extra offsets');
  const linear = renderFragment({ mine: [myRow({ stackDepth: 3 })], others: [] }, { now: NOW });
  assert.ok(!linear.includes('padding-left'), 'linear chain keeps the single fixed indent');
});

// ── Column selector (per-table hidden columns, opts.cols) ────────────────────

test('renderFragment: without opts.cols, no gear button and output unchanged', () => {
  const data = { mine: [myRow()], others: [otherRow()] };
  const out = renderFragment(data, { now: NOW });
  assert.doesNotMatch(out, /cols-btn/);
  assert.doesNotMatch(out, /cols-pop/);
});

test('renderFragment: opts.cols renders a gear + popover per table, all columns visible by default', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW, cols: { mine: [], others: [] } });
  const gears = out.match(/cols-btn/g) || [];
  assert.equal(gears.length, 2, 'one gear per table');
  // the gear lives in the section <h2>, not inside the table
  assert.ok(out.indexOf('cols-btn') < out.indexOf('<table'), 'gear rendered in the h2, before the table');
  assert.doesNotMatch(out, /<th[^>]*><span class="cols-wrap"/);
  // popover checkboxes carry the table + column key; Title is not offered,
  // the ✕ hide-button column is
  assert.match(out, /data-cols-table="mine" data-cols-key="branch"[^>]* checked/);
  assert.match(out, /data-cols-table="others" data-cols-key="author"[^>]* checked/);
  assert.match(out, /data-cols-table="mine" data-cols-key="act"[^>]* checked/);
  assert.doesNotMatch(out, /data-cols-key="title"/);
});

test('renderFragment: the ✕ column is hideable like the others', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW, cols: { mine: ['act'], others: [] } });
  const [mineTbl, othersTbl] = out.split('👥');
  assert.doesNotMatch(mineTbl, /data-act="hide"/, 'no hide button left in mine');
  assert.match(othersTbl, /data-act="hide"/, 'others untouched');
  assert.match(mineTbl, /cols-btn/, 'gear still reachable (it lives in the h2)');
});

test('renderFragment: a hidden column disappears from headers and cells (mine only)', () => {
  const data = { mine: [myRow()], others: [otherRow()] };
  const out = renderFragment(data, { now: NOW, cols: { mine: ['diff'], others: [] } });
  const [mineTbl, othersTbl] = out.split('👥');
  assert.doesNotMatch(mineTbl, /data-sort-key="diff"/, 'Diff header gone from mine');
  assert.doesNotMatch(mineTbl, /class="add"/, 'diff cell gone from mine');
  assert.match(othersTbl, /class="add"/, 'others untouched');
  // its checkbox is unchecked in the popover
  assert.match(mineTbl, /data-cols-table="mine" data-cols-key="diff"(?![^>]*checked)/);
  // headers and cells stay aligned (same count)
  const ths = (mineTbl.match(/<th[ >]/g) || []).length; // not <thead>
  const tds = (mineTbl.match(/<td[ >]/g) || []).length;
  assert.equal(ths, tds, 'one td per th on a 1-row table');
});

test('renderFragment: hidden author column on others', () => {
  const out = renderFragment({ mine: [], others: [otherRow()] }, { now: NOW, cols: { mine: [], others: ['author'] } });
  assert.doesNotMatch(out, /data-sort-key="author"/);
  assert.doesNotMatch(out, /@alice/);
});

test('renderFragment: with diffTypes the diff becomes a button opening a per-type popover', () => {
  const out = renderFragment({ mine: [myRow({ diffTypes: [{ ext: '.php', files: 3, additions: 15, deletions: 5 }, { ext: '.yaml', files: 1, additions: 2, deletions: 0 }] })], others: [] }, { now: NOW });
  assert.ok(out.includes('diff-btn'), 'clickable diff');
  assert.ok(out.includes('diff-pop'), 'inline hidden popover');
  assert.ok(out.includes('.php'));
  assert.ok(out.includes('.yaml'));
  // each type line carries its file count (singular/plural)
  assert.ok(out.includes('<span class="diff-n">3 files</span>'));
  assert.ok(out.includes('<span class="diff-n">1 file</span>'));
  // the displayed number stays the raw total
  assert.ok(out.includes('+17'));
  assert.ok(out.includes('−4'));
});

test('renderFragment: without diffTypes the diff cell stays plain (compat)', () => {
  const out = renderFragment({ mine: [myRow()], others: [otherRow()] }, { now: NOW });
  assert.ok(!out.includes('diff-btn'));
  assert.ok(!out.includes('diff-pop'));
});

test('renderFragment: moreFiles → « not listed » line in the diff popover', () => {
  const out = renderFragment({ mine: [myRow({ diffTypes: [{ ext: '.php', additions: 1, deletions: 0 }], moreFiles: 7 })], others: [] }, { now: NOW });
  assert.ok(/7 files not listed/.test(out));
});

test('renderFragment: diff popover escapes the extension (anti-injection)', () => {
  const out = renderFragment({ mine: [myRow({ diffTypes: [{ ext: '.<script>', additions: 1, deletions: 0 }] })], others: [] }, { now: NOW });
  assert.ok(!out.includes('.<script>'));
  assert.ok(out.includes('.&lt;script&gt;'));
});

test('renderFragment: Files column (file-diff octicon header) after Diff, in both tables', () => {
  const out = renderFragment({ mine: [myRow({ changedFiles: 4 })], others: [otherRow({ changedFiles: 9 })] },
    { now: NOW, sort: { key: 'date', dir: 'desc' }, sortMine: { key: 'date', dir: 'desc' } });
  const [mineTbl, othersTbl] = out.split('👥');
  assert.match(othersTbl, /data-sort-key="diff"[^>]*>Diff<\/th><th[^>]*data-sort-key="files"[^>]*><abbr title="Changed files"[^>]*><svg/);
  assert.match(mineTbl, /data-sort-key="files"[^>]*data-sort-table="mine"/);
  // plain count without a per-type breakdown (compat: no button, no popover)
  assert.match(mineTbl, /<td>4<\/td>/);
  assert.match(othersTbl, /<td>9<\/td>/);
  assert.ok(!out.includes('diff-btn'));
});

test('renderFragment: no changedFiles (older snapshot) → empty Files cell', () => {
  const out = renderFragment({ mine: [myRow()], others: [] }, { now: NOW });
  // …+17 −4</td><td></td><td>🟢 status cell
  assert.match(out, /−4<\/span><\/td><td><\/td><td>/);
});

test('renderFragment: the Files count opens the SAME per-type popover as the Diff figures', () => {
  const types = [{ ext: '.php', files: 3, additions: 15, deletions: 5 }];
  const out = renderFragment({ mine: [myRow({ changedFiles: 3, diffTypes: types })], others: [] }, { now: NOW });
  assert.match(out, /<button class="diff-btn" title="Files by type">3<\/button><div class="diff-pop" hidden>/);
  // one popover per button: the two cells stay independent…
  assert.equal((out.match(/class="diff-pop"/g) || []).length, 2);
  // …so hiding Diff keeps the Files popover alive (and vice versa)
  const noDiff = renderFragment({ mine: [myRow({ changedFiles: 3, diffTypes: types })], others: [] }, { now: NOW, cols: { mine: ['diff'], others: [] } });
  assert.equal((noDiff.match(/class="diff-pop"/g) || []).length, 1);
  assert.match(noDiff, /title="Files by type">3<\/button>/);
});

test('renderFragment: Files is hideable via the column selector (headers/cells stay aligned)', () => {
  const out = renderFragment({ mine: [myRow({ changedFiles: 4 })], others: [] }, { now: NOW, sortMine: { key: 'date', dir: 'desc' }, cols: { mine: ['files'], others: [] } });
  assert.doesNotMatch(out, /data-sort-key="files"/);
  assert.doesNotMatch(out, /<td>4<\/td>/);
  assert.match(out, /data-cols-table="mine" data-cols-key="files"(?![^>]*checked)/);
  const ths = (out.match(/<th[ >]/g) || []).length;
  const tds = (out.match(/<td[ >]/g) || []).length;
  assert.equal(ths, tds);
});
