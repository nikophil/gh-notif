export const CATEGORY = {
  REVIEW_REQUEST: 'review_request',
  MENTION: 'mention',
  ON_MY_PR: 'on_my_pr',
  THREAD_REPLY: 'thread_reply',
  APPROVAL: 'approval', // approval received on MY PR (outside notif threads, cf. approvals.js)
};

// Triggers derived from notifications (deliberately WITHOUT review_request: the
// review_requested `reason` is sticky, cf. ARCHITECTURE §1). Defined here — where
// CATEGORY already lives — to be shared between collect.js and hidden.js without an
// import cycle (collect → hidden → filter).
export const TRIGGER_FOR = {
  [CATEGORY.MENTION]: 'mention',
  [CATEGORY.THREAD_REPLY]: 'reply',
  [CATEGORY.ON_MY_PR]: 'comment',
};

const ALLOWED_REASONS = new Set([
  'review_requested', 'mention', 'team_mention',
  'author', 'comment', 'subscribed', 'manual',
]);

function prNumber(thread) {
  return Number(thread.subject.url.split('/').pop());
}

export function prHtmlUrl(thread) {
  return `https://github.com/${thread.repository.full_name}/pull/${prNumber(thread)}`;
}

function baseItem(thread, extra) {
  return {
    repo: thread.repository.full_name,
    number: prNumber(thread),
    title: thread.subject.title,
    threadId: thread.id,
    updatedAt: thread.updated_at,
    ...extra,
  };
}

// Pipeline verdict for a thread: { item, reason }. `item` is the classified
// element (or null if discarded), `reason` explains the decision (kept /
// why dropped) — used by debug mode. `classify` keeps only `item`.
export function classifyVerdict(thread, me, inspection) {
  if (thread.subject?.type !== 'PullRequest') {
    return { item: null, reason: 'not a Pull Request' };
  }
  const reason = thread.reason;
  if (!ALLOWED_REASONS.has(reason)) {
    return { item: null, reason: `GitHub reason ignored (${reason})` };
  }

  // A real reply in a thread where I participated is the most precise signal:
  // it takes precedence over the `reason` (which stays "sticky" on review_requested/mention/
  // author/subscribed even when the real event is a reply from someone else).
  const reply = findReplyToMe(inspection?.reviewComments ?? [], me, thread.last_read_at);
  if (reply) {
    return {
      item: baseItem(thread, { category: CATEGORY.THREAD_REPLY, actor: reply.user.login, url: reply.html_url }),
      reason: `reply from @${reply.user.login} to your thread`,
    };
  }

  // review_requested fallback: used ONLY by the poll-loop notifications (desktop
  // notification of a new review request). In the tables, the `reason` is sticky and not very
  // reliable (stays after your review); there the "review" trigger comes exclusively from
  // the `review-requested:@me` search (collectPending), not from this item. See collect.js.
  if (reason === 'review_requested') {
    return {
      item: baseItem(thread, { category: CATEGORY.REVIEW_REQUEST, actor: null, url: prHtmlUrl(thread) }),
      reason: 'review request (notification only)',
    };
  }

  if (reason === 'mention' || reason === 'team_mention') {
    const since = thread.last_read_at;
    const c = inspection?.latestComment;
    // Never read: the mention is genuinely new → we trust it.
    if (!since) {
      return {
        item: baseItem(thread, {
          category: CATEGORY.MENTION,
          actor: c?.user?.login ?? null,
          url: c?.html_url ?? prHtmlUrl(thread),
        }),
        reason: c?.user?.login ? `mention (@${c.user.login})` : 'mention',
      };
    }
    // Already read: `reason: mention` is sticky. We emit only if a REAL mention
    // of me (@me), by someone else, arrived AFTER my read — otherwise it's a
    // re-bump (merge: real #7014; third-party comment without @me: real #6431) → noise.
    const hit = latestMentionOfMe([c, ...(inspection?.reviewComments ?? [])], me, since);
    if (hit) {
      return {
        item: baseItem(thread, { category: CATEGORY.MENTION, actor: hit.user.login, url: hit.html_url }),
        reason: `mention from @${hit.user.login}`,
      };
    }
    return { item: null, reason: 'mention already read, re-bumped without a new @me (merge / third-party comment) → noise' };
  }

  if (reason === 'author') {
    // Main comment from someone else on my PR.
    const c = inspection?.latestComment;
    if (c && c.user?.login !== me) {
      return {
        item: baseItem(thread, { category: CATEGORY.ON_MY_PR, actor: c.user.login, url: c.html_url }),
        reason: `comment from @${c.user.login} on your PR`,
      };
    }
    // Otherwise: (inline) review comment from someone else on my PR. The notif does not
    // always have a `latest_comment_url` for these comments → we inspect the
    // review-comments (replies to MY thread are already captured above).
    const rc = latestOtherComment(inspection?.reviewComments ?? [], me, thread.last_read_at);
    if (rc) {
      return {
        item: baseItem(thread, { category: CATEGORY.ON_MY_PR, actor: rc.user.login, url: rc.html_url }),
        reason: `review-comment from @${rc.user.login} on your PR`,
      };
    }
    return { item: null, reason: 'your own action / PR update (no activity from anyone else)' };
  }

  // comment / subscribed / manual without a reply to me → noise
  return { item: null, reason: 'no reply to your thread → noise' };
}

