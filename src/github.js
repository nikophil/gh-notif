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
  number title author { login } createdAt updatedAt additions deletions changedFiles isDraft state mergeable headRefName
  headRepository { nameWithOwner }
  baseRefName baseRepository { defaultBranchRef { name } }
  labels(first: 20) { nodes { name color } }
  files(first: 100) { totalCount pageInfo { hasNextPage } nodes { path additions deletions } }
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
    // GitHub's own changed-file total (Files column) — independent of the
    // 100-file cap of `files` below. null on an older response.
    changedFiles: pr.changedFiles ?? null,
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
    // GitHub labels ({ name, color } — color = 6-digit hex WITHOUT '#'), same
    // request → zero cost. Rendered as GitHub-like chips in the Labels column.
    labels: (pr.labels?.nodes ?? [])
      .filter((l) => l?.name)
      .map((l) => ({ name: l.name, color: l.color ?? null })),
    // Changed files ({ path, additions, deletions }), same request → zero cost.
    // Feeds the per-type diff popover. `files` is capped at one page of 100:
    // `moreFiles` counts what the page left out (0 for the usual PR).
    files: (pr.files?.nodes ?? []).filter((f) => f?.path)
      .map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    moreFiles: pr.files?.pageInfo?.hasNextPage
      ? Math.max(0, (pr.files.totalCount ?? 0) - (pr.files.nodes?.length ?? 0)) : 0,
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

// Stale-stack signals (ARCHITECTURE §31), fetched for the CONFLICTING PRs
// only (a second, small batch — 100 commits × their associated PRs per PR
// would weigh on the main batch for nothing). `history` = the PR's own commit
// list (base..head; aliased: `commits` is already used for the CI rollup).
// `baseRef.associatedPullRequests` = the open PR whose HEAD is our base
// branch (the parent of a stack; null on main / a deleted branch), and its
// force-push events give the old heads it left behind.
const STALE_FRAGMENT = `fragment stale on PullRequest {
  history: commits(first: 100) { nodes { commit { oid associatedPullRequests(first: 5) { nodes { number state } } } } }
  baseRef { associatedPullRequests(first: 1, states: OPEN) { nodes {
    timelineItems(itemTypes: HEAD_REF_FORCE_PUSHED_EVENT, last: 20) { nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } } }
  } } }
}`;

// Reviewers removed at a draft conversion (§30, `markReady`): the timeline
// keeps one ReviewRequestRemovedEvent per reviewer (user or team) next to the
// ConvertToDraftEvent that triggered them.
const DRAFT_REMOVALS_FRAGMENT = `fragment removals on PullRequest {
  timelineItems(itemTypes: [CONVERT_TO_DRAFT_EVENT, REVIEW_REQUEST_REMOVED_EVENT], last: 50) { nodes {
    __typename
    ... on ConvertToDraftEvent { createdAt }
    ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { slug } } }
  } }
}`;

function normalizeStale(pr) {
  if (!pr) return null;
  return {
    commits: (pr.history?.nodes ?? []).map((n) => ({
      oid: n.commit.oid,
      prs: (n.commit.associatedPullRequests?.nodes ?? []).map((p) => ({ number: p.number, state: p.state })),
    })),
    parentForcePushed: (pr.baseRef?.associatedPullRequests?.nodes?.[0]?.timelineItems?.nodes ?? [])
      .map((e) => e?.beforeCommit?.oid)
      .filter(Boolean),
  };
}

