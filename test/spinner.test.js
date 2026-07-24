import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSpinner } from '../src/spinner.js';

test('startSpinner: no-op outside a TTY (writes nothing)', () => {
  const stop = startSpinner('x', { isTTY: false, write: () => { throw new Error('should not write'); } });
  assert.equal(typeof stop, 'function');
  stop(); // does not throw
});

test('startSpinner: writes the label then cleans up in a TTY', () => {
  const out = [];
  const stream = { isTTY: true, write: (s) => out.push(s) };
  const stop = startSpinner('loading', stream);
  assert.ok(out.some((s) => s.includes('loading')), 'displays the label');
  stop();
  assert.ok(out.some((s) => s.includes('\x1b[?25h')), 'shows the cursor again on stop');
});
