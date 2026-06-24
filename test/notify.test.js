import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY } from '../src/filter.js';
import { notifyMessage, sendNotification, watchEventLine } from '../src/notify.js';

const base = { repo: 'o/r', number: 42, title: 'Ma PR', url: 'https://github.com/o/r/pull/42' };

test('titre review demandée', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null });
  assert.equal(m.title, 'Nouvelle PR à review');
  assert.ok(m.body.includes('o/r #42'));
  assert.ok(m.body.includes('https://github.com/o/r/pull/42'));
});

test('titre mention inclut l\'auteur', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.MENTION, actor: 'alice' });
  assert.equal(m.title, "@alice t’a mentionné");
});

test('titre activité sur ma PR', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.ON_MY_PR, actor: 'bob' });
  assert.equal(m.title, '@bob a commenté ta PR');
});

test('titre réponse', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.THREAD_REPLY, actor: 'carol' });
  assert.equal(m.title, "@carol t’a répondu");
});

test('sendNotification appelle spawn avec titre et corps', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  sendNotification({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null }, spawn);
  assert.equal(calls[0].cmd, 'notify-send');
  assert.equal(calls[0].args[0], 'Nouvelle PR à review');
});

test('notif mention sans auteur résolu → titre générique sans @null', () => {
  const m = notifyMessage({ repo: 'o/r', number: 5, title: 'PR M', url: 'https://github.com/o/r/pull/5', category: CATEGORY.MENTION, actor: null });
  assert.equal(m.title, 'Tu as été mentionné');
  assert.ok(!m.title.includes('@null'));
});

test('watchEventLine: horodatage + motif (déclencheur) + dépôt/PR/titre', () => {
  const item = { ...base, category: CATEGORY.MENTION, actor: 'alice' };
  const line = watchEventLine(item, '14:32:05');
  assert.ok(line.includes('14:32:05'), 'doit inclure l’heure');
  assert.ok(line.includes(notifyMessage(item).title), 'doit inclure le motif exact de la notif');
  assert.ok(line.includes('o/r #42'), 'doit inclure dépôt + PR');
  assert.ok(line.includes('Ma PR'), 'doit inclure le titre');
});

test('watchEventLine: motif pour une review demandée', () => {
  const item = { ...base, category: CATEGORY.REVIEW_REQUEST, actor: null };
  const line = watchEventLine(item, '09:00:00');
  assert.ok(line.includes('Nouvelle PR à review'));
  assert.ok(line.includes('o/r #42'));
});

test('watchEventLine: dépôt/PR/titre est un lien OSC 8 (et brut si hyperlinks:false)', () => {
  const item = { ...base, category: CATEGORY.MENTION, actor: 'alice' };
  const linked = watchEventLine(item, '14:32:05'); // défaut : liens activés
  assert.ok(linked.includes(`\x1b]8;;${base.url}\x1b\\`), 'séquence OSC 8 vers l’URL');
  assert.ok(linked.includes('o/r #42 Ma PR'), 'texte du lien intact');
  const plain = watchEventLine(item, '14:32:05', { hyperlinks: false });
  assert.ok(!plain.includes('\x1b]8;;'), 'pas d’OSC 8 quand désactivé');
  assert.ok(plain.includes('o/r #42 Ma PR'));
});
