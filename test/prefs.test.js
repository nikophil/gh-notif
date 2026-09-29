import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf, ignoredChecksOf, ignoredChecksFor, toggleIgnoredCheck, favModesOf, toggleFavMode, stacksOf, setStacks, stacksSeenOf, hiddenColsOf, toggleHiddenCol, statsIgnoredOf, toggleStatsIgnored } from '../src/prefs.js';

test('prefsPath respects XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(prefsPath(), join('/xdg', 'gh-notif', 'prefs-v1.json'));
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadPrefs: missing file → defaults (notify: true, theme: auto)', () => {
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json'), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, sortMine: null, ignoredChecks: {}, favModes: {} });
});

test('loadPrefs: corrupted file → defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // writes a valid object…
  rmSync(p, { force: true });
  // …then we re-read a nonexistent path: default applied
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, sortMine: null, ignoredChecks: {}, favModes: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('save then load round-trip (notify: false persisted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'prefs.json');
  savePrefs(p, { notify: false });
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'auto', favorites: [], activeFav: null, sort: null, sortMine: null, ignoredChecks: {}, favModes: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs: missing keys filled in by defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // no notify key
  assert.equal(loadPrefs(p).notify, true);
  rmSync(dir, { recursive: true, force: true });
});

test('isNotifyEnabled: true by default, false only if explicitly disabled', () => {
  assert.equal(isNotifyEnabled({ notify: true }), true);
  assert.equal(isNotifyEnabled({ notify: false }), false);
  assert.equal(isNotifyEnabled({}), true); // absent → enabled
});

test('themeOf: valid values pass, everything else → auto', () => {
  assert.equal(themeOf({ theme: 'light' }), 'light');
  assert.equal(themeOf({ theme: 'dark' }), 'dark');
  assert.equal(themeOf({ theme: 'auto' }), 'auto');
  assert.equal(themeOf({ theme: 'fuchsia' }), 'auto'); // unknown value
  assert.equal(themeOf({}), 'auto');                   // absent
  assert.equal(themeOf(null), 'auto');                 // null object
});

test('loadPrefs: a file predating favorites stays valid (no migration)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { notify: false, theme: 'dark' }); // « old » file
  const prefs = loadPrefs(p);
  assert.deepEqual(prefs.favorites, []);
  assert.equal(prefs.activeFav, null);
  assert.equal(prefs.notify, false); // existing keys don't move
  assert.equal(prefs.theme, 'dark');
  rmSync(dir, { recursive: true, force: true });
});

test('writing favorites loses neither notify nor theme (overwritten-key pitfall)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { notify: false, theme: 'dark' });
  // The right way: mutate the loaded object then re-write it IN FULL.
  const prefs = loadPrefs(p);
  prefs.favorites = ['stark'];
  prefs.activeFav = 'stark';
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'dark', favorites: ['stark'], activeFav: 'stark', sort: null, sortMine: null, ignoredChecks: {}, favModes: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs: the favorites array is not shared between calls', () => {
  const a = loadPrefs('/nope/nope/prefs.json');
  a.favorites.push('stark'); // accidental mutation of the first object
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json').favorites, []); // DEFAULTS intact
});

test('loadPrefs: persisted theme kept, notify filled by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { theme: 'dark' });
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'dark', favorites: [], activeFav: null, sort: null, sortMine: null, ignoredChecks: {}, favModes: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs: sort null by default, persisted as-is without losing the other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  // File predating sort: the key appears, null (normalizeSort will apply the default).
  savePrefs(p, { notify: false });
  assert.equal(loadPrefs(p).sort, null);
  // Round-trip: we mutate the WHOLE object then re-write it (usual pitfall).
  const prefs = loadPrefs(p);
  prefs.sort = { key: 'author', dir: 'asc' };
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), {
    notify: false, theme: 'auto', favorites: [], activeFav: null,
    sort: { key: 'author', dir: 'asc' }, sortMine: null, ignoredChecks: {}, favModes: {},
  });
  rmSync(dir, { recursive: true, force: true });
});

test('ignoredChecksOf: map empty by default, tolerates absent/malformed', () => {
  assert.deepEqual(ignoredChecksOf(undefined), {});
  assert.deepEqual(ignoredChecksOf({}), {});
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: null }), {});
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: 'nope' }), {}); // invalid type → {}
  const m = { 'stark/tracker': ['Check Pull Requests label for merge block'] };
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: m }), m);
});

