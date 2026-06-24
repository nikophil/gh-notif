import { classify, CATEGORY } from './filter.js';

const TRIGGER_FOR = {
  [CATEGORY.REVIEW_REQUEST]: 'review',
  [CATEGORY.MENTION]: 'mention',
  [CATEGORY.THREAD_REPLY]: 'reply',
  [CATEGORY.ON_MY_PR]: 'comment',
};

export async function inspectThread(gh, thread, me) {
  const reason = thread.reason;
  if (reason === 'review_requested') return null;

  if (reason === 'mention' || reason === 'team_mention' || reason === 'author') {
    const url = thread.subject?.latest_comment_url;
    const latestComment = url ? await gh.getComment(url) : null;
    return { latestComment, reviewComments: [] };
  }

  // comment / subscribed / manual
  const number = Number(thread.subject.url.split('/').pop());
  const reviewComments = await gh.getReviewComments(thread.repository.full_name, number);
  return { latestComment: null, reviewComments };
}

export async function collectNotifications(gh, me, { all = false } = {}) {
  const threads = await gh.listNotifications({ all });
  const items = [];
  for (const thread of threads) {
    if (thread.subject?.type !== 'PullRequest') continue; // évite tout fetch inutile
    const inspection = await inspectThread(gh, thread, me);
    const item = classify(thread, me, inspection);
    if (item) items.push(item);
  }
  return items;
}

export async function collectPending(gh) {
  const items = await gh.searchReviewRequested();
  return items.map((it) => ({
    repo: it.repository_url.replace('https://api.github.com/repos/', ''),
    number: it.number,
    title: it.title,
    url: it.html_url,
    updatedAt: it.updated_at,
  }));
}

export async function collectAuthored(gh) {
  const items = await gh.searchAuthored();
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
export async function collectPRs(gh, me, { all = false } = {}) {
  const [items, pending, authored] = await Promise.all([
    collectNotifications(gh, me, { all }),
    collectPending(gh),
    collectAuthored(gh),
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
