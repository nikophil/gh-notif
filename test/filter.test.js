import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReplyToMe, latestOtherComment, mentionsMe, latestMentionOfMe, classify, classifyVerdict, prHtmlUrl, CATEGORY } from '../src/filter.js';

const ME = 'nikophil';

test('reply under my comment → returns the reply', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  const r = findReplyToMe(comments, ME);
  assert.equal(r?.id, 2);
});

test('comment in a thread where I do not participate → null', () => {
  const comments = [
    { id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('only my own reply → null', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('several replies → returns the most recent', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T12:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME)?.id, 3);
});

test('reply posted AFTER mine in a thread I did not create (GitHub flat replies) → KEEP', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T12:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME)?.id, 3);
});

test('comment from someone else BEFORE my participation → ignored', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:30:00Z', html_url: 'u2' },
    { id: 3, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-24T11:00:00Z', html_url: 'u3' },
  ];
  assert.equal(findReplyToMe(comments, ME), null);
});

test('findReplyToMe: reply earlier than `since` (already read) → ignored', () => {
  const comments = [
    { id: 1, user: { login: ME }, created_at: '2026-06-20T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-20T11:00:00Z', html_url: 'u2' },
  ];
  // read on 06/24 → the 06/20 reply is no longer new
  assert.equal(findReplyToMe(comments, ME, '2026-06-24T00:00:00Z'), null);
  // since before the reply → returned as expected
  assert.equal(findReplyToMe(comments, ME, '2026-06-20T10:30:00Z')?.id, 2);
  // without since (default) → unchanged behavior
  assert.equal(findReplyToMe(comments, ME)?.id, 2);
});

// add
const prThread = (over = {}) => ({
  id: 't1',
  reason: 'review_requested',
  updated_at: '2026-06-24T12:00:00Z',
  subject: { title: 'My PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
  repository: { full_name: 'o/r' },
  ...over,
});

test('prHtmlUrl builds the web URL', () => {
  assert.equal(prHtmlUrl(prThread()), 'https://github.com/o/r/pull/42');
});

test('non-PullRequest → null', () => {
  const t = prThread({ subject: { ...prThread().subject, type: 'Issue' } });
  assert.equal(classify(t, ME, null), null);
});

test('reason outside the whitelist (ci_activity) → null', () => {
  assert.equal(classify(prThread({ reason: 'ci_activity' }), ME, null), null);
});

test('review_requested → REVIEW_REQUEST with PR URL', () => {
  const item = classify(prThread({ reason: 'review_requested' }), ME, null);
  assert.equal(item.category, CATEGORY.REVIEW_REQUEST);
  assert.equal(item.url, 'https://github.com/o/r/pull/42');
  assert.equal(item.repo, 'o/r');
  assert.equal(item.number, 42);
  assert.equal(item.title, 'My PR');
  assert.equal(item.threadId, 't1');
  assert.equal(item.updatedAt, '2026-06-24T12:00:00Z');
});

test('reason=review_requested sticky but reply in my thread → THREAD_REPLY (takes precedence over review)', () => {
  // I was added as reviewer (reason stays "review_requested"), but
  // the real event is a reply from alice in a thread where I participated.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r2' },
  ] };
  const item = classify(prThread({ reason: 'review_requested' }), ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.actor, 'alice');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r2');
});

test('mention (never read) → MENTION with author + comment URL', () => {
  // No last_read_at: genuinely new mention notif → we trust it.
  const insp = { latestComment: { user: { login: 'alice' }, html_url: 'https://github.com/o/r/pull/42#discussion_r9' }, reviewComments: [] };
  const item = classify(prThread({ reason: 'mention' }), ME, insp);
  assert.equal(item.category, CATEGORY.MENTION);
  assert.equal(item.actor, 'alice');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r9');
});

test('mentionsMe: exact @login, not @loginXY', () => {
  assert.equal(mentionsMe('cc @nikophil thanks', 'nikophil'), true);
  assert.equal(mentionsMe('see @nikophil2 later', 'nikophil'), false);
  assert.equal(mentionsMe('nothing here', 'nikophil'), false);
  assert.equal(mentionsMe(null, 'nikophil'), false);
});

