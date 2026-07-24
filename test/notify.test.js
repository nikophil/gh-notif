import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY } from '../src/filter.js';
import { notifyMessage, notifyCommand, sendNotification, watchEventLine } from '../src/notify.js';

const base = { repo: 'o/r', number: 42, title: 'My PR', url: 'https://github.com/o/r/pull/42' };

test('title review requested', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null });
  assert.equal(m.title, 'New PR to review');
  assert.ok(m.body.includes('o/r #42'));
  assert.ok(m.body.includes('https://github.com/o/r/pull/42'));
});

test('title mention includes the author', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.MENTION, actor: 'alice' });
  assert.equal(m.title, "@alice mentioned you");
});

test('title activity on my PR', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.ON_MY_PR, actor: 'bob' });
  assert.equal(m.title, '@bob commented on your PR');
});

test('title reply', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.THREAD_REPLY, actor: 'carol' });
  assert.equal(m.title, "@carol replied to you");
});

test('title approval includes the author, no suffix below the threshold', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.APPROVAL, actor: 'dan', count: 1 });
  assert.equal(m.title, '@dan approved your PR');
  assert.ok(!m.title.includes('🎉'));
});

test('title approval: 🎉 ready to merge suffix from 2 approvals', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.APPROVAL, actor: 'dan', count: 2 });
  assert.equal(m.title, '@dan approved your PR 🎉 ready to merge');
});

test('sendNotification calls spawn with title and body', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  sendNotification({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null }, spawn, 'linux');
  assert.equal(calls[0].cmd, 'notify-send');
  assert.equal(calls[0].args[0], 'New PR to review');
});

test('notifyCommand: Linux → notify-send [title, body]', () => {
  const cmd = notifyCommand('linux', { title: 'T', body: 'B' });
  assert.deepEqual(cmd, { cmd: 'notify-send', args: ['T', 'B'] });
});

test('notifyCommand: macOS → osascript display notification', () => {
  const { cmd, args } = notifyCommand('darwin', { title: 'My title', body: 'o/r #42' });
  assert.equal(cmd, 'osascript');
  assert.equal(args[0], '-e');
  assert.match(args[1], /^display notification "o\/r #42" with title "My title"$/);
});

test('notifyCommand: macOS escapes quotes/backslash and flattens line breaks', () => {
  const { args } = notifyCommand('darwin', { title: 'a"b\\c', body: 'line1\nline2' });
  // quote → \" , backslash → \\ , newline → space (no raw line break)
  assert.match(args[1], /with title "a\\"b\\\\c"/);
  assert.match(args[1], /display notification "line1 line2"/);
  assert.ok(!args[1].includes('\n'), 'no raw line break in the AppleScript source');
});

test('sendNotification: macOS spawn osascript', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  sendNotification({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null }, spawn, 'darwin');
  assert.equal(calls[0].cmd, 'osascript');
  assert.match(calls[0].args[1], /with title "New PR to review"/);
});

test('sendNotification: a spawn error (missing command) does not crash', () => {
  const spawn = () => {
    const handlers = {};
    const child = { on(ev, cb) { handlers[ev] = cb; }, unref() {} };
    // simulates the async emission of ENOENT: must not throw
    queueMicrotask(() => handlers.error && handlers.error(new Error('ENOENT')));
    return child;
  };
  assert.doesNotThrow(() => sendNotification({ ...base, category: CATEGORY.MENTION, actor: 'a' }, spawn, 'linux'));
});

test('mention notif without resolved author → generic title without @null', () => {
  const m = notifyMessage({ repo: 'o/r', number: 5, title: 'PR M', url: 'https://github.com/o/r/pull/5', category: CATEGORY.MENTION, actor: null });
  assert.equal(m.title, 'You were mentioned');
  assert.ok(!m.title.includes('@null'));
});

test('watchEventLine: timestamp + reason (trigger) + repo/PR/title', () => {
  const item = { ...base, category: CATEGORY.MENTION, actor: 'alice' };
  const line = watchEventLine(item, '14:32:05');
  assert.ok(line.includes('14:32:05'), 'must include the time');
  assert.ok(line.includes(notifyMessage(item).title), 'must include the exact notif reason');
  assert.ok(line.includes('o/r #42'), 'must include repo + PR');
  assert.ok(line.includes('My PR'), 'must include the title');
});

test('watchEventLine: reason for a requested review', () => {
  const item = { ...base, category: CATEGORY.REVIEW_REQUEST, actor: null };
  const line = watchEventLine(item, '09:00:00');
  assert.ok(line.includes('New PR to review'));
  assert.ok(line.includes('o/r #42'));
});

test('watchEventLine: repo/PR/title is an OSC 8 link (and plain if hyperlinks:false)', () => {
  const item = { ...base, category: CATEGORY.MENTION, actor: 'alice' };
  const linked = watchEventLine(item, '14:32:05'); // default: links enabled
  assert.ok(linked.includes(`\x1b]8;;${base.url}\x1b\\`), 'OSC 8 sequence to the URL');
  assert.ok(linked.includes('o/r #42 My PR'), 'link text intact');
  const plain = watchEventLine(item, '14:32:05', { hyperlinks: false });
  assert.ok(!plain.includes('\x1b]8;;'), 'no OSC 8 when disabled');
  assert.ok(plain.includes('o/r #42 My PR'));
});
