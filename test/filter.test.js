import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplyToMe, latestOtherComment, classify, classifyVerdict, prHtmlUrl, CATEGORY } from '../src/filter.js';

const ME = 'nikophil';

test('réponse sous mon commentaire → renvoie la réponse', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  const r = findReplyToMe(comments, ME);
  assert.equal(r?.id, 2);
});

test('commentaire dans un fil où je ne participe pas → null', () => {
  const comments = [
    { id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('seulement ma propre réponse → null', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('plusieurs réponses → renvoie la plus récente', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T12:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME)?.id, 3);
});

test('réponse postée APRÈS la mienne dans un fil que je n\'ai pas créé (replies plats GitHub) → KEEP', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T12:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME)?.id, 3);
});

test('commentaire d\'un autre ANTÉRIEUR à ma participation → ignoré', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:30:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('findReplyToMe : réponse antérieure à `since` (déjà lue) → ignorée', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-20T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-20T11:00:00Z', html_url: 'u2' },
  ];
  // lue le 24/06 → la réponse du 20/06 n'est plus une nouveauté
  assert.equal(findReplyToMe(comments, ME, '2026-06-24T00:00:00Z'), null);
  // since avant la réponse → bien renvoyée
  assert.equal(findReplyToMe(comments, ME, '2026-06-20T10:30:00Z')?.id, 2);
  // sans since (défaut) → comportement inchangé
  assert.equal(findReplyToMe(comments, ME)?.id, 2);
});

// ajouter
const prThread = (over = {}) => ({
  id: 't1',
  reason: 'review_requested',
  updated_at: '2026-06-24T12:00:00Z',
  subject: { title: 'Ma PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
  repository: { full_name: 'o/r' },
  ...over,
});

test('prHtmlUrl construit l\'URL web', () => {
  assert.equal(prHtmlUrl(prThread()), 'https://github.com/o/r/pull/42');
});

test('non-PullRequest → null', () => {
  const t = prThread({ subject: { ...prThread().subject, type: 'Issue' } });
  assert.equal(classify(t, ME, null), null);
});

test('reason hors liste blanche (ci_activity) → null', () => {
  assert.equal(classify(prThread({ reason: 'ci_activity' }), ME, null), null);
});

test('review_requested → REVIEW_REQUEST avec URL PR', () => {
  const item = classify(prThread({ reason: 'review_requested' }), ME, null);
  assert.equal(item.category, CATEGORY.REVIEW_REQUEST);
  assert.equal(item.url, 'https://github.com/o/r/pull/42');
  assert.equal(item.repo, 'o/r');
  assert.equal(item.number, 42);
  assert.equal(item.title, 'Ma PR');
  assert.equal(item.threadId, 't1');
  assert.equal(item.updatedAt, '2026-06-24T12:00:00Z');
});

test('reason=review_requested collante mais réponse dans mon fil → THREAD_REPLY (prime sur review)', () => {
  // J'ai été ajouté comme reviewer (reason reste « review_requested »), mais
  // l'évènement réel est une réponse d'alice dans un fil où j'ai participé.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r2' },
  ] };
  const item = classify(prThread({ reason: 'review_requested' }), ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.actor, 'alice');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r2');
});

test('mention → MENTION avec auteur + URL du commentaire', () => {
  const insp = { latestComment: { user: { login: 'alice' }, html_url: 'https://github.com/o/r/pull/42#discussion_r9' }, reviewComments: [] };
  const item = classify(prThread({ reason: 'mention' }), ME, insp);
  assert.equal(item.category, CATEGORY.MENTION);
  assert.equal(item.actor, 'alice');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r9');
});

test('author avec commentaire d\'un autre → ON_MY_PR', () => {
  const insp = { latestComment: { user: { login: 'bob' }, html_url: 'https://github.com/o/r/pull/42#issuecomment_5' }, reviewComments: [] };
  const item = classify(prThread({ reason: 'author' }), ME, insp);
  assert.equal(item.category, CATEGORY.ON_MY_PR);
  assert.equal(item.actor, 'bob');
});

test('author SANS nouveau commentaire (push/CI/merge) → null', () => {
  const insp = { latestComment: null, reviewComments: [] };
  assert.equal(classify(prThread({ reason: 'author' }), ME, insp), null);
});

test('latestOtherComment : dernier commentaire d\'un autre, filtré par since', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-25T10:00:00Z', html_url: 'a' },
    { id: 2, user: { login: ME }, created_at: '2026-06-25T11:00:00Z', html_url: 'mine' },
    { id: 3, user: { login: 'bob' }, created_at: '2026-06-25T12:00:00Z', html_url: 'b' },
  ];
  assert.equal(latestOtherComment(comments, ME)?.id, 3);                          // le plus récent d'un autre
  assert.equal(latestOtherComment(comments, ME, '2026-06-25T11:30:00Z')?.id, 3);  // après since
  assert.equal(latestOtherComment(comments, ME, '2026-06-25T23:00:00Z'), null);   // tous déjà lus
});

