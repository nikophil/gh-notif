export const CATEGORY = {
  REVIEW_REQUEST: 'review_request',
  MENTION: 'mention',
  ON_MY_PR: 'on_my_pr',
  THREAD_REPLY: 'thread_reply',
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

export function classify(thread, me, inspection) {
  if (thread.subject?.type !== 'PullRequest') return null;
  const reason = thread.reason;
  if (!ALLOWED_REASONS.has(reason)) return null;

  // Une vraie réponse dans un fil où j'ai participé est le signal le plus précis :
  // elle prime sur la `reason` (qui reste « collante » sur review_requested/mention/
  // author/subscribed même quand l'évènement réel est une réponse de quelqu'un d'autre).
  const reply = findReplyToMe(inspection?.reviewComments ?? [], me);
  if (reply) {
    return baseItem(thread, { category: CATEGORY.THREAD_REPLY, actor: reply.user.login, url: reply.html_url });
  }

  // Fallback review_requested : sert UNIQUEMENT au `--watch` (notification desktop
  // d'une nouvelle demande de review). En mode liste, la `reason` est collante et peu
  // fiable (reste après ta review) ; le trigger « review » y vient exclusivement de la
  // recherche `review-requested:@me` (collectPending), pas de cet item. Voir collect.js.
  if (reason === 'review_requested') {
    return baseItem(thread, { category: CATEGORY.REVIEW_REQUEST, actor: null, url: prHtmlUrl(thread) });
  }

  if (reason === 'mention' || reason === 'team_mention') {
    const c = inspection?.latestComment;
    return baseItem(thread, {
      category: CATEGORY.MENTION,
      actor: c?.user?.login ?? null,
      url: c?.html_url ?? prHtmlUrl(thread),
    });
  }

  if (reason === 'author') {
    const c = inspection?.latestComment;
    if (!c) return null;                       // pas de nouveau commentaire => mise à jour de PR
    if (c.user?.login === me) return null;     // ma propre action
    return baseItem(thread, { category: CATEGORY.ON_MY_PR, actor: c.user.login, url: c.html_url });
  }

  // comment / subscribed / manual sans réponse à moi → bruit
  return null;
}

// Regroupe les review-comments par fil (racine = remontée des in_reply_to_id).
// Dans un fil où `me` a participé, renvoie le commentaire le plus récent d'un
// autre auteur POSTÉRIEUR à mon dernier commentaire de ce fil (= une vraie
// réponse arrivée après ma participation). null si aucun.
export function findReplyToMe(reviewComments, me) {
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
      if (!best || c.created_at > best.created_at) best = c;
    }
  }
  return best;
}
