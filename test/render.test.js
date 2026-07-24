import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderList, renderDebugText, hyperlink, truncate, displayWidth,
  triggersLabel, ciIcon, stateIcon, relativeDate, diffStat, favoritesBar, checksByRepo,
} from '../src/render.js';

test('checksByRepo: groups by repo, distinct checks (union, order of first appearance)', () => {
  const rows = [
    { repo: 'o/a', checks: [{ name: 'ci', state: 'pass' }, { name: 'lint', state: 'fail' }] },
    { repo: 'o/a', checks: [{ name: 'ci', state: 'fail' }, { name: 'test', state: 'pass' }] }, // duplicate ci
    { repo: 'o/b', checks: [{ name: 'build', state: 'pass' }] },
    { repo: 'o/c', checks: [] }, // no check → absent
  ];
  assert.deepEqual(checksByRepo(rows), [
    { repo: 'o/a', names: ['ci', 'lint', 'test'] },
    { repo: 'o/b', names: ['build'] },
  ]);
  assert.deepEqual(checksByRepo(undefined), []);
});

// Deterministic layout: color and links disabled, fixed `now`.
const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const PLAIN = { color: false, hyperlinks: false, now: NOW };

const myRow = (over = {}) => ({ repo: 'mapado/web', number: 120, url: 'u', title: 'fix header', triggers: ['comment'], ci: 'pass', state: 'open', approvals: 0, ...over });
const otherRow = (over = {}) => ({ repo: 'mapado/api', number: 55, url: 'u', title: 'perf: cache', triggers: ['review'], ci: 'pass', author: 'alice', createdAt: '2026-06-21T12:00:00Z', additions: 412, deletions: 38, state: 'open', approvals: 2, ...over });

test('empty render', () => {
  assert.match(renderList({ mine: [], others: [] }, PLAIN), /Nothing to report/);
});

test('table « your PRs »: Status + ✅ (approvals) + Triggers + CI, no Author column', () => {
  const out = renderList({ mine: [myRow({ triggers: ['comment', 'mention'], state: 'draft', approvals: 3 })], others: [] }, PLAIN);
  assert.match(out, /Your open PRs \(1\)/);
  assert.match(out, /┌.*┐/);
  assert.match(out, /Status/);
  assert.match(out, /Triggers/);
  assert.ok(out.includes('🗨'));         // triggers: emojis only
  assert.ok(out.includes('💬'));
  assert.ok(!out.includes('comment'));   // no more text label
  assert.ok(out.includes('📝'));         // draft status
  assert.ok(out.includes('3'));          // number of approvals
  assert.ok(out.includes('✅'));         // approvals column header
  assert.doesNotMatch(out, /Author/);
});

