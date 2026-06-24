import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplyToMe } from '../src/filter.js';

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
