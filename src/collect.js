import { classify } from './filter.js';

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
