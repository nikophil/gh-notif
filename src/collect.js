import { classify, classifyVerdict, CATEGORY, TRIGGER_FOR } from './filter.js';
import { reconcile, isHidden, keyOf } from './hidden.js';
import { approvalsOf } from './approvals.js';

// Concurrence max des appels `gh` (évite de spawner des dizaines de process
// d'un coup / de heurter le rate-limit secondaire de GitHub). Abaissée pour
// lisser le pic à froid et ménager le secondary rate limit.
const CONCURRENCY = 6;

// Fusionne deux listes de review-comments par `id` (la version `fresh` gagne),
// triées par `created_at`. Sert à la récupération incrémentale (`since`) : on
// ne re-pagine pas tout un fil, on fusionne le delta avec le cache.
export function mergeReviewComments(prev, fresh) {
  const byId = new Map();
  for (const c of prev || []) byId.set(c.id, c);
  for (const c of fresh || []) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    const x = a.created_at || '';
    const y = b.created_at || '';
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// Borne haute des `updated_at` (fallback `created_at`) d'une liste de
// commentaires — prochain `since` pour la récupération incrémentale. null si vide.
export function watermarkOf(comments) {
  let max = null;
  for (const c of comments || []) {
    const t = c.updated_at || c.created_at;
    if (t && (max === null || t > max)) max = t;
  }
  return max;
}

// scope : null (tout) | { type:'org', value } | { type:'repo', value:'owner/name' }
// Les entrées publiques (collectPRs & co) acceptent aussi un TABLEAU de scopes
// (union des favoris) — cf. toScopeList / matchesAnyScope plus bas.
export function scopeMatches(scope, fullName) {
  if (!scope) return true;
  if (scope.type === 'org') return (fullName || '').startsWith(`${scope.value}/`);
  return fullName === scope.value;
}

// Qualifier de recherche GitHub correspondant au scope (chaîne préfixée d'un espace).
export function scopeQualifier(scope) {
  if (!scope) return '';
  return scope.type === 'org' ? ` org:${scope.value}` : ` repo:${scope.value}`;
}

// ── Scopes multiples (favoris) ───────────────────────────────────────────
// Depuis les favoris, `scope` peut être une LISTE de scopes dont on veut
// l'union. Les trois helpers ci-dessous généralisent les deux précédents sans
// les modifier (un scope unique reste un cas particulier).

// Normalise un paramètre `scope` : null | objet unique | tableau → null | tableau
// non vide. Un tableau vide vaut « pas de filtre ».
export function toScopeList(scope) {
  if (!scope) return null;
  const list = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
  return list.length > 0 ? list : null;
}

// Le dépôt appartient-il à AU MOINS UN des scopes ? (null → tout passe)
export function matchesAnyScope(scopes, fullName) {
  const list = toScopeList(scopes);
  if (!list) return true;
  return list.some((s) => scopeMatches(s, fullName));
}

// Qualifier de recherche pour l'union des scopes. GitHub OR-ise les qualifiers
// de scope répétés (mesuré : `repo:a` 6 + `repo:b` 9 → les deux 15), y compris
// en mêlant `org:` et `repo:` → l'union coûte UNE recherche, pas N.
export function scopesQualifier(scopes) {
  const list = toScopeList(scopes);
  if (!list) return '';
  return list.map(scopeQualifier).join('');
}

export async function inspectThread(gh, thread, me, cacheEntry = null) {
  // Cache hit : le thread n'a pas bougé depuis le dernier poll (même
  // `updated_at`) → on réutilise l'inspection précédente, **0 requête**.
  if (cacheEntry && cacheEntry.threadUpdatedAt === thread.updated_at) {
    return cacheEntry.inspection;
  }
  // On récupère le dernier commentaire (acteur des mention/author) ET les
  // review-comments (détection de réponse à mon fil), car la `reason` est
  // « collante » : une réponse réelle peut arriver sous une reason=mention OU
  // review_requested (d'où la récupération même pour les demandes de review).
  // Récupération incrémentale : seulement les commentaires postérieurs au
  // dernier vu (`since`), fusionnés avec ceux du cache.
  const number = Number(thread.subject.url.split('/').pop());
  const url = thread.subject?.latest_comment_url;
  const since = cacheEntry?.since ?? null;
  const [latestComment, fresh] = await Promise.all([
    url ? gh.getComment(url) : Promise.resolve(null),
    gh.getReviewComments(thread.repository.full_name, number, { since }),
  ]);
  const reviewComments = since
    ? mergeReviewComments(cacheEntry?.inspection?.reviewComments ?? [], fresh)
    : fresh;
  return { latestComment, reviewComments };
}

export async function collectNotifications(gh, me, { all = false, scope = null, cache = null, debug = null } = {}) {
  const threads = await gh.listNotifications({ all });
  // Ne garde que les PR du scope avant toute requête (filtre = gratuit).
  const prThreads = threads.filter(
    (t) => t.subject?.type === 'PullRequest' && matchesAnyScope(scope, t.repository?.full_name),
  );
  // Inspection en parallèle (au lieu d'un await séquentiel par thread) : c'est le
  // gros gain de temps. `mapLimit` préserve l'ordre ; un thread en échec → null.
  // Avec `cache` (boucle longue) : un thread inchangé coûte 0 requête, sinon on
  // récupère seulement le delta de commentaires et on met à jour l'entrée.
  const inspections = await mapLimit(prThreads, CONCURRENCY, (t) => {
    const prev = cache?.get(t.id) ?? null;
    return inspectThread(gh, t, me, prev)
      .then((inspection) => {
        if (cache && inspection) {
          const hit = prev && prev.threadUpdatedAt === t.updated_at;
          const since = hit ? prev.since : watermarkOf(inspection.reviewComments);
          cache.set(t.id, { threadUpdatedAt: t.updated_at, since, inspection });
        }
        return inspection;
      })
      .catch(() => null);
  });
  // Élague le cache des threads qui ne sont plus dans la liste de notifications.
  if (cache) {
    const present = new Set(prThreads.map((t) => t.id));
    for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  }
  const items = [];
  prThreads.forEach((thread, i) => {
    const inspection = inspections[i];
    const { item, reason } = classifyVerdict(thread, me, inspection);
    if (item) items.push(item);
    // Sink debug (optionnel) : verdict compact par thread, sans corps de
    // commentaire (coût + vie privée). Produit gratuitement (donnée déjà fetchée).
    if (debug) {
      debug.push({
        repo: thread.repository?.full_name ?? null,
        number: Number(thread.subject.url.split('/').pop()),
        title: thread.subject?.title ?? null,
        ghReason: thread.reason,
        updatedAt: thread.updated_at,
        lastReadAt: thread.last_read_at ?? null,
        commentsCount: inspection?.reviewComments?.length ?? 0,
        latestCommentAuthor: inspection?.latestComment?.user?.login ?? null,
        verdict: { kept: !!item, category: item?.category ?? null, reason },
      });
    }
  });
  return items;
}

export async function collectPending(gh, scope = null) {
  const items = await gh.searchReviewRequested(scopesQualifier(scope));
  return items.map((it) => ({
    repo: it.repository_url.replace('https://api.github.com/repos/', ''),
    number: it.number,
    title: it.title,
    url: it.html_url,
    updatedAt: it.updated_at,
  }));
}

export async function collectAuthored(gh, scope = null) {
  const items = await gh.searchAuthored(scopesQualifier(scope));
  return items.map((it) => ({
    repo: it.repository_url.replace('https://api.github.com/repos/', ''),
    number: it.number,
    title: it.title,
    url: it.html_url,
  }));
}

// Exécute fn sur chaque item avec au plus `limit` exécutions concurrentes
// (évite de lancer des dizaines de `gh pr view` d'un coup).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Traduit l'état du statusCheckRollup GraphQL (un seul état agrégé par GitHub)
// en : 'fail' | 'pending' | 'pass' | 'none'.
export function ciFromState(state) {
  const s = (state || '').toUpperCase();
  if (s === 'SUCCESS') return 'pass';
  if (s === 'FAILURE' || s === 'ERROR') return 'fail';
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
  return 'none'; // pas de checks (rollup null)
}

// Nombre d'approbations : utilisateurs distincts dont la review LA PLUS RÉCENTE
// est APPROVED (cf. approvalsOf). Conservé pour la colonne ✅ des tableaux.
export function countApprovals(reviews) {
  return approvalsOf(reviews).length;
}

// État affiché d'une PR à partir de `gh pr view` : 'draft' | 'open' | 'merged' | 'closed'.
export function prState(d) {
  if (d?.isDraft) return 'draft';
  const s = (d?.state || '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

// Regroupe notifications + reviews en attente par PR, agrège les triggers,
// récupère les détails de chaque PR (auteur / date / diff / CI) en parallèle,
// puis sépare selon que la PR est de moi ou d'un autre.
export async function collectPRs(gh, me, { all = false, scope = null, hidden = {}, cache = null } = {}) {
  const debug = []; // verdict compact par thread (toujours produit : coût nul)
  const [items, pending, authored] = await Promise.all([
    collectNotifications(gh, me, { all, scope, cache, debug }),
    collectPending(gh, scope),
    collectAuthored(gh, scope),
  ]);

  const byKey = new Map();
  const ensure = (repo, number, title) => {
    const key = `${repo}#${number}`;
    if (!byKey.has(key)) {
      byKey.set(key, { repo, number, title, url: `https://github.com/${repo}/pull/${number}`, triggers: new Set() });
    }
    return byKey.get(key);
  };
  for (const it of items) {
    const trig = TRIGGER_FOR[it.category];
    if (!trig) continue; // review_request : ignoré ici (cf. TRIGGER_FOR / collectPending)
    const row = ensure(it.repo, it.number, it.title);
    row.triggers.add(trig);
    // mention / reply / commentaire : `it.url` pointe sur le commentaire précis →
    // le lien de la ligne y mène directement (et non sur la PR seule).
    row.url = it.url;
  }
  for (const p of pending) ensure(p.repo, p.number, p.title).triggers.add('review');
  for (const a of authored) ensure(a.repo, a.number, a.title); // dashboard : pas de trigger

  const entries = [...byKey.values()];
  const details = await gh.getPullDetailsBatch(entries.map((e) => ({ repo: e.repo, number: e.number })));

  const mine = [];
  const othersAll = []; // PR des autres (hors draft), avant filtrage du masquage
  const approvalEvents = []; // une entrée par approbation sur MES PR ouvertes
  entries.forEach((e, i) => {
    const d = details[i];
    const approvers = approvalsOf(d?.reviews);
    const row = {
      repo: e.repo,
      number: e.number,
      url: e.url,
      title: d?.title ?? e.title,
      triggers: [...e.triggers],
      author: d?.author?.login ?? null,
      createdAt: d?.createdAt ?? null,
      additions: d?.additions ?? 0,
      deletions: d?.deletions ?? 0,
      ci: ciFromState(d?.statusCheckRollupState),
      state: prState(d),
      approvals: approvers.length,
    };
    if (d && d.author?.login === me) {
      mine.push(row); // mes PR : jamais masquées, on garde mes drafts
      // Évènements d'approbation : seulement sur mes PR OUVERTES (pas draft/mergée/
      // fermée). « prête à merger » n'a pas de sens autrement (et évite le bruit).
      if (row.state === 'open') {
        for (const ap of approvers) {
          approvalEvents.push({
            repo: e.repo, number: e.number, title: row.title,
            actor: ap.login, url: e.url, submittedAt: ap.submittedAt,
            count: approvers.length,
          });
        }
      }
    } else if (row.state !== 'draft') {
      othersAll.push(row); // PR des autres : on masque les drafts
    }
  });

  // Dé-masque sur nouveau trigger + élague les clés obsolètes (mute `hidden`),
  // puis sépare les PR des autres en visibles / masquées.
  const hiddenChanged = reconcile(hidden, othersAll, items);
  const others = othersAll.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = othersAll.filter((r) => isHidden(hidden, keyOf(r)));

  // `notifications` = items de notification déjà classifiés (avec url d'évènement),
  // exposés pour que `--watch` détecte les nouveautés sans refaire le travail.
  // `debug` = verdict du pipeline par thread (mode debug).
  return { mine, others, hidden: hiddenRows, hiddenCount: hiddenRows.length, hiddenChanged, notifications: items, approvalEvents, debug };
}