test('ignoredChecksFor: list of a repo ignored jobs ([] if absent/invalid)', () => {
  const prefs = { ignoredChecks: { 'stark/tracker': ['Check Pull Requests label for merge block'] } };
  assert.deepEqual(ignoredChecksFor(prefs, 'stark/tracker'), ['Check Pull Requests label for merge block']);
  assert.deepEqual(ignoredChecksFor(prefs, 'other/repo'), []);
  assert.deepEqual(ignoredChecksFor({}, 'stark/tracker'), []);
  assert.deepEqual(ignoredChecksFor({ ignoredChecks: { 'o/r': 'oops' } }, 'o/r'), []); // non-array value → []
});

test('ignoredChecks: round-trip and fresh instance (no shared reference)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { ...loadPrefs(p), ignoredChecks: { 'o/r': ['flaky'] } });
  assert.deepEqual(loadPrefs(p).ignoredChecks, { 'o/r': ['flaky'] });
  // two loadPrefs of a missing file don't share the same map
  const a = loadPrefs('/nope/x');
  a.ignoredChecks['o/r'] = ['pollution'];
  assert.deepEqual(loadPrefs('/nope/x').ignoredChecks, {});
  rmSync(dir, { recursive: true, force: true });
});

test('toggleIgnoredCheck: adds, removes, creates the repo, deletes the key if empty', () => {
  const prefs = { ignoredChecks: {} };
  // add (creates the repo)
  toggleIgnoredCheck(prefs, 'stark/tracker', 'behat');
  assert.deepEqual(prefs.ignoredChecks, { 'stark/tracker': ['behat'] });
  // add a second one
  toggleIgnoredCheck(prefs, 'stark/tracker', 'phpstan');
  assert.deepEqual(prefs.ignoredChecks['stark/tracker'], ['behat', 'phpstan']);
  // remove behat
  toggleIgnoredCheck(prefs, 'stark/tracker', 'behat');
  assert.deepEqual(prefs.ignoredChecks['stark/tracker'], ['phpstan']);
  // remove the last one → the repo key disappears (clean map)
  toggleIgnoredCheck(prefs, 'stark/tracker', 'phpstan');
  assert.deepEqual(prefs.ignoredChecks, {});
});

test('favModesOf: empty map by default, tolerates absent/malformed', () => {
  assert.deepEqual(favModesOf(undefined), {});
  assert.deepEqual(favModesOf({}), {});
  assert.deepEqual(favModesOf({ favModes: null }), {});
  assert.deepEqual(favModesOf({ favModes: 'nope' }), {}); // invalid type → {}
  assert.deepEqual(favModesOf({ favModes: ['all'] }), {}); // array → {}
  const m = { 'zorg/forge': 'all' };
  assert.deepEqual(favModesOf({ favModes: m }), m);
});

test('toggleFavMode: enables « all » mode, disabling deletes the key (clean map)', () => {
  const prefs = { favModes: {} };
  toggleFavMode(prefs, 'zorg/forge');
  assert.deepEqual(prefs.favModes, { 'zorg/forge': 'all' });
  toggleFavMode(prefs, 'stark');
  assert.deepEqual(prefs.favModes, { 'zorg/forge': 'all', stark: 'all' });
  toggleFavMode(prefs, 'zorg/forge'); // back to normal → key removed
  assert.deepEqual(prefs.favModes, { stark: 'all' });
});

test('toggleFavMode: tolerates absent/malformed favModes', () => {
  const prefs = {};
  toggleFavMode(prefs, 'stark');
  assert.deepEqual(prefs.favModes, { stark: 'all' }); // created
  const broken = { favModes: 'oops' };
  toggleFavMode(broken, 'stark');
  assert.deepEqual(broken.favModes, { stark: 'all' }); // replaced by a real map
});

test('favModes: round-trip without losing the other keys, fresh instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { notify: false, theme: 'dark' });
  const prefs = loadPrefs(p);
  toggleFavMode(prefs, 'zorg/forge');
  savePrefs(p, prefs); // mutate + rewrite IN FULL (usual pitfall)
  const back = loadPrefs(p);
  assert.deepEqual(back.favModes, { 'zorg/forge': 'all' });
  assert.equal(back.notify, false);
  assert.equal(back.theme, 'dark');
  // two loadPrefs of a missing file don't share the same map
  const a = loadPrefs('/nope/x');
  a.favModes.stark = 'all';
  assert.deepEqual(loadPrefs('/nope/x').favModes, {});
  rmSync(dir, { recursive: true, force: true });
});

