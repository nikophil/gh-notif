import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSpinner } from '../src/spinner.js';

test('startSpinner : no-op hors TTY (n’écrit rien)', () => {
  const stop = startSpinner('x', { isTTY: false, write: () => { throw new Error('ne devrait pas écrire'); } });
  assert.equal(typeof stop, 'function');
  stop(); // ne jette pas
});

test('startSpinner : écrit le label puis nettoie en TTY', () => {
  const out = [];
  const stream = { isTTY: true, write: (s) => out.push(s) };
  const stop = startSpinner('chargement', stream);
  assert.ok(out.some((s) => s.includes('chargement')), 'affiche le label');
  stop();
  assert.ok(out.some((s) => s.includes('\x1b[?25h')), 'réaffiche le curseur à l’arrêt');
});
