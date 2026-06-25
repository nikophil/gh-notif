import { classify, CATEGORY, TRIGGER_FOR } from './filter.js';
import { reconcile, isHidden, keyOf } from './hidden.js';

// Concurrence max des appels `gh` (évite de spawner des dizaines de process
// d'un coup / de heurter le rate-limit secondaire de GitHub).
const CONCURRENCY = 10;

// scope : null (tout) | { type:'org', value } | { type:'repo', value:'owner/name' }
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

export async function inspectThread(gh, thread, me) {
  // On récupère le dernier commentaire (acteur des mention/author) ET les
  // review-comments (détection de réponse à mon fil), car la `reason` est
  // « collante » : une réponse réelle peut arriver sous une reason=mention OU
  // review_requested (d'où la récupération même pour les demandes de review).
  const number = Number(thread.subject.url.split('/').pop());
  const url = thread.subject?.latest_comment_url;
  const [latestComment, reviewComments] = await Promise.all([
    url ? gh.getComment(url) : Promise.resolve(null),
    gh.getReviewComments(thread.repository.full_name, number),
  ]);
  return { latestComment, reviewComments };
}

export async function collectNotifications(gh, me, { all = false, scope = null } = {}) {
  const threads = await gh.listNotifications({ all });
  // Ne garde que les PR du scope avant toute requête (filtre = gratuit).
  const prThreads = threads.filter(
    (t) => t.subject?.type === 'PullRequest' && scopeMatches(scope, t.repository?.full_name),
  );
  // Inspection en parallèle (au lieu d'un await séquentiel par thread) : c'est le
  // gros gain de temps. `mapLimit` préserve l'ordre ; un thread en échec → null.
  const inspections = await mapLimit(prThreads, CONCURRENCY, (t) =>
    inspectThread(gh, t, me).catch(() => null),
  );
  const items = [];
  prThreads.forEach((thread, i) => {
    const item = classify(thread, me, inspections[i]);
    if (item) items.push(item);
  });
  return items;
}

export async function collectPending(gh, scope = null) {
  const items = await gh.searchReviewRequested(scopeQualifier(scope));
  return items.map((it) => ({
    repo: it.repository_url.replace('https://api.github.com/repos/', ''),
    number: it.number,
    title: it.title,
    url: it.html_url,
    updatedAt: it.updated_at,
  }));
}

export async function collectAuthored(gh, scope = null) {
  const items = await gh.searchAuthored(scopeQualifier(scope));
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
// est APPROVED (comme l'UI GitHub). Ignore les COMMENTED/CHANGES_REQUESTED, et une
// approbation annulée par une review ultérieure du même user ne compte plus.
export function countApprovals(reviews) {
  if (!Array.isArray(reviews)) return 0;
  const latestByUser = new Map();
  for (const r of reviews) {
    const login = r.author?.login;
    if (!login) continue;
    const prev = latestByUser.get(login);
    if (!prev || (r.submittedAt || '') >= (prev.submittedAt || '')) latestByUser.set(login, r);
  }
  let n = 0;
  for (const r of latestByUser.values()) if ((r.state || '').toUpperCase() === 'APPROVED') n++;
  return n;
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
export async function collectPRs(gh, me, { all = false, scope = null, hidden = {} } = {}) {
  const [items, pending, authored] = await Promise.all([
    collectNotifications(gh, me, { all, scope }),
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
  entries.forEach((e, i) => {
    const d = details[i];
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
      approvals: countApprovals(d?.reviews),
    };
    if (d && d.author?.login === me) mine.push(row); // mes PR : jamais masquées, on garde mes drafts
    else if (row.state !== 'draft') othersAll.push(row); // PR des autres : on masque les drafts
  });

  // Dé-masque sur nouveau trigger + élague les clés obsolètes (mute `hidden`),
  // puis sépare les PR des autres en visibles / masquées.
  const hiddenChanged = reconcile(hidden, othersAll, items);
  const others = othersAll.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = othersAll.filter((r) => isHidden(hidden, keyOf(r)));

  // `notifications` = items de notification déjà classifiés (avec url d'évènement),
  // exposés pour que `--watch` détecte les nouveautés sans refaire le travail.
  return { mine, others, hidden: hiddenRows, hiddenCount: hiddenRows.length, hiddenChanged, notifications: items };
}
