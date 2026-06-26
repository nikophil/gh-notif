export const CATEGORY = {
  REVIEW_REQUEST: 'review_request',
  MENTION: 'mention',
  ON_MY_PR: 'on_my_pr',
  THREAD_REPLY: 'thread_reply',
};

// Triggers dérivés des notifications (volontairement SANS review_request : la
// `reason` review_requested est collante, cf. ARCHITECTURE §1). Défini ici — où
// vit déjà CATEGORY — pour être partagé entre collect.js et hidden.js sans cycle
// d'import (collect → hidden → filter).
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

// Verdict du pipeline pour un thread : { item, reason }. `item` est l'élément
// classifié (ou null s'il est écarté), `reason` explique la décision (gardé /
// pourquoi droppé) — utilisé par le mode debug. `classify` n'en garde que `item`.
export function classifyVerdict(thread, me, inspection) {
  if (thread.subject?.type !== 'PullRequest') {
    return { item: null, reason: 'pas une Pull Request' };
  }
  const reason = thread.reason;
  if (!ALLOWED_REASONS.has(reason)) {
    return { item: null, reason: `reason GitHub ignorée (${reason})` };
  }

  // Une vraie réponse dans un fil où j'ai participé est le signal le plus précis :
  // elle prime sur la `reason` (qui reste « collante » sur review_requested/mention/
  // author/subscribed même quand l'évènement réel est une réponse de quelqu'un d'autre).
  const reply = findReplyToMe(inspection?.reviewComments ?? [], me, thread.last_read_at);
  if (reply) {
    return {
      item: baseItem(thread, { category: CATEGORY.THREAD_REPLY, actor: reply.user.login, url: reply.html_url }),
      reason: `réponse de @${reply.user.login} à ton fil`,
    };
  }

  // Fallback review_requested : sert UNIQUEMENT au `--watch` (notification desktop
  // d'une nouvelle demande de review). En mode liste, la `reason` est collante et peu
  // fiable (reste après ta review) ; le trigger « review » y vient exclusivement de la
  // recherche `review-requested:@me` (collectPending), pas de cet item. Voir collect.js.
  if (reason === 'review_requested') {
    return {
      item: baseItem(thread, { category: CATEGORY.REVIEW_REQUEST, actor: null, url: prHtmlUrl(thread) }),
      reason: 'demande de review (signalée en --watch uniquement)',
    };
  }

  if (reason === 'mention' || reason === 'team_mention') {
    const since = thread.last_read_at;
    const c = inspection?.latestComment;
    // Jamais lue : la mention est réellement nouvelle → on fait confiance.
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
    // Déjà lue : `reason: mention` est collante. On n'émet que si une VRAIE mention
    // de moi (@moi), par un autre, est arrivée APRÈS ma lecture — sinon c'est un
    // re-bump (merge : réel #7014 ; commentaire tiers sans @moi : réel #6431) → bruit.
    const hit = latestMentionOfMe([c, ...(inspection?.reviewComments ?? [])], me, since);
    if (hit) {
      return {
        item: baseItem(thread, { category: CATEGORY.MENTION, actor: hit.user.login, url: hit.html_url }),
        reason: `mention de @${hit.user.login}`,
      };
    }
    return { item: null, reason: 'mention déjà lue, re-bumpée sans nouvelle @moi (merge / commentaire tiers) → bruit' };
  }

  if (reason === 'author') {
    // Commentaire principal d'un autre sur ma PR.
    const c = inspection?.latestComment;
    if (c && c.user?.login !== me) {
      return {
        item: baseItem(thread, { category: CATEGORY.ON_MY_PR, actor: c.user.login, url: c.html_url }),
        reason: `commentaire de @${c.user.login} sur ta PR`,
      };
    }
    // Sinon : commentaire de review (inline) d'un autre sur ma PR. La notif n'a pas
    // toujours de `latest_comment_url` pour ces commentaires → on inspecte les
    // review-comments (les réponses à MON fil sont déjà captées plus haut).
    const rc = latestOtherComment(inspection?.reviewComments ?? [], me, thread.last_read_at);
    if (rc) {
      return {
        item: baseItem(thread, { category: CATEGORY.ON_MY_PR, actor: rc.user.login, url: rc.html_url }),
        reason: `review-comment de @${rc.user.login} sur ta PR`,
      };
    }
    return { item: null, reason: 'ta propre action / maj de PR (aucune activité d’un autre)' };
  }

  // comment / subscribed / manual sans réponse à moi → bruit
  return { item: null, reason: 'pas de réponse à ton fil → bruit' };
}

export function classify(thread, me, inspection) {
  return classifyVerdict(thread, me, inspection).item;
}

// Vrai si `body` mentionne explicitement `@me` (frontière de mot pour ne pas
// matcher `@meXY`). Insensible à la casse (les logins GitHub le sont).
export function mentionsMe(body, me) {
  if (!body || !me) return false;
  const esc = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}(?![\\w-])`, 'i').test(body);
}

// Commentaire le plus récent d'un AUTRE que `me`, postérieur à `since`, dont le
// corps me mentionne (@me). Confirme qu'une notif `reason: mention` (collante)
// correspond à une VRAIE nouvelle mention et non à un re-bump (merge, commentaire
// tiers). Ne voit que le contenu fetché (latestComment + review-comments) : une
// mention dans le corps de la PR n'est pas détectée (cas marginal). null si aucun.
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

// Commentaire de review le plus récent d'un AUTRE que `me`, postérieur à `since`
// (= last_read_at). Sert à détecter un commentaire (inline) sur MA PR quand la notif
// n'a pas de latest_comment_url. null si aucun.
export function latestOtherComment(reviewComments, me, since = null) {
  let best = null;
  for (const c of reviewComments) {
    if (c.user?.login === me) continue;
    if (since && c.created_at <= since) continue;
    if (!best || c.created_at > best.created_at) best = c;
  }
  return best;
}

// Regroupe les review-comments par fil (racine = remontée des in_reply_to_id).
// Dans un fil où `me` a participé, renvoie le commentaire le plus récent d'un
// autre auteur POSTÉRIEUR à mon dernier commentaire de ce fil (= une vraie
// réponse arrivée après ma participation). null si aucun.
// `since` (optionnel, = last_read_at de la notif) : on ignore les réponses
// antérieures ou égales, déjà lues — sinon une activité tierce qui rebumpe la
// notif re-signalerait une vieille réponse comme une nouveauté.
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
      if (since && c.created_at <= since) continue; // réponse déjà lue → pas une nouveauté
      if (!best || c.created_at > best.created_at) best = c;
    }
  }
  return best;
}
