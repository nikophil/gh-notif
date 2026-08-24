import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

async function defaultRunner(args) {
  const { stdout } = await pexec('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function parseJson(stdout) {
  const s = stdout.trim();
  if (!s) return null;
  return JSON.parse(s);
}

// PR fields fetched all at once via GraphQL (cf. getPullDetailsBatch).
const PR_FRAGMENT = `fragment pr on PullRequest {
  number title author { login } createdAt updatedAt additions deletions isDraft state mergeable headRefName
  headRepository { nameWithOwner }
  baseRefName baseRepository { defaultBranchRef { name } }
  latestOpinionatedReviews(first: 100) { nodes { author { login } state submittedAt } }
  timelineItems(itemTypes: READY_FOR_REVIEW_EVENT, last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name conclusion status detailsUrl }
      ... on StatusContext { context state targetUrl }
    } }
  } } } }
}`;

// Normalizes a rollup context (Actions CheckRun OR commit StatusContext)
// to { name, state, url } with state ∈ 'pass'|'fail'|'pending'. Returns null if
// the node has no usable name. SKIPPED/NEUTRAL count as non-blocking (like
// the GitHub rollup); a null conclusion = check running → pending. `url` is the
// run page (CheckRun.detailsUrl / StatusContext.targetUrl, null if absent) —
// consumed by the CI popover of the web tables.
const CHECKRUN_FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function normalizeContext(node) {
  if (!node) return null;
  if (node.__typename === 'StatusContext') {
    if (!node.context) return null;
    const s = (node.state || '').toUpperCase();
    const state = s === 'SUCCESS' ? 'pass' : (s === 'FAILURE' || s === 'ERROR') ? 'fail' : 'pending';
    return { name: node.context, state, url: node.targetUrl ?? null };
  }
  // CheckRun (default): conclusion takes precedence, otherwise (null) the check is still running.
  if (!node.name) return null;
  const c = (node.conclusion || '').toUpperCase();
  const state = !c ? 'pending' : CHECKRUN_FAIL.has(c) ? 'fail' : 'pass';
  return { name: node.name, state, url: node.detailsUrl ?? null };
}

// Normalizes a GraphQL PullRequest node to the shape consumed by collect.js.
function normalizePull(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author ? { login: pr.author.login } : null,
    createdAt: pr.createdAt,
    // Date the PR left draft (last ReadyForReviewEvent of the timeline, same
    // request → zero cost); null if the PR was never a draft. Consumed by the
    // easter-egg business-days gate (html.js), which falls back on createdAt.
    readyAt: pr.timelineItems?.nodes?.[0]?.createdAt ?? null,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    isDraft: pr.isDraft,
    state: pr.state,
    // MERGEABLE | CONFLICTING | UNKNOWN. ⚠️ GitHub computes the merge commit
    // LAZILY: right after a push (or on a PR nobody has opened in a while) the
    // first read is UNKNOWN, and the query itself triggers the background
    // computation — the next poll returns the real verdict. Hence only
    // CONFLICTING is treated as a conflict downstream, never « not MERGEABLE »
    // (that would flash a false conflict on every fresh push).
    mergeable: pr.mergeable ?? null,
    branch: pr.headRefName ?? null,
    // repo hosting the head branch (a fork for external PRs; null if deleted).
    branchRepo: pr.headRepository?.nameWithOwner ?? null,
    // base branch + default branch of the base repo: base ≠ default on a PR
    // whose parent is another PR's head → stacked-PR detection (sort.js).
    base: pr.baseRefName ?? null,
    defaultBranch: pr.baseRepository?.defaultBranchRef?.name ?? null,
    // latestOpinionatedReviews = latest APPROVED/CHANGES_REQUESTED review per
    // author (ignores COMMENTED): a comment does not cancel an approval.
    reviews: (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => ({
      author: r.author ? { login: r.author.login } : null,
      state: r.state,
      submittedAt: r.submittedAt,
    })),
    statusCheckRollupState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    // individual normalized checks (for CI recomputation via blocklist + the debug view).
    checks: (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [])
      .map(normalizeContext)
      .filter(Boolean),
  };
}