export function classify(thread, me, inspection) {
  return classifyVerdict(thread, me, inspection).item;
}

// True if `body` explicitly mentions `@me` (word boundary so as not to
// match `@meXY`). Case-insensitive (GitHub logins are).
export function mentionsMe(body, me) {
  if (!body || !me) return false;
  const esc = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}(?![\\w-])`, 'i').test(body);
}

// Most recent comment from someone OTHER than `me`, after `since`, whose
// body mentions me (@me). Confirms that a `reason: mention` notif (sticky)
// corresponds to a REAL new mention and not to a re-bump (merge, third-party
// comment). Only sees the fetched content (latestComment + review-comments): a
// mention in the PR body is not detected (marginal case). null if none.
export function latestMentionOfMe(comments, me, since = null) {
  let best = null;
  for (const c of comments) {
    if (!c || c.user?.login === me) continue;
    if (since && (!c.created_at || c.created_at <= since)) continue;
    if (!mentionsMe(c.body, me)) continue;
    if (!best || (c.created_at || '') > (best.created_at || '')) best = c;
  }
  return best;
}

// Most recent review comment from someone OTHER than `me`, after `since`
// (= last_read_at). Used to detect an (inline) comment on MY PR when the notif
// has no latest_comment_url. null if none.
export function latestOtherComment(reviewComments, me, since = null) {
  let best = null;
  for (const c of reviewComments) {
    if (c.user?.login === me) continue;
    if (since && c.created_at <= since) continue;
    if (!best || c.created_at > best.created_at) best = c;
  }
  return best;
}

// Groups review-comments by thread (root = walking up the in_reply_to_id chain).
// In a thread where `me` participated, returns the most recent comment from
// another author AFTER my last comment in that thread (= a real
// reply that arrived after my participation). null if none.
// `since` (optional, = last_read_at of the notif): we ignore replies
// earlier than or equal to it, already read — otherwise third-party activity that
// re-bumps the notif would re-report an old reply as something new.
export function findReplyToMe(reviewComments, me, since = null) {
  const byId = new Map(reviewComments.map((c) => [c.id, c]));
  const rootId = (c) => {
    let cur = c;
    while (cur.in_reply_to_id && byId.has(cur.in_reply_to_id)) cur = byId.get(cur.in_reply_to_id);
    return cur.id;
  };
  const threads = new Map();
  for (const c of reviewComments) {
    const r = rootId(c);
    if (!threads.has(r)) threads.set(r, []);
    threads.get(r).push(c);
  }
  let best = null;
  for (const comments of threads.values()) {
    const mine = comments.filter((c) => c.user?.login === me);
    if (mine.length === 0) continue;
    const myLatest = mine.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at;
    for (const c of comments) {
      if (c.user?.login === me) continue;
      if (c.created_at <= myLatest) continue;
      if (since && c.created_at <= since) continue; // reply already read → not new
      if (!best || c.created_at > best.created_at) best = c;
    }
  }
  return best;
}