test('toggleIgnoredCheck: tolerates absent ignoredChecks and trims the name', () => {
  const prefs = {};
  toggleIgnoredCheck(prefs, 'o/r', '  behat  ');
  assert.deepEqual(prefs.ignoredChecks, { 'o/r': ['behat'] }); // created + trimmed
  toggleIgnoredCheck(prefs, 'o/r', 'behat'); // removal (trimmed match)
  assert.deepEqual(prefs.ignoredChecks, {});
});

test('stacksOf: one flag per table (stacks / stacksMine), false unless explicitly enabled', () => {
  assert.deepEqual(stacksOf({}), { mine: false, others: false });
  assert.deepEqual(stacksOf({ stacks: true }), { mine: false, others: true });
  assert.deepEqual(stacksOf({ stacksMine: true }), { mine: true, others: false });
  assert.deepEqual(stacksOf({ stacks: 'yes', stacksMine: 1 }), { mine: false, others: false }); // tampered file → default
});

test('stacksSeenOf: [] by default, non-array or non-string entries dropped (tampered file)', () => {
  assert.deepEqual(stacksSeenOf({}), []);
  assert.deepEqual(stacksSeenOf({ stacksSeen: ['o/r#2', 3, null] }), ['o/r#2']);
  assert.deepEqual(stacksSeenOf({ stacksSeen: 'o/r#2' }), []);
});

test('setStacks: touches one table only, the key is DELETED when off (clean file)', () => {
  const prefs = { notify: false };
  setStacks(prefs, 'mine', true);
  assert.deepEqual(prefs, { notify: false, stacksMine: true });
  setStacks(prefs, 'others', true);
  assert.deepEqual(prefs, { notify: false, stacksMine: true, stacks: true });
  setStacks(prefs, 'mine', false);
  assert.deepEqual(prefs, { notify: false, stacks: true });
});

test('hiddenColsOf: empty lists by default, tolerates absent/malformed', () => {
  assert.deepEqual(hiddenColsOf(undefined), { mine: [], others: [] });
  assert.deepEqual(hiddenColsOf({}), { mine: [], others: [] });
  assert.deepEqual(hiddenColsOf({ cols: 'nope', colsMine: 42 }), { mine: [], others: [] }); // invalid types → []
  // non-string entries dropped; valid ones kept as-is
  assert.deepEqual(hiddenColsOf({ cols: ['branch', 7], colsMine: ['diff'] }), { mine: ['diff'], others: ['branch'] });
});

test('toggleHiddenCol: adds, removes, deletes the pref key when empty', () => {
  const prefs = {};
  toggleHiddenCol(prefs, 'mine', 'branch');
  assert.deepEqual(prefs.colsMine, ['branch']);
  toggleHiddenCol(prefs, 'mine', 'diff');
  assert.deepEqual(prefs.colsMine, ['branch', 'diff']);
  // the two tables have independent states
  toggleHiddenCol(prefs, 'others', 'author');
  assert.deepEqual(prefs.cols, ['author']);
  assert.deepEqual(prefs.colsMine, ['branch', 'diff']);
  // removal; last one → the key disappears (clean file, like toggleIgnoredCheck)
  toggleHiddenCol(prefs, 'mine', 'branch');
  assert.deepEqual(prefs.colsMine, ['diff']);
  toggleHiddenCol(prefs, 'mine', 'diff');
  assert.equal('colsMine' in prefs, false);
  // tolerates a tampered value (non-array → restarts from empty)
  const bad = { cols: 'oops' };
  toggleHiddenCol(bad, 'others', 'ci');
  assert.deepEqual(bad.cols, ['ci']);
});

test('statsIgnoredOf / toggleStatsIgnored: trimmed, @ dropped, de-duplicated, key deleted when empty', () => {
  assert.deepEqual(statsIgnoredOf({ statsIgnored: [' ai ', '@bot', 'ai', 3, ''] }), ['ai', 'bot']);
  assert.deepEqual(statsIgnoredOf({}), []);
  const prefs = {};
  assert.deepEqual(toggleStatsIgnored(prefs, '@ai'), ['ai']);
  assert.deepEqual(prefs.statsIgnored, ['ai']);
  assert.deepEqual(toggleStatsIgnored(prefs, 'ai'), []);
  assert.ok(!('statsIgnored' in prefs));
});
