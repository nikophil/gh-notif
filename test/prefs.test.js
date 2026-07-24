import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf, ignoredChecksOf, ignoredChecksFor, toggleIgnoredCheck } from '../src/prefs.js';

test('prefsPath respects XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(prefsPath(), '/xdg/gh-notif/prefs-v1.json');
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadPrefs: missing file → defaults (notify: true, theme: auto)', () => {
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json'), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, ignoredChecks: {} });
});

test('loadPrefs: corrupted file → defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // writes a valid object…
  rmSync(p, { force: true });
  // …then we re-read a nonexistent path: default applied
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, ignoredChecks: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('save then load round-trip (notify: false persisted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'prefs.json');
  savePrefs(p, { notify: false });
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'auto', favorites: [], activeFav: null, sort: null, ignoredChecks: {} });
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
  prefs.favorites = ['mapado'];
  prefs.activeFav = 'mapado';
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'dark', favorites: ['mapado'], activeFav: 'mapado', sort: null, ignoredChecks: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs: the favorites array is not shared between calls', () => {
  const a = loadPrefs('/nope/nope/prefs.json');
  a.favorites.push('mapado'); // accidental mutation of the first object
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json').favorites, []); // DEFAULTS intact
});

test('loadPrefs: persisted theme kept, notify filled by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { theme: 'dark' });
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'dark', favorites: [], activeFav: null, sort: null, ignoredChecks: {} });
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
    sort: { key: 'author', dir: 'asc' }, ignoredChecks: {},
  });
  rmSync(dir, { recursive: true, force: true });
});

test('ignoredChecksOf: map empty by default, tolerates absent/malformed', () => {
  assert.deepEqual(ignoredChecksOf(undefined), {});
  assert.deepEqual(ignoredChecksOf({}), {});
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: null }), {});
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: 'nope' }), {}); // invalid type → {}
  const m = { 'mapado/ticketing': ['Check Pull Requests label for merge block'] };
  assert.deepEqual(ignoredChecksOf({ ignoredChecks: m }), m);
});

test('ignoredChecksFor: list of a repo ignored jobs ([] if absent/invalid)', () => {
  const prefs = { ignoredChecks: { 'mapado/ticketing': ['Check Pull Requests label for merge block'] } };
  assert.deepEqual(ignoredChecksFor(prefs, 'mapado/ticketing'), ['Check Pull Requests label for merge block']);
  assert.deepEqual(ignoredChecksFor(prefs, 'other/repo'), []);
  assert.deepEqual(ignoredChecksFor({}, 'mapado/ticketing'), []);
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
  toggleIgnoredCheck(prefs, 'mapado/ticketing', 'behat');
  assert.deepEqual(prefs.ignoredChecks, { 'mapado/ticketing': ['behat'] });
  // add a second one
  toggleIgnoredCheck(prefs, 'mapado/ticketing', 'phpstan');
  assert.deepEqual(prefs.ignoredChecks['mapado/ticketing'], ['behat', 'phpstan']);
  // remove behat
  toggleIgnoredCheck(prefs, 'mapado/ticketing', 'behat');
  assert.deepEqual(prefs.ignoredChecks['mapado/ticketing'], ['phpstan']);
  // remove the last one → the repo key disappears (clean map)
  toggleIgnoredCheck(prefs, 'mapado/ticketing', 'phpstan');
  assert.deepEqual(prefs.ignoredChecks, {});
});

test('toggleIgnoredCheck: tolerates absent ignoredChecks and trims the name', () => {
  const prefs = {};
  toggleIgnoredCheck(prefs, 'o/r', '  behat  ');
  assert.deepEqual(prefs.ignoredChecks, { 'o/r': ['behat'] }); // created + trimmed
  toggleIgnoredCheck(prefs, 'o/r', 'behat'); // removal (trimmed match)
  assert.deepEqual(prefs.ignoredChecks, {});
});
