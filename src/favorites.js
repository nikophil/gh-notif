import { scopeMatches, scopesQualifier } from './collect.js';

// Favoris de scope : une liste de chaînes (`mapado`, `noctud/collection`, …)
// épinglées par l'utilisateur, persistées dans prefs-v1.json.
//
// ⚠️ Décision structurante (cf. ARCHITECTURE.md §14) : la **collecte** porte sur
// l'UNION des favoris (pour que les notifs desktop de tous les périmètres
// arrivent en permanence), et le favori actif n'est qu'un **filtre d'affichage**
// appliqué en aval, sur des données déjà en mémoire. Changer de favori ne coûte
// donc aucune requête GitHub.
//
// Tout est pur ici (comme hidden.js / state.js) ; la persistance vit dans prefs.js.

// Garde-fou : GitHub limite une query de recherche à 256 caractères, et le
// qualifier d'union grandit avec la liste. La vraie contrainte est donc la
// LONGUEUR, pas le nombre (10 favoris aux noms courts passent, 6 aux noms très
// longs non). On refuse à l'ajout, avec un message clair, plutôt que de tronquer
// silencieusement à la collecte. Budget = 256 moins la plus longue des requêtes
// de base (`is:open is:pr review-requested:@me`, 34 caractères) + marge.
export const MAX_QUALIFIER_LENGTH = 200;

// Valeur de scope (favori ou champ de saisie) → objet scope, même sémantique que
// --org/--repo. Vide → null (tout). Contient « / » → repo (owner/name). Sinon → org.
// Vit ici (module le plus pur) et non dans serve.js : les favoris et le CLI en ont
// besoin sans tirer node:http.
export function parseScope(value) {
  const v = (value || '').trim();
  if (!v) return null;
  return v.includes('/') ? { type: 'repo', value: v } : { type: 'org', value: v };
}

// Liste de favoris assainie : chaînes non vides, trimmées, dédupliquées, ordre
// préservé. Robuste face à un prefs-v1.json ancien ou trafiqué (même philosophie
// que themeOf) — n'importe quelle valeur non exploitable est simplement ignorée.
export function normalizeFavorites(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const v = entry.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// Ajoute un favori (idempotent). Lève si la valeur est vide ou si la liste
// résultante dépasserait le budget de longueur de query — l'appelant (CLI / route
// web) remonte le message tel quel.
export function addFavorite(list, value) {
  const favorites = normalizeFavorites(list);
  const v = (value || '').trim();
  if (!v) throw new Error('un favori requiert une valeur (ex. mapado ou noctud/collection)');
  if (favorites.includes(v)) return favorites;
  const next = [...favorites, v];
  if (scopesQualifier(favoriteScopes(next)).length > MAX_QUALIFIER_LENGTH) {
    throw new Error(
      `trop de favoris : la recherche GitHub dépasserait ${MAX_QUALIFIER_LENGTH} caractères. `
      + 'Retires-en un (gh notif fav rm <scope>) ou préfère une org à plusieurs dépôts.',
    );
  }
  return next;
}

// Retire un favori. Valeur absente → liste inchangée (no-op, pas d'erreur).
export function removeFavorite(list, value) {
  const v = (value || '').trim();
  return normalizeFavorites(list).filter((f) => f !== v);
}

// Liste de favoris → liste d'objets scope, pour la collecte (union).
// Liste vide → null, qui vaut « pas de filtre » partout en aval.
export function favoriteScopes(list) {
  const scopes = normalizeFavorites(list).map(parseScope).filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

// Favori actif validé : null (= « tous les favoris ») si absent, inconnu, ou
// retiré de la liste depuis la dernière sauvegarde.
export function activeFavoriteOf(prefs, list) {
  const favorites = normalizeFavorites(list);
  const active = typeof prefs?.activeFav === 'string' ? prefs.activeFav.trim() : '';
  return active && favorites.includes(active) ? active : null;
}

// Favori suivant dans le cycle de la touche `f` :
// null (tous) → list[0] → … → list[n-1] → null. Un `current` inconnu repart du
// début ; une liste vide reste sur null.
export function cycleFavorite(list, current) {
  const favorites = normalizeFavorites(list);
  if (favorites.length === 0) return null;
  const i = favorites.indexOf(current);
  if (i < 0) return favorites[0];
  return i + 1 < favorites.length ? favorites[i + 1] : null;
}

// Libellé d'affichage d'un favori : une **org** devient `mapado/*` (« tous ses
// dépôts »), un **dépôt** reste `owner/name`. ⚠️ Purement cosmétique — la valeur
// stockée, le `data-fav` et l'argument d'URL restent la chaîne brute (`mapado`).
export function favoriteLabel(value) {
  const v = (value || '').trim();
  if (!v) return '';
  return v.includes('/') ? v : `${v}/*`;
}

// Badge par favori = nombre de PR dans « activité sur les PR des autres »
// (`data.others`, déjà hors masquées) qui tombent sous ce scope ; `total` = toutes.
// ⚠️ Calculé sur l'UNION brute (pas la vue filtrée) pour que chaque favori affiche
// **son propre** nombre, y compris ceux qu'on ne regarde pas.
export function favoriteCounts(favorites, others) {
  const rows = Array.isArray(others) ? others : [];
  const byFav = {};
  for (const f of normalizeFavorites(favorites)) {
    const s = parseScope(f);
    byFav[f] = rows.filter((r) => scopeMatches(s, r?.repo)).length;
  }
  return { total: rows.length, byFav };
}

// Lien externe vers MES PR fermées (mergées + closes) sur GitHub, contextualisé
// sur le(s) scope(s) affiché(s) — null, un scope, ou l'union (tableau). Aucune
// collecte ni pagination côté gh-notif : GitHub gère l'affichage.
export function closedPRsUrl(scopes) {
  return `https://github.com/pulls?q=${encodeURIComponent(`is:pr author:@me is:closed${scopesQualifier(scopes)}`)}`;
}

// Filtre d'AFFICHAGE : restreint des données déjà collectées à un scope.
// ⚠️ À n'appliquer qu'en aval de collectPRs ET de notifyNew — filtrer en amont
// casserait les notifs desktop des favoris inactifs, l'élagage de `hidden`
// (reconcile) et la dédup de state.js (cf. ARCHITECTURE.md §14).
export function filterDataByScope(data, scope) {
  if (!scope || !data) return data;
  const keep = (r) => scopeMatches(scope, r?.repo);
  const hidden = (data.hidden ?? []).filter(keep);
  return {
    ...data,
    mine: (data.mine ?? []).filter(keep),
    others: (data.others ?? []).filter(keep),
    hidden,
    hiddenCount: hidden.length,
    notifications: (data.notifications ?? []).filter(keep),
    debug: (data.debug ?? []).filter(keep),
  };
}
