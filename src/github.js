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
  number title author { login } createdAt additions deletions isDraft state
  latestOpinionatedReviews(first: 100) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name conclusion status }
      ... on StatusContext { context state }
    } }
  } } } }
}`;

// Normalizes a rollup context (Actions CheckRun OR commit StatusContext)
// to { name, state } with state ∈ 'pass'|'fail'|'pending'. Returns null if the
// node has no usable name. SKIPPED/NEUTRAL count as non-blocking (like
// the GitHub rollup); a null conclusion = check running → pending.
const CHECKRUN_FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function normalizeContext(node) {
  if (!node) return null;
  if (node.__typename === 'StatusContext') {
    if (!node.context) return null;
    const s = (node.state || '').toUpperCase();
    const state = s === 'SUCCESS' ? 'pass' : (s === 'FAILURE' || s === 'ERROR') ? 'fail' : 'pending';
    return { name: node.context, state };
  }
  // CheckRun (default): conclusion takes precedence, otherwise (null) the check is still running.
  if (!node.name) return null;
  const c = (node.conclusion || '').toUpperCase();
  const state = !c ? 'pending' : CHECKRUN_FAIL.has(c) ? 'fail' : 'pass';
  return { name: node.name, state };
}

// Normalizes a GraphQL PullRequest node to the shape consumed by collect.js.
function normalizePull(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author ? { login: pr.author.login } : null,
    createdAt: pr.createdAt,
    additions: pr.additions,
    deletions: pr.deletions,
    isDraft: pr.isDraft,
    state: pr.state,
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
      const out = parseJson(await runner(['api', '-X', 'GET', 'search/issues', '-f', `q=is:open is:pr review-requested:@me${qualifier}`]));
      return out?.items ?? [];
    },
    async searchAuthored(qualifier = '') {
      const out = parseJson(await runner(['api', '-X', 'GET', 'search/issues', '-f', `q=is:open is:pr author:@me${qualifier}`]));
      return out?.items ?? [];
    },
    async currentRepo() {
      try {
        return parseJson(await runner(['repo', 'view', '--json', 'nameWithOwner']))?.nameWithOwner ?? null;
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
