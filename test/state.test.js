import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { loadState, saveState, isNew, markSeen, statePath } from '../src/state.js';

test('statePath respecte XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(statePath(), '/xdg/gh-notif/seen-v2.json');
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadState renvoie {} si fichier absent', () => {
  assert.deepEqual(loadState('/nope/nope/seen.json'), {});
});

test('save puis load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'seen.json');
  saveState(p, { t1: '2026-06-24T10:00:00Z' });
  assert.deepEqual(loadState(p), { t1: '2026-06-24T10:00:00Z' });
  rmSync(dir, { recursive: true, force: true });
});

test('isNew: URL absente → true, URL déjà vue → false', () => {
  const url = 'https://github.com/o/r/pull/1#issuecomment_5';
  assert.equal(isNew({}, { url, updatedAt: '2026-06-24T10:00:00Z' }), true);
  assert.equal(isNew({ [url]: '2026-06-24T10:00:00Z' }, { url, updatedAt: '2026-06-24T11:00:00Z' }), false);
});

test('isNew: insensible au bump d’updated_at pour la même URL', () => {
  // Une activité d'autrui bumpe updated_at mais l'URL de l'évènement est la même
  // → on ne re-notifie pas.
  const url = 'https://github.com/o/r/pull/9';
  const state = {};
  markSeen(state, { url, updatedAt: '2026-06-24T10:00:00Z' });
  assert.equal(isNew(state, { url, updatedAt: '2026-06-24T18:00:00Z' }), false);
});

test('markSeen indexe par URL', () => {
  const state = {};
  const url = 'https://github.com/o/r/pull/1#discussion_r2';
  markSeen(state, { url, updatedAt: '2026-06-24T10:00:00Z' });
  assert.equal(state[url], '2026-06-24T10:00:00Z');
});
