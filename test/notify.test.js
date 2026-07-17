import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY } from '../src/filter.js';
import { notifyMessage, notifyCommand, sendNotification, watchEventLine } from '../src/notify.js';

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

test('titre approbation inclut l\'auteur, pas de suffixe sous le seuil', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.APPROVAL, actor: 'dan', count: 1 });
  assert.equal(m.title, '@dan a approuvé ta PR');
  assert.ok(!m.title.includes('🎉'));
});

test('titre approbation : suffixe 🎉 prête à merger dès 2 approbations', () => {
  const m = notifyMessage({ ...base, category: CATEGORY.APPROVAL, actor: 'dan', count: 2 });
  assert.equal(m.title, '@dan a approuvé ta PR 🎉 prête à merger');
});

test('sendNotification appelle spawn avec titre et corps', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  sendNotification({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null }, spawn, 'linux');
  assert.equal(calls[0].cmd, 'notify-send');
  assert.equal(calls[0].args[0], 'Nouvelle PR à review');
});

test('notifyCommand : Linux → notify-send [title, body]', () => {
  const cmd = notifyCommand('linux', { title: 'T', body: 'B' });
  assert.deepEqual(cmd, { cmd: 'notify-send', args: ['T', 'B'] });
});

test('notifyCommand : macOS → osascript display notification', () => {
  const { cmd, args } = notifyCommand('darwin', { title: 'Mon titre', body: 'o/r #42' });
  assert.equal(cmd, 'osascript');
  assert.equal(args[0], '-e');
  assert.match(args[1], /^display notification "o\/r #42" with title "Mon titre"$/);
});

test('notifyCommand : macOS échappe guillemets/backslash et aplatit les sauts de ligne', () => {
  const { args } = notifyCommand('darwin', { title: 'a"b\\c', body: 'ligne1\nligne2' });
  // guillemet → \" , backslash → \\ , newline → espace (pas de retour à la ligne brut)
  assert.match(args[1], /with title "a\\"b\\\\c"/);
  assert.match(args[1], /display notification "ligne1 ligne2"/);
  assert.ok(!args[1].includes('\n'), 'aucun saut de ligne brut dans la source AppleScript');
});

test('sendNotification : macOS spawn osascript', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  sendNotification({ ...base, category: CATEGORY.REVIEW_REQUEST, actor: null }, spawn, 'darwin');
  assert.equal(calls[0].cmd, 'osascript');
  assert.match(calls[0].args[1], /with title "Nouvelle PR à review"/);
});

test('sendNotification : une erreur de spawn (commande absente) ne crashe pas', () => {
  const spawn = () => {
    const handlers = {};
    const child = { on(ev, cb) { handlers[ev] = cb; }, unref() {} };
    // simule l'émission asynchrone d'ENOENT : ne doit pas lever
    queueMicrotask(() => handlers.error && handlers.error(new Error('ENOENT')));
    return child;
  };
  assert.doesNotThrow(() => sendNotification({ ...base, category: CATEGORY.MENTION, actor: 'a' }, spawn, 'linux'));
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