export function makeGh(runner = defaultRunner) {
  // One GraphQL request per PR batch (aliases p0,p1,… → one repository/pullRequest
  // each). Returns an array aligned with `chunk` (null if PR not found).
  async function graphqlPullChunk(chunk) {
    const aliases = chunk.map(({ repo, number }, i) => {
      const [owner, name] = repo.split('/');
      return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(number)}) { ...pr } }`;
    });
    const query = `query {\n${aliases.join('\n')}\n}\n${PR_FRAGMENT}`;
    const data = parseJson(await runner(['api', 'graphql', '-f', `query=${query}`]))?.data ?? {};
    return chunk.map((_, i) => normalizePull(data[`p${i}`]?.pullRequest));
  }

  // `search/issues` returns **30 results per page by default**: without an
  // explicit loop, any perimeter with more than 30 open PRs silently loses the
  // surplus at every poll. That is not cosmetic — a PR absent from `entries`
  // sees its key pruned from `hidden-v1.json` by `reconcile`, and reappears
  // visible at the next poll that does return it (cf. ARCHITECTURE §10).
  // ⚠️ `gh api --paginate` is NOT usable here: a search response is an *object*,
  // so --paginate emits one concatenated JSON object per page and `parseJson`
  // throws. Hence per_page=100 + page=N, stopping on the first non-full page.
  // The search API caps at 1000 results anyway → 10 pages max.
  async function searchIssues(q) {
    const PER_PAGE = 100;
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const out = parseJson(await runner(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', `per_page=${PER_PAGE}`, '-f', `page=${page}`]));
      const items = out?.items ?? [];
      all.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return all;
  }

  return {
    graphqlPullChunk,
    async getCurrentUser() {
      return parseJson(await runner(['api', 'user'])).login;
    },
    async listNotifications({ all = false } = {}) {
      const args = ['api', '--paginate', '/notifications'];
      if (all) args.push('-f', 'all=true');
      return parseJson(await runner(args)) ?? [];
    },
    async getComment(apiUrl) {
      const path = apiUrl.replace('https://api.github.com', '');
      return parseJson(await runner(['api', path]));
    },
    // `since` (ISO) → only fetches comments created/edited after this
    // point (sort=updated&direction=asc), for the incremental fetching of the
    // inspection cache. Without `since`: full page (per_page=100).
    async getReviewComments(repoFullName, number, { since = null } = {}) {
      const params = new URLSearchParams({ per_page: '100' });
      if (since) {
        params.set('sort', 'updated');
        params.set('direction', 'asc');
        params.set('since', since);
      }
      return parseJson(await runner(['api', '--paginate', `repos/${repoFullName}/pulls/${number}/comments?${params}`])) ?? [];
    },
    // Details of N PRs in a minimum of requests (GraphQL batch, chunks of 30 in
    // parallel). Returns an array aligned with `prs` ([{repo, number}]); null
    // for a PR not found, and null for an entire failed chunk (degradation).
    async getPullDetailsBatch(prs) {
      if (!prs || prs.length === 0) return [];
      const CHUNK = 30;
      const chunks = [];
      for (let i = 0; i < prs.length; i += CHUNK) chunks.push(prs.slice(i, i + CHUNK));
      const results = await Promise.all(
        chunks.map((c) => graphqlPullChunk(c).catch(() => c.map(() => null))),
      );
      return results.flat();
    },
    async searchReviewRequested(qualifier = '') {
      return searchIssues(`is:open is:pr review-requested:@me${qualifier}`);
    },
    async searchAuthored(qualifier = '') {
      return searchIssues(`is:open is:pr author:@me${qualifier}`);
    },
    async currentRepo() {
      try {
        return parseJson(await runner(['repo', 'view', '--json', 'nameWithOwner']))?.nameWithOwner ?? null;
      } catch {
        return null;
      }
    },
    // Watches a repo (GitHub « Watch » → subscribed threads in /notifications),
    // used when enabling a favorite's « all » mode. Best-effort like scopeExists:
    // true on success, null on failure (network, rights…) — NEVER throws, the
    // caller fails open with a warning instead of blocking the toggle.
    async setRepoSubscription(repoFullName) {
      try {
        await runner(['api', '-X', 'PUT', `repos/${repoFullName}/subscription`, '-F', 'subscribed=true']);
        return true;
      } catch {
        return null;
      }
    },
    // Does a favorite scope exist on GitHub? repo → GET /repos/owner/name ;
    // org/user → GET /users/{value} (200 for an org **as well as** for a user).
    // Tri-state: true (exists), false (404 → not found), null (undetermined:
    // network, rate-limit, auth…). The null lets the caller decide (fail-open)
    // instead of wrongly refusing on a transient incident.
    async scopeExists(scope) {
      if (!scope || !scope.value) return null;
      const path = scope.type === 'repo' ? `repos/${scope.value}` : `users/${scope.value}`;
      try {
        await runner(['api', path, '-q', '.id']);
        return true;
      } catch (err) {
        const msg = `${err?.stderr || ''} ${err?.message || ''}`;
        return /HTTP 404|Not Found/i.test(msg) ? false : null;
      }
    },
  };
}
