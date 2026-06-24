// Regroupe les review-comments par fil (racine = remontée des in_reply_to_id),
// et renvoie le commentaire le plus récent d'un autre auteur situé dans un fil
// où `me` a participé et dont au least un commentaire (potentiellement transitivement)
// est une réponse directe à un commentaire de `me`. null si aucun.
export function findReplyToMe(reviewComments, me) {
  const byId = new Map(reviewComments.map((c) => [c.id, c]));

  // Pour chaque commentaire, détermine s'il est une réponse (directe ou indirecte) à un commentaire de `me`
  const isReplyToMe = (c) => {
    let cur = c;
    while (cur.in_reply_to_id && byId.has(cur.in_reply_to_id)) {
      cur = byId.get(cur.in_reply_to_id);
      if (cur.user?.login === me) return true;
    }
    return false;
  };

  let best = null;
  for (const c of reviewComments) {
    if (c.user?.login === me) continue; // skip my own comments
    if (!isReplyToMe(c)) continue; // skip if not a reply to my comment
    if (!best || c.created_at > best.created_at) best = c;
  }
  return best;
}
