import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplyToMe, classify, prHtmlUrl, CATEGORY } from '../src/filter.js';

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

test('comment sur PR où je suis juste reviewer (pas de fil à moi) → null', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ] };
  assert.equal(classify(prThread({ reason: 'comment' }), ME, insp), null);
});
