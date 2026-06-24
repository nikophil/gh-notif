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

export function makeGh(runner = defaultRunner) {
  return {
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
    async getPullDetails(repoFullName, number) {
      return parseJson(await runner([
        'pr', 'view', String(number),
        '--repo', repoFullName,
        '--json', 'number,title,author,createdAt,additions,deletions,statusCheckRollup,state,isDraft,reviews',
      ]));
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
