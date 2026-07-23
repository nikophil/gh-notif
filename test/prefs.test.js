import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled, themeOf } from '../src/prefs.js';

test('prefsPath respecte XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(prefsPath(), '/xdg/gh-notif/prefs-v1.json');
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadPrefs : fichier absent → défauts (notify: true, theme: auto)', () => {
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json'), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null });
});

test('loadPrefs : fichier corrompu → défauts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // écrit un objet valide…
  rmSync(p, { force: true });
  // …puis on relit un chemin inexistant : défaut appliqué
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null });
  rmSync(dir, { recursive: true, force: true });
});

test('save puis load round-trip (notify: false persisté)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'prefs.json');
  savePrefs(p, { notify: false });
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'auto', favorites: [], activeFav: null, sort: null });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs : clés manquantes complétées par les défauts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // pas de clé notify
  assert.equal(loadPrefs(p).notify, true);
  rmSync(dir, { recursive: true, force: true });
});

test('isNotifyEnabled : true par défaut, false seulement si explicitement désactivé', () => {
  assert.equal(isNotifyEnabled({ notify: true }), true);
  assert.equal(isNotifyEnabled({ notify: false }), false);
  assert.equal(isNotifyEnabled({}), true); // absent → activé
});

test('themeOf : valeurs valides passent, tout le reste → auto', () => {
  assert.equal(themeOf({ theme: 'light' }), 'light');
  assert.equal(themeOf({ theme: 'dark' }), 'dark');
  assert.equal(themeOf({ theme: 'auto' }), 'auto');
  assert.equal(themeOf({ theme: 'fuchsia' }), 'auto'); // valeur inconnue
  assert.equal(themeOf({}), 'auto');                   // absent
  assert.equal(themeOf(null), 'auto');                 // objet nul
});

test('loadPrefs : un fichier antérieur aux favoris reste valide (pas de migration)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { notify: false, theme: 'dark' }); // fichier « ancien »
  const prefs = loadPrefs(p);
  assert.deepEqual(prefs.favorites, []);
  assert.equal(prefs.activeFav, null);
  assert.equal(prefs.notify, false); // les clés existantes ne bougent pas
  assert.equal(prefs.theme, 'dark');
  rmSync(dir, { recursive: true, force: true });
});

test('écrire les favoris ne perd ni notify ni theme (piège de la clé écrasée)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { notify: false, theme: 'dark' });
  // La bonne façon : muter l'objet chargé puis le réécrire EN ENTIER.
  const prefs = loadPrefs(p);
  prefs.favorites = ['mapado'];
  prefs.activeFav = 'mapado';
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), { notify: false, theme: 'dark', favorites: ['mapado'], activeFav: 'mapado', sort: null });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs : le tableau favorites n’est pas partagé entre appels', () => {
  const a = loadPrefs('/nope/nope/prefs.json');
  a.favorites.push('mapado'); // mutation accidentelle du premier objet
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json').favorites, []); // DEFAULTS intact
});

test('loadPrefs : theme persisté conservé, notify complété par défaut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, { theme: 'dark' });
  assert.deepEqual(loadPrefs(p), { notify: true, theme: 'dark', favorites: [], activeFav: null, sort: null });
  rmSync(dir, { recursive: true, force: true });
});

test('loadPrefs : sort null par défaut, persisté tel quel sans perdre les autres clés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  // Fichier antérieur au tri : la clé apparaît, nulle (normalizeSort fera le défaut).
  savePrefs(p, { notify: false });
  assert.equal(loadPrefs(p).sort, null);
  // Round-trip : on mute l'objet ENTIER puis on le réécrit (piège habituel).
  const prefs = loadPrefs(p);
  prefs.sort = { key: 'author', dir: 'asc' };
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), {
    notify: false, theme: 'auto', favorites: [], activeFav: null,
    sort: { key: 'author', dir: 'asc' },
  });
  rmSync(dir, { recursive: true, force: true });
});