test("table « others' PRs »: Author, Opened, Diff (no bar), Status, ✅", () => {
  const out = renderList({ mine: [], others: [otherRow({ state: 'merged', approvals: 4 })] }, PLAIN);
  assert.match(out, /Activity on others' PRs \(1\)/);
  assert.match(out, /Author/);
  assert.match(out, /Opened/);
  assert.match(out, /Diff/);
  assert.ok(out.includes('@alice'));
  assert.ok(out.includes('3d ago'));
  assert.ok(out.includes('+412'));
  assert.ok(out.includes('−38'));
  assert.ok(!out.includes('🟩') && !out.includes('🟥')); // no more color bar
  assert.ok(out.includes('🟣'));         // merged status
  assert.ok(out.includes('4'));          // number of approvals
});

test('badge 🎉 ready to merge: my open PR with ≥2 approvals', () => {
  const out = renderList({ mine: [myRow({ state: 'open', approvals: 2 })], others: [] }, PLAIN);
  assert.ok(out.includes('🎉'), 'badge present at 2 approvals on an open PR');
});

test('no 🎉 badge below the threshold, nor on draft/merged', () => {
  const under = renderList({ mine: [myRow({ state: 'open', approvals: 1 })], others: [] }, PLAIN);
  assert.ok(!under.includes('🎉'), 'no badge at 1 approval');
  const draft = renderList({ mine: [myRow({ state: 'draft', approvals: 3 })], others: [] }, PLAIN);
  assert.ok(!draft.includes('🎉'), 'no badge on a draft');
  const merged = renderList({ mine: [myRow({ state: 'merged', approvals: 3 })], others: [] }, PLAIN);
  assert.ok(!merged.includes('🎉'), 'no badge on a merged PR');
});

test('badge 🎉: table rows stay aligned', () => {
  const out = renderList({ mine: [myRow({ state: 'open', approvals: 2 }), myRow({ number: 7, approvals: 0 })], others: [] }, PLAIN);
  const lines = out.split('\n').filter((l) => /^[┌├└│]/.test(l));
  const widths = new Set(lines.map(displayWidth));
  assert.equal(widths.size, 1, `inconsistent widths (${[...widths].join(',')})`);
});

test('both tables can coexist', () => {
  const out = renderList({ mine: [myRow()], others: [otherRow()] }, PLAIN);
  assert.match(out, /Your open PRs \(1\)/);
  assert.match(out, /Activity on others' PRs \(1\)/);
});

test('alignment: each table has all its rows the same width (emojis included)', () => {
  const others = [
    otherRow({ repo: 'mapado/oauth-server', title: 'feat: add api to create a very very long thing', triggers: ['review', 'mention', 'reply', 'comment'], ci: 'fail', additions: 7, deletions: 980 }),
    otherRow({ repo: 'a/b', number: 1, title: 'x', triggers: ['review'], ci: 'pending', author: 'bob', additions: 0, deletions: 5 }),
  ];
  const mine = [myRow({ triggers: ['mention', 'reply'], ci: 'none' }), myRow({ number: 7, title: 'y', triggers: ['comment'] })];
  const out = renderList({ mine, others }, PLAIN);
  // Each table block: all box-drawing lines must have the same width.
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter((l) => /^[┌├└│]/.test(l));
    if (lines.length === 0) continue;
    const widths = new Set(lines.map(displayWidth));
    assert.equal(widths.size, 1, `inconsistent widths (${[...widths].join(',')}) in:\n${block}`);
  }
});

// ── pure helpers ───────────────────────────────────────────────────────────
test('triggersLabel: ordered, emojis only separated by a space', () => {
  assert.equal(triggersLabel(['mention', 'review']), '🔍 💬');
  assert.equal(triggersLabel(['reply']), '↩️');
  assert.equal(triggersLabel(['comment', 'reply', 'mention', 'review']), '🔍 💬 ↩️ 🗨️');
  assert.equal(triggersLabel([]), '');
});

test('ciIcon', () => {
  assert.equal(ciIcon('pass'), '✅');
  assert.equal(ciIcon('fail'), '❌');
  assert.equal(ciIcon('pending'), '🟡');
  assert.equal(ciIcon('none'), '·');
});

test('stateIcon: draft / open / merged / closed', () => {
  assert.equal(stateIcon('draft'), '📝');
  assert.equal(stateIcon('open'), '🟢');
  assert.equal(stateIcon('merged'), '🟣');
  assert.equal(stateIcon('closed'), '🔴');
  assert.equal(stateIcon('???'), '·');
});

test('relativeDate', () => {
  assert.equal(relativeDate('2026-06-21T12:00:00Z', NOW), '3d ago');
  assert.equal(relativeDate('2026-06-24T07:00:00Z', NOW), '5h ago');
  assert.equal(relativeDate('2026-06-24T11:30:00Z', NOW), '30min ago');
  assert.equal(relativeDate(null, NOW), '?');
});

test('diffStat: +additions −deletions without bar, colored render', () => {
  const d = diffStat(412, 38);
  assert.equal(d.text, '+412 −38');
  assert.ok(![...d.text].some((c) => c === '🟩' || c === '🟥'), 'no more bar');
  assert.ok(d.render({ color: true }).includes('\x1b[32m'), 'additions in green');
  assert.ok(d.render({ color: true }).includes('\x1b[31m'), 'deletions in red');
});

test('diffStat: empty diff', () => {
  const d = diffStat(0, 0);
  assert.equal(d.text, '+0 −0');
});

test('displayWidth: ASCII=1, simple emoji=2, emoji+VS16 (↩️)=2, box=1', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🔍'), 2);
  assert.equal(displayWidth('↩️'), 2);   // base U+21A9 + VS16 U+FE0F
  assert.equal(displayWidth('🗨'), 2);
  assert.equal(displayWidth('🗨️'), 2);  // U+1F5E8 + VS16 → always 2
  assert.equal(displayWidth('─┌│'), 3);   // box-drawing: 1 each
  assert.equal(displayWidth('−'), 1);     // minus sign U+2212
});

test('hyperlink: OSC 8 when enabled, raw otherwise', () => {
  assert.ok(hyperlink('https://x', 't', { hyperlinks: true }).startsWith('\x1b]8;;https://x\x1b\\'));
  assert.equal(hyperlink('https://x', 't', { hyperlinks: false }), 't');
  assert.equal(hyperlink(null, 't', { hyperlinks: true }), 't');
});

test('truncate: max width + …', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
});

test('color: ANSI absent if color:false, present if color:true', () => {
  const data = { mine: [myRow()], others: [] };
  assert.ok(!renderList(data, { color: false, hyperlinks: false, now: NOW }).includes('\x1b['));
  assert.ok(renderList(data, { color: true, hyperlinks: false, now: NOW }).includes('\x1b['));
});

// ── hiding (hidden) ────────────────────────────────────────────────────────
const tableLines = (out) => out.split('\n').filter((l) => /^[┌├└│]/.test(l));