test('latestMentionOfMe: last comment from someone else, after since, that mentions me', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-26T08:00:00Z', body: 'cc @nikophil' },
    { id: 2, user: { login: ME }, created_at: '2026-06-26T09:00:00Z', body: '@nikophil (myself)' },
    { id: 3, user: { login: 'bob' }, created_at: '2026-06-26T07:00:00Z', body: 'without mention' },
  ];
  assert.equal(latestMentionOfMe(comments, ME, '2026-06-25T00:00:00Z')?.id, 1); // alice, mentions me
  assert.equal(latestMentionOfMe(comments, ME, '2026-06-26T08:30:00Z'), null);  // alice already read, the rest does not count
});

test('regression #7014: sticky mention, re-bumped merged PR, already read, no recent @me → null', () => {
  // bare latest_comment_url → latestComment = PR object (old), no recent mention.
  const insp = { latestComment: { user: { login: 'someone' }, created_at: '2026-06-20T00:00:00Z', body: 'PR body', html_url: 'https://github.com/o/r/pull/42' }, reviewComments: [] };
  const t = prThread({ reason: 'mention', last_read_at: '2026-06-26T09:00:00Z' });
  assert.equal(classify(t, ME, insp), null);
});

test('regression #6431: sticky mention, recent third-party comment WITHOUT @me → null', () => {
  // lnahiro posts a root comment (not a reply to my thread) without mentioning me.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-26T08:01:00Z', in_reply_to_id: null, body: "can't we filter via monolog?", html_url: 'x' },
  ] };
  const t = prThread({ reason: 'mention', last_read_at: '2026-06-25T12:30:00Z' });
  assert.equal(classify(t, ME, insp), null);
});

test('mention already read BUT new @me by someone else → MENTION', () => {
  const insp = { latestComment: { user: { login: 'lnahiro' }, created_at: '2026-06-26T08:01:00Z', body: 'cc @nikophil ?', html_url: 'https://github.com/o/r/pull/42#discussion_r9' }, reviewComments: [] };
  const t = prThread({ reason: 'mention', last_read_at: '2026-06-25T12:30:00Z' });
  const item = classify(t, ME, insp);
  assert.equal(item.category, CATEGORY.MENTION);
  assert.equal(item.actor, 'lnahiro');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r9');
});

test('author with comment from someone else → ON_MY_PR', () => {
  const insp = { latestComment: { user: { login: 'bob' }, html_url: 'https://github.com/o/r/pull/42#issuecomment_5' }, reviewComments: [] };
  const item = classify(prThread({ reason: 'author' }), ME, insp);
  assert.equal(item.category, CATEGORY.ON_MY_PR);
  assert.equal(item.actor, 'bob');
});

test('author WITHOUT new comment (push/CI/merge) → null', () => {
  const insp = { latestComment: null, reviewComments: [] };
  assert.equal(classify(prThread({ reason: 'author' }), ME, insp), null);
});

test('latestOtherComment: last comment from someone else, filtered by since', () => {
  const comments = [
    { id: 1, user: { login: 'alice' }, created_at: '2026-06-25T10:00:00Z', html_url: 'a' },
    { id: 2, user: { login: ME }, created_at: '2026-06-25T11:00:00Z', html_url: 'mine' },
    { id: 3, user: { login: 'bob' }, created_at: '2026-06-25T12:00:00Z', html_url: 'b' },
  ];
  assert.equal(latestOtherComment(comments, ME)?.id, 3);                          // the most recent from someone else
  assert.equal(latestOtherComment(comments, ME, '2026-06-25T11:30:00Z')?.id, 3);  // after since
  assert.equal(latestOtherComment(comments, ME, '2026-06-25T23:00:00Z'), null);   // all already read
});

test('author: (inline) review comment from someone else on my PR → ON_MY_PR (#7015)', () => {
  // Real case #7015: no latest_comment_url, but a root review-comment from
  // lnahiro. The author branch must detect it via the review-comments.
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-25T12:06:59Z', html_url: 'https://github.com/o/r/pull/7015#discussion_r9' },
  ] };
  const item = classify(prThread({ reason: 'author' }), ME, insp);
  assert.equal(item.category, CATEGORY.ON_MY_PR);
  assert.equal(item.actor, 'lnahiro');
  assert.equal(item.url, 'https://github.com/o/r/pull/7015#discussion_r9');
});

test('author: review-comment already read (< last_read_at) → null', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'lnahiro' }, created_at: '2026-06-25T12:06:00Z', html_url: 'x' },
  ] };
  const t = prThread({ reason: 'author', last_read_at: '2026-06-25T12:09:00Z' });
  assert.equal(classify(t, ME, insp), null);
});

