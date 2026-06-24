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

// Champs PR récupérés en une fois via GraphQL (cf. getPullDetailsBatch).
const PR_FRAGMENT = `fragment pr on PullRequest {
  number title author { login } createdAt additions deletions isDraft state
  latestOpinionatedReviews(first: 100) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

// Normalise un nœud PullRequest GraphQL vers la forme consommée par collect.js.
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
    // latestOpinionatedReviews = dernière review APPROVED/CHANGES_REQUESTED par
    // auteur (ignore les COMMENTED) : un commentaire n'annule pas une approbation.
    reviews: (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => ({
      author: r.author ? { login: r.author.login } : null,
      state: r.state,
      submittedAt: r.submittedAt,
    })),
    statusCheckRollupState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}

export function makeGh(runner = defaultRunner) {
  // Une requête GraphQL par lot de PR (alias p0,p1,… → un repository/pullRequest
  // chacun). Renvoie un tableau aligné sur `chunk` (null si PR introuvable).
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
    async getReviewComments(repoFullName, number) {
      return parseJson(await runner(['api', '--paginate', `repos/${repoFullName}/pulls/${number}/comments`])) ?? [];
    },
    // Détails de N PR en un minimum de requêtes (GraphQL batch, chunks de 30 en
    // parallèle). Renvoie un tableau aligné sur `prs` ([{repo, number}]) ; null
    // pour une PR introuvable, et null pour tout un chunk en échec (dégradation).
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
  };
}