// `onError(err, args)`: called for EVERY failed `gh` call before the error is
// thrown (§35) — so an error the caller swallows (a degraded GraphQL chunk, a
// failed inspection) is still journaled. The error carries `ghCode`
// (`GH-<OP>`, the exact call site below), shown in every error surface.
export function makeGh(runner = defaultRunner, { onError = () => {} } = {}) {
  const run = async (op, args) => {
    try {
      return await runner(args);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.ghCode = `GH-${op}`;
      onError(e, args);
      throw e;
    }
  };
  // One GraphQL request per PR batch (aliases p0,p1,… → one repository/pullRequest
  // each, spreading `fragment` — `...pr` by default). Returns an array aligned
  // with `chunk` (null if PR not found), each node passed through `normalize`.
  async function graphqlPullChunk(chunk, { fragment = PR_FRAGMENT, spread = 'pr', normalize = normalizePull } = {}) {
    const aliases = chunk.map(({ repo, number }, i) => {
      const [owner, name] = repo.split('/');
      return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(number)}) { ...${spread} } }`;
    });
    const query = `query {\n${aliases.join('\n')}\n}\n${fragment}`;
    const data = parseJson(await run('GRAPHQL', ['api', 'graphql', '-f', `query=${query}`]))?.data ?? {};
    return chunk.map((_, i) => normalize(data[`p${i}`]?.pullRequest));
  }

  // Chunks of 30 in parallel; a failed chunk degrades to nulls (never throws).
  async function batched(prs, opts) {
    if (!prs || prs.length === 0) return [];
    const CHUNK = 30;
    const chunks = [];
    for (let i = 0; i < prs.length; i += CHUNK) chunks.push(prs.slice(i, i + CHUNK));
    const results = await Promise.all(
      chunks.map((c) => graphqlPullChunk(c, opts).catch(() => c.map(() => null))),
    );
    return results.flat();
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
  const PER_PAGE = 100;
  async function searchPage(q, page, extra = []) {
    return parseJson(await run('SEARCH', ['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', `per_page=${PER_PAGE}`, '-f', `page=${page}`, ...extra]));
  }
  // ⚠️ A wide query (union of favorites) can time out INSIDE GitHub: the
  // response is then a PARTIAL item list with `incomplete_results: true` and
  // no HTTP error (measured: 6 items for a total_count of 26 — and total_count
  // itself fluctuates, so a truncated response can look self-consistent). Two
  // signals for collectPRs (§10): items < total_count → throws `err.incomplete`
  // with the partial items attached; otherwise the array carries a
  // non-enumerable `incomplete` flag (the response is not authoritative —
  // absence from it proves nothing).
  async function searchIssues(q) {
    const all = [];
    let total = 0;
    let incomplete = false;
    for (let page = 1; page <= 10; page++) {
      const out = await searchPage(q, page);
      total = out?.total_count ?? 0;
      incomplete ||= !!out?.incomplete_results;
      const items = out?.items ?? [];
      all.push(...items);
      if (items.length < PER_PAGE) break;
    }
    if (incomplete && all.length < total) {
      const err = new Error(`incomplete search results (${all.length}/${total})`);
      err.incomplete = true;
      err.items = all;
      throw err;
    }
    if (incomplete) Object.defineProperty(all, 'incomplete', { value: true });
    return all;
  }

  return {
    graphqlPullChunk,
    async getCurrentUser() {
      return parseJson(await run('USER', ['api', 'user'])).login;
    },
    async listNotifications({ all = false } = {}) {
      const args = ['api', '--paginate', '/notifications'];
      if (all) args.push('-f', 'all=true');
      return parseJson(await run('NOTIFS', args)) ?? [];
    },
    // Auto-purge (ARCHITECTURE §22): marks a notification thread as read
    // (205 No Content — nothing to parse).
    async markThreadRead(threadId) {
      await run('MARK_READ', ['api', '-X', 'PATCH', `notifications/threads/${threadId}`]);
    },
    // Age purge (ARCHITECTURE §22): GitHub marks read, server-side, every
    // notification updated before `iso` — one request whatever the count.
    async markReadBefore(iso) {
      await run('MARK_READ_BEFORE', ['api', '-X', 'PUT', '/notifications', '-f', `last_read_at=${iso}`, '-F', 'read=true']);
    },
    async getComment(apiUrl) {
      const path = apiUrl.replace('https://api.github.com', '');
      return parseJson(await run('COMMENT', ['api', path]));
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
      return parseJson(await run('REVIEW_COMMENTS', ['api', '--paginate', `repos/${repoFullName}/pulls/${number}/comments?${params}`])) ?? [];
    },
    // Details of N PRs in a minimum of requests (GraphQL batch, chunks of 30 in
    // parallel). Returns an array aligned with `prs` ([{repo, number}]); null
    // for a PR not found, and null for an entire failed chunk (degradation).
    async getPullDetailsBatch(prs) {
      return batched(prs);
    },
    // Stale-stack signals (§31) of N PRs — same batching, `stale` fragment.
    // Aligned with `prs`; null for a PR not found or a failed chunk.
    async getStaleSignals(prs) {
      return batched(prs, { fragment: STALE_FRAGMENT, spread: 'stale', normalize: normalizeStale });
    },
    async searchReviewRequested(qualifier = '') {
      return searchIssues(`is:open is:pr review-requested:@me${qualifier}`);
    },
    async searchAuthored(qualifier = '') {
      return searchIssues(`is:open is:pr author:@me${qualifier}`);
    },
    // Search page (§29): free query → the `max` most recently UPDATED matches
    // (GitHub-side order; our own sort applies downstream on that capped set)
    // + GitHub's total_count, so the page can say « 200 of 1234 ».
    async searchPRs(q, { max = 200 } = {}) {
      const items = [];
      let total = 0;
      for (let page = 1; items.length < max && page <= 10; page++) {
        const out = await searchPage(q, page, ['-f', 'sort=updated', '-f', 'order=desc']);
        total = out?.total_count ?? 0;
        const got = out?.items ?? [];
        items.push(...got);
        if (got.length < PER_PAGE) break;
      }
      return { items: items.slice(0, max), total };
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
        await run('SUBSCRIBE', ['api', '-X', 'PUT', `repos/${repoFullName}/subscription`, '-F', 'subscribed=true']);
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
        await run('SCOPE_EXISTS', ['api', path, '-q', '.id']);
        return true;
      } catch (err) {
        const msg = `${err?.stderr || ''} ${err?.message || ''}`;
        return /HTTP 404|Not Found/i.test(msg) ? false : null;
      }
    },
    // Dashboard toggle on my PRs (ARCHITECTURE §30): draft → « ready for
    // review », then re-requests the reviewers `convertToDraft` removed. No
    // local state: they are read from the timeline (the ReviewRequestRemovedEvent
    // items after the last ConvertToDraftEvent), so a server restart between
    // the two clicks loses nothing. A failure throws with gh's message
    // (surfaced by the server as a 400).
    async markReady(repoFullName, number) {
      await run('PR_READY', ['pr', 'ready', String(number), '--repo', repoFullName]);
      const [items] = await graphqlPullChunk([{ repo: repoFullName, number }], {
        fragment: DRAFT_REMOVALS_FRAGMENT, spread: 'removals', normalize: (pr) => pr?.timelineItems?.nodes ?? [],
      });
      const lastDraft = items.findLast((i) => i.__typename === 'ConvertToDraftEvent');
      const removed = lastDraft ? items.filter((i) => i.__typename === 'ReviewRequestRemovedEvent' && i.createdAt >= lastDraft.createdAt) : [];
      const users = new Set(removed.map((i) => i.requestedReviewer?.login).filter(Boolean));
      const teams = new Set(removed.map((i) => i.requestedReviewer?.slug).filter(Boolean));
      const fields = [...[...users].map((u) => `reviewers[]=${u}`), ...[...teams].map((t) => `team_reviewers[]=${t}`)];
      if (fields.length) {
        const path = `repos/${repoFullName}/pulls/${number}/requested_reviewers`;
        await run('REQUEST_REVIEWERS', ['api', '-X', 'POST', path, ...fields.flatMap((f) => ['-f', f])]);
      }
    },
    // « ready » → draft. ⚠️ GitHub keeps the requested reviewers on a draft
    // (docs: nobody is unsubscribed by the conversion), so they are removed
    // explicitly — users AND teams — through the REST endpoint. No DELETE
    // when nobody is requested.
    async convertToDraft(repoFullName, number) {
      await run('PR_DRAFT', ['pr', 'ready', '--undo', String(number), '--repo', repoFullName]);
      const path = `repos/${repoFullName}/pulls/${number}/requested_reviewers`;
      const req = parseJson(await run('REVIEWERS', ['api', path])) ?? {};
      const fields = [
        ...(req.users ?? []).map((u) => `reviewers[]=${u.login}`),
        ...(req.teams ?? []).map((t) => `team_reviewers[]=${t.slug}`),
      ];
      if (fields.length) await run('REMOVE_REVIEWERS', ['api', '-X', 'DELETE', path, ...fields.flatMap((f) => ['-f', f])]);
    },
  };
}
