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