test('author : commentaire de review (inline) d\'un autre sur ma PR → ON_MY_PR (#7015)', () => {
  // Cas réel #7015 : pas de latest_comment_url, mais un review-comment racine de
  // lnahiro. La branche author doit le détecter via les review-comments.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-25T12:06:59Z', html_url: 'https://github.com/o/r/pull/7015#discussion_r9' },
  ] };
  const item = classify(prThread({ reason: 'author' }), ME, insp);
  assert.equal(item.category, CATEGORY.ON_MY_PR);
  assert.equal(item.actor, 'lnahiro');
  assert.equal(item.url, 'https://github.com/o/r/pull/7015#discussion_r9');
});

test('author : review-comment déjà lu (< last_read_at) → null', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-25T12:06:00Z', html_url: 'x' },
  ] };
  const t = prThread({ reason: 'author', last_read_at: '2026-06-25T12:09:00Z' });
  assert.equal(classify(t, ME, insp), null);
});

test('author mais dernier acteur = moi → null', () => {
  const insp = { latestComment: { user: { login: ME }, html_url: 'x' }, reviewComments: [] };
  assert.equal(classify(prThread({ reason: 'author' }), ME, insp), null);
});

test('comment avec réponse à mon fil → THREAD_REPLY', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'carol' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r2' },
  ] };
  const item = classify(prThread({ reason: 'comment' }), ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.actor, 'carol');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r2');
});

test('reason=mention collante mais vraie réponse dans mon fil → THREAD_REPLY (prime sur mention)', () => {
  // Cas réel : j'ai été mentionné sur la PR (reason reste « mention »), mais
  // l'évènement réel est une réponse de lnahiro dans un fil où j'ai participé.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-24T13:00:00Z', html_url: 'root' },
    { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T13:05:00Z', html_url: 'mine' },
    { id: 3, in_reply_to_id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-24T13:07:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r3' },
  ] };
  const item = classify(prThread({ reason: 'mention' }), ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.actor, 'lnahiro');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r3');
});

test('régression #6993 : notif rebumpée, vieille réponse déjà lue (< last_read_at) → pas THREAD_REPLY', () => {
  // Une activité tierce (échange entre deux autres en commentaires principaux)
  // rebumpe une notif review_requested. La seule « réponse à moi » est ancienne
  // (20/06) et déjà lue (last_read_at = 24/06) → ne doit pas re-déclencher.
  const insp = { latestComment: { user: { login: 'lnahiro' }, html_url: 'x' }, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-19T13:50:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'Nickinthebox' }, created_at: '2026-06-20T06:57:00Z', html_url: 'old-reply' },
  ] };
  const t = prThread({ reason: 'review_requested', last_read_at: '2026-06-24T14:44:49Z' });
  const item = classify(t, ME, insp);
  assert.notEqual(item?.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.category, CATEGORY.REVIEW_REQUEST); // retombe sur le fallback
});

test('réponse postérieure à last_read_at → THREAD_REPLY', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T15:00:00Z', html_url: 'fresh' },
  ] };
  const t = prThread({ reason: 'mention', last_read_at: '2026-06-24T12:00:00Z' });
  const item = classify(t, ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.url, 'fresh');
});

test('comment sur PR où je suis juste reviewer (pas de fil à moi) → null', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ] };
  assert.equal(classify(prThread({ reason: 'comment' }), ME, insp), null);
});

// ── classifyVerdict : item + raison (mode debug) ───────────────────────────
test('classifyVerdict : non-PR → item null + raison', () => {
  const t = prThread({ subject: { ...prThread().subject, type: 'Issue' } });
  const v = classifyVerdict(t, ME, null);
  assert.equal(v.item, null);
  assert.match(v.reason, /pas une Pull Request/);
});

test('classifyVerdict : reason hors liste → item null + raison citant la reason', () => {
  const v = classifyVerdict(prThread({ reason: 'ci_activity' }), ME, null);
  assert.equal(v.item, null);
  assert.match(v.reason, /ci_activity/);
});

test('classifyVerdict : réponse à mon fil → item THREAD_REPLY + raison nominative', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ] };
  const v = classifyVerdict(prThread({ reason: 'review_requested' }), ME, insp);
  assert.equal(v.item.category, CATEGORY.THREAD_REPLY);
  assert.match(v.reason, /réponse de @alice/);
});

test('classifyVerdict : author sans activité d’un autre → item null + raison « ta propre action »', () => {
  const v = classifyVerdict(prThread({ reason: 'author' }), ME, { latestComment: null, reviewComments: [] });
  assert.equal(v.item, null);
  assert.match(v.reason, /ta propre action/);
});

test('classifyVerdict : review_requested fallback → REVIEW_REQUEST + raison watch', () => {
  const v = classifyVerdict(prThread({ reason: 'review_requested' }), ME, null);
  assert.equal(v.item.category, CATEGORY.REVIEW_REQUEST);
  assert.match(v.reason, /watch/);
});

test('classify reste équivalent à classifyVerdict(...).item', () => {
  const insp = { latestComment: { user: { login: 'bob' }, html_url: 'x' }, reviewComments: [] };
  const t = prThread({ reason: 'author' });
  assert.deepEqual(classify(t, ME, insp), classifyVerdict(t, ME, insp).item);
});