test('renderList: selection is done by PR # (PR column), no sequential column', () => {
  const others = [otherRow({ number: 7004 }), otherRow({ number: 388, repo: 'o/x', title: 'other' })];
  const out = renderList({ others }, { color: false, hyperlinks: false, now: NOW });
  const widths = new Set(tableLines(out).map(displayWidth));
  assert.equal(widths.size, 1, `inconsistent widths (${[...widths].join(',')})`);
  assert.match(out, /#7004/); // the PR number is the identifier
  assert.match(out, /#388/);
});

test('renderList: hidden view shows 🙈 + « N hidden » counter + stays aligned', () => {
  const others = [
    otherRow(),
    otherRow({ number: 7, repo: 'o/x', title: 'other' }),
    otherRow({ number: 9, repo: 'o/h', title: 'hidden' }), // hidden (flag true)
  ];
  const out = renderList({ others, hiddenCount: 1 }, { color: false, hyperlinks: false, now: NOW, showHidden: true, hiddenFlags: [false, false, true] });
  assert.match(out, /🙈/);
  assert.match(out, /2, 1 hidden/); // 2 visible, 1 hidden
  const widths = new Set(tableLines(out).map(displayWidth));
  assert.equal(widths.size, 1, `inconsistent widths (${[...widths].join(',')})`);
});

test('renderList: without flags, render unchanged (no number column)', () => {
  const out = renderList({ others: [otherRow()] }, { color: false, hyperlinks: false, now: NOW });
  assert.match(out, /Activity on others' PRs \(1\)/);
  assert.ok(!out.includes(' # ')); // no marker column header
});

// ── renderDebugText (--debug mode) ──────────────────────────────────────────
test('renderDebugText: one line per thread, kept/dropped + reason', () => {
  const debug = [
    { repo: 'o/r', number: 42, ghReason: 'review_requested', commentsCount: 3, verdict: { kept: true, category: 'review_request', reason: 'review request (watch)' } },
    { repo: 'o/x', number: 7, ghReason: 'author', commentsCount: 0, verdict: { kept: false, category: null, reason: 'your own action / PR update' } },
  ];
  const out = renderDebugText(debug, { color: false });
  assert.match(out, /1\/2 kept/);
  assert.match(out, /o\/r#42/);
  assert.match(out, /✓ review_request/);
  assert.match(out, /o\/x#7/);
  assert.match(out, /✗ dropped/);
  assert.match(out, /your own action/);
  assert.match(out, /GH:author/);
});

test('renderDebugText: empty → neutral message', () => {
  assert.match(renderDebugText([], { color: false }), /no notification thread/);
});

test('renderDebugText: « Checks by repo » section — distinct jobs per repo, ignored ones marked', () => {
  const rows = [
    { repo: 'mapado/ticketing', number: 60, ci: 'pass', checks: [
      { name: 'continuous-integration/jenkins/branch', state: 'pass' },
      { name: 'behat', state: 'fail' },
    ] },
    { repo: 'mapado/ticketing', number: 61, ci: 'fail', checks: [
      { name: 'behat', state: 'fail' }, // duplicate → distinct
    ] },
  ];
  const out = renderDebugText([], { color: false, rows, ignoredChecks: { 'mapado/ticketing': ['behat'] } });
  assert.match(out, /Checks by repo/);
  assert.match(out, /mapado\/ticketing/);
  assert.match(out, /continuous-integration\/jenkins\/branch/);
  // behat appears ONLY once despite 2 PRs, and marked ignored
  assert.equal((out.match(/behat/g) || []).length, 1);
  assert.match(out, /behat.*ignored/);
});

test('renderDebugText: no checks section without rows (compat)', () => {
  const out = renderDebugText([], { color: false });
  assert.ok(!out.includes('Checks by repo'));
});

// ── Favorites bar (terminal) ─────────────────────────────────────────────
test('favoritesBar: active in brackets, « ⭐ all » when no active favorite', () => {
  // An org shows `org/*` (all its repos), a repo stays `owner/name`.
  const list = ['mapado', 'noctud/collection', 'zenstruck'];
  assert.equal(favoritesBar(list, null, PLAIN), '[⭐ all] · mapado/* · noctud/collection · zenstruck/*');
  assert.equal(favoritesBar(list, 'mapado', PLAIN), '⭐ all · [mapado/*] · noctud/collection · zenstruck/*');
  assert.equal(favoritesBar(list, 'zenstruck', PLAIN), '⭐ all · mapado/* · noctud/collection · [zenstruck/*]');
});

test('favoritesBar: empty list → nothing (invisible for those who don\'t use favorites)', () => {
  assert.equal(favoritesBar([], null, PLAIN), '');
  assert.equal(favoritesBar(undefined, null, PLAIN), '');
});

test('favoritesBar: an unknown active marks none', () => {
  assert.equal(favoritesBar(['a', 'b'], 'gone', PLAIN), '⭐ all · a/* · b/*');
});
