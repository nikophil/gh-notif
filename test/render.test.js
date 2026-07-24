import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ciIcon, stateIcon, relativeDate, checksByRepo, favoritesBar,
} from '../src/render.js';

// Deterministic layout: color disabled.
const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const PLAIN = { color: false };

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

// ── Favorites bar (terminal, `gh notif fav list`) ─────────────────────────
test('favoritesBar: active in brackets, « ⭐ all » when no active favorite', () => {
  // An org shows `org/*` (all its repos), a repo stays `owner/name`.
  const list = ['symfony', 'noctud/collection', 'zenstruck'];
  assert.equal(favoritesBar(list, null, PLAIN), '[⭐ all] · symfony/* · noctud/collection · zenstruck/*');
  assert.equal(favoritesBar(list, 'symfony', PLAIN), '⭐ all · [symfony/*] · noctud/collection · zenstruck/*');
  assert.equal(favoritesBar(list, 'zenstruck', PLAIN), '⭐ all · symfony/* · noctud/collection · [zenstruck/*]');
});

test('favoritesBar: empty list → nothing (invisible for those who don\'t use favorites)', () => {
  assert.equal(favoritesBar([], null, PLAIN), '');
  assert.equal(favoritesBar(undefined, null, PLAIN), '');
});

test('favoritesBar: an unknown active marks none', () => {
  assert.equal(favoritesBar(['a', 'b'], 'gone', PLAIN), '⭐ all · a/* · b/*');
});
