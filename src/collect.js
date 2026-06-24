import { classify, CATEGORY } from './filter.js';

const TRIGGER_FOR = {
  [CATEGORY.REVIEW_REQUEST]: 'review',
  [CATEGORY.MENTION]: 'mention',
  [CATEGORY.THREAD_REPLY]: 'reply',
  [CATEGORY.ON_MY_PR]: 'comment',
};

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
  if (thread.reason === 'review_requested') return null;

  // On récupère le dernier commentaire (acteur des mention/author) ET les
  // review-comments (détection de réponse à mon fil), car la `reason` est
  // « collante » : une réponse réelle peut arriver sous une reason=mention.
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
  const items = [];
  for (const thread of threads) {
    if (thread.subject?.type !== 'PullRequest') continue; // évite tout fetch inutile
    if (!scopeMatches(scope, thread.repository?.full_name)) continue; // hors org/repo demandé
    const inspection = await inspectThread(gh, thread, me);
    const item = classify(thread, me, inspection);
    if (item) items.push(item);
  }
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

// Réduit le statusCheckRollup (tableau renvoyé par `gh pr view`) en un état
// global : 'fail' | 'pending' | 'pass' | 'none'.
export function ciRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion || '').toUpperCase();
    const state = (c.state || '').toUpperCase();
    const status = (c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) return 'fail';
    if (['FAILURE', 'ERROR'].includes(state)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    if (['PENDING', 'EXPECTED'].includes(state)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

// Regroupe notifications + reviews en attente par PR, agrège les triggers,
// récupère les détails de chaque PR (auteur / date / diff / CI) en parallèle,
// puis sépare selon que la PR est de moi ou d'un autre.
export async function collectPRs(gh, me, { all = false, scope = null } = {}) {
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
  for (const it of items) ensure(it.repo, it.number, it.title).triggers.add(TRIGGER_FOR[it.category]);
  for (const p of pending) ensure(p.repo, p.number, p.title).triggers.add('review');
  for (const a of authored) ensure(a.repo, a.number, a.title); // dashboard : pas de trigger

  const entries = [...byKey.values()];
  const details = await mapLimit(entries, 8, (e) => gh.getPullDetails(e.repo, e.number).catch(() => null));

  const mine = [];
  const others = [];
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
      ci: ciRollup(d?.statusCheckRollup),
    };
    if (d && d.author?.login === me) mine.push(row);
    else others.push(row);
  });
  return { mine, others };
}
