import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { prefsPath, loadPrefs, savePrefs, isNotifyEnabled } from '../src/prefs.js';

test('prefsPath respecte XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(prefsPath(), '/xdg/gh-notif/prefs-v1.json');
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadPrefs : fichier absent → défaut { notify: true }', () => {
  assert.deepEqual(loadPrefs('/nope/nope/prefs.json'), { notify: true });
});

test('loadPrefs : fichier corrompu → défaut { notify: true }', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  savePrefs(p, {}); // écrit un objet valide…
  rmSync(p, { force: true });
  // …puis on relit un chemin inexistant : défaut appliqué
  assert.deepEqual(loadPrefs(p), { notify: true });
  rmSync(dir, { recursive: true, force: true });
});

test('save puis load round-trip (notify: false persisté)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'prefs.json');
  savePrefs(p, { notify: false });
  assert.deepEqual(loadPrefs(p), { notify: false });
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