test('author but last actor = me → null', () => {
  const insp = { latestComment: { user: { login: ME }, html_url: 'x' }, reviewComments: [] };
  assert.equal(classify(prThread({ reason: 'author' }), ME, insp), null);
});

test('comment with reply to my thread → THREAD_REPLY', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'carol' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r2' },
  ] };
  const item = classify(prThread({ reason: 'comment' }), ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.actor, 'carol');
  assert.equal(item.url, 'https://github.com/o/r/pull/42#discussion_r2');
});

test('reason=mention sticky but real reply in my thread → THREAD_REPLY (takes precedence over mention)', () => {
  // Real case: I was mentioned on the PR (reason stays "mention"), but
  // the real event is a reply from lnahiro in a thread where I participated.
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

test('regression #6993: re-bumped notif, old reply already read (< last_read_at) → not THREAD_REPLY', () => {
  // Third-party activity (exchange between two others in main comments)
  // re-bumps a review_requested notif. The only "reply to me" is old
  // (06/20) and already read (last_read_at = 06/24) → must not re-trigger.
  const insp = { latestComment: { user: { login: 'lnahiro' }, html_url: 'x' }, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-19T13:50:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'Nickinthebox' }, created_at: '2026-06-20T06:57:00Z', html_url: 'old-reply' },
  ] };
  const t = prThread({ reason: 'review_requested', last_read_at: '2026-06-24T14:44:49Z' });
  const item = classify(t, ME, insp);
  assert.notEqual(item?.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.category, CATEGORY.REVIEW_REQUEST); // falls back to the fallback
});

test('reply after last_read_at → THREAD_REPLY', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T15:00:00Z', html_url: 'fresh' },
  ] };
  const t = prThread({ reason: 'mention', last_read_at: '2026-06-24T12:00:00Z' });
  const item = classify(t, ME, insp);
  assert.equal(item.category, CATEGORY.THREAD_REPLY);
  assert.equal(item.url, 'fresh');
});

test('comment on PR where I am just reviewer (no thread of mine) → null', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: 'bob' }, created_at: '2026-06-24T10:00:00Z', html_url: 'u1' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ] };
  assert.equal(classify(prThread({ reason: 'comment' }), ME, insp), null);
});

// ── classifyVerdict: item + reason (debug mode) ───────────────────────────
test('classifyVerdict: non-PR → item null + reason', () => {
  const t = prThread({ subject: { ...prThread().subject, type: 'Issue' } });
  const v = classifyVerdict(t, ME, null);
  assert.equal(v.item, null);
  assert.match(v.reason, /not a Pull Request/);
});

test('classifyVerdict: reason outside list → item null + reason citing the reason', () => {
  const v = classifyVerdict(prThread({ reason: 'ci_activity' }), ME, null);
  assert.equal(v.item, null);
  assert.match(v.reason, /ci_activity/);
});

test('classifyVerdict: reply to my thread → item THREAD_REPLY + named reason', () => {
  const insp = { latestComment: null, reviewComments: [
    { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
    { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'u2' },
  ] };
  const v = classifyVerdict(prThread({ reason: 'review_requested' }), ME, insp);
  assert.equal(v.item.category, CATEGORY.THREAD_REPLY);
  assert.match(v.reason, /reply from @alice/);
});

test('classifyVerdict: author without activity from someone else → item null + reason "your own action"', () => {
  const v = classifyVerdict(prThread({ reason: 'author' }), ME, { latestComment: null, reviewComments: [] });
  assert.equal(v.item, null);
  assert.match(v.reason, /your own action/);
});

test('classifyVerdict: review_requested fallback → REVIEW_REQUEST + notification-only reason', () => {
  const v = classifyVerdict(prThread({ reason: 'review_requested' }), ME, null);
  assert.equal(v.item.category, CATEGORY.REVIEW_REQUEST);
  assert.match(v.reason, /notification only/);
});

test('classify stays equivalent to classifyVerdict(...).item', () => {
  const insp = { latestComment: { user: { login: 'bob' }, html_url: 'x' }, reviewComments: [] };
  const t = prThread({ reason: 'author' });
  assert.deepEqual(classify(t, ME, insp), classifyVerdict(t, ME, insp).item);
});
