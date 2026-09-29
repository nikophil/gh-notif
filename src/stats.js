// Stats page (ARCHITECTURE §40): review ratio, medians, monthly activity —
// mine and, when a scope is set, the team's, over a sliding year.
//
// ⚠️ Never in the poll (same lesson as §29): collected on demand when /stats
// is opened, and cached PER MONTH on disk. A month that is over never changes
// (a merged PR stays merged in its month), so once fetched it is final: after
// the first visit only the current month is refetched. The first collection
// of a big scope is long (a busy org: ~3500 PRs/year, ~140 pages of 25) — the page
// shows its progress.
//
// Dataset = the MERGED PRs of each month:
// - with a scope: every merged PR of the scope (mine included) → my numbers
//   AND the team's (medians, everyone's ratio);
// - without a scope (all of GitHub): only mine + the ones I reviewed — « every
//   merged PR on GitHub » is not a dataset. No team numbers then.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { scopesQualifier, toScopeList, mapLimit } from './collect.js';

const DAY = 86400000;
// Window = the current month + the 11 before: 12 whole buckets, so the page
// can always say « x/12 » (a sliding 365 days would straddle 13 months).
export const STATS_MONTHS = 12;
// The current month is refetched after this; a past month is final once
// fetched a day after its end (GitHub's search index lags a little).
export const STATS_TTL_MS = 6 * 3600000;
const FINAL_GRACE_MS = DAY;
// Search API cap: a range with more results is split in two (by days).
const SEARCH_CAP = 1000;
// Page size: 40 stays under GitHub's ~10 s timeout most of the time (§40); a
// failed page is retried at half the size, down to MIN_PAGE, and the smaller
// size sticks for the rest of the collection (GitHub is slow right now).
export const PAGE = 40;
const MIN_PAGE = 5;
// Months fetched in parallel: the throughput lever (page size barely is — the
// cost is per PR). 4 stays far from the secondary rate limit.
export const CONCURRENCY = 4;
// People with fewer merged PRs than this get no ratio (1 review / 1 merge
// is not a habit) — they are left out of the team median and the rank.
export const MIN_MERGED_FOR_RATIO = 3;

// ~/.local/state/gh-notif/stats-v1/<hash>.json — one file per (me, scope).
export function statsPath(me, scopes) {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const hash = createHash('sha1').update(`${me}|${scopesQualifier(scopes)}`).digest('hex').slice(0, 16);
  return join(base, 'gh-notif', 'stats-v1', `${hash}.json`);
}

export function loadStatsCache(path) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return c && typeof c.months === 'object' && c.months ? c : { months: {} };
  } catch {
    return { months: {} };
  }
}

export function saveStatsCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache));
}

// 'YYYY-MM' keys (UTC), oldest first: the current month and the 11 before.
export function monthKeys(now) {
  const end = new Date(now);
  const keys = [];
  for (let i = STATS_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

// Periods of the page's dropdown: 'last12' (default) or a calendar year
// 'YYYY' — its months up to the current one. Every period is made of the same
// month buckets, so a year shares its cache with « last 12 months ».
export const DEFAULT_PERIOD = 'last12';
export function periodKeys(period, now) {
  if (!/^\d{4}$/.test(period ?? '')) return monthKeys(now);
  const y = Number(period);
  const end = new Date(now);
  const last = y < end.getUTCFullYear() ? 11 : end.getUTCMonth();
  return Array.from({ length: last + 1 }, (_, m) => `${y}-${String(m + 1).padStart(2, '0')}`);
}
// Dropdown entries: last 12 months, then each year from the current one down
// to the year of my first PR / review in the scope (unknown yet → the current
// year only).
export function periodOptions(firstYear, now) {
  const cur = new Date(now).getUTCFullYear();
  const from = Number.isInteger(firstYear) && firstYear <= cur ? firstYear : cur;
  const years = [];
  for (let y = cur; y >= from; y--) years.push(String(y));
  return [DEFAULT_PERIOD, ...years];
}
export function isValidPeriod(period, now) {
  return period === DEFAULT_PERIOD || (/^\d{4}$/.test(period) && Number(period) >= 2008 && Number(period) <= new Date(now).getUTCFullYear());
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthStart = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
const nextMonthStart = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1);

// Inclusive date range of a month, for `merged:FROM..TO`.
export function monthRange(key) {
  return [ymd(monthStart(key)), ymd(nextMonthStart(key) - DAY)];
}

export function isMonthFinal(key, fetchedAt) {
  return !!fetchedAt && fetchedAt >= nextMonthStart(key) + FINAL_GRACE_MS;
}

// Does this month need a (re)fetch? Final → never; otherwise missing, or older
// than the TTL, or `force` (🔄) for a non-final month.
// Version of the stored PR record: 2 added the review verdicts (`rv[i][2]`),
// the first reviews list (`frs`) and the review event count (`ev`). A bucket
// of another version is refetched (once).
export const SCHEMA = 2;

// A bucket without `count` predates the completeness check (§40), an
// `incomplete` one lost PRs to a truncated search, an old `schema` lacks
// fields: all refetched.
export function needsFetch(bucket, key, now, { force = false } = {}) {
  if (!bucket || bucket.count == null || bucket.incomplete || bucket.schema !== SCHEMA) return true;
  if (isMonthFinal(key, bucket.fetchedAt)) return false;
  return force || now - bucket.fetchedAt > STATS_TTL_MS;
}

// The unmerged bucket of a CREATION month (closed without merge + still open).
// Unlike a merged month it is never final while it holds an open PR — that PR
// can still be merged or closed; refetched with the TTL like the current month.
export function needsFetchUnmerged(bucket, key, now, { force = false } = {}) {
  if (!bucket || bucket.incomplete) return true;
  if (isMonthFinal(key, bucket.fetchedAt) && !bucket.prs.some((pr) => pr.open)) return false;
  return force || now - bucket.fetchedAt > STATS_TTL_MS;
}

// Unmerged dataset: with a scope every unmerged PR of it; without, mine only
// (others' abandoned PRs I reviewed tell nothing about me).
export function unmergedQueries(scopes) {
  return toScopeList(scopes) ? [scopesQualifier(scopes).trim()] : ['author:@me'];
}

// Search qualifiers of a month's dataset, WITHOUT the `merged:` range (added
// per range, a range may be split). One query with a scope; two without (mine
// + the ones I reviewed — disjoint thanks to -author:@me).
export function datasetQueries(scopes) {
  if (!toScopeList(scopes)) return ['author:@me', 'reviewed-by:@me -author:@me'];
  return [scopesQualifier(scopes).trim()];
}

// Halves an inclusive YYYY-MM-DD range; null when it is a single day.
export function splitRange(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (a >= b) return null;
  const mid = a + Math.floor((b - a) / DAY / 2) * DAY;
  return [[from, ymd(mid)], [ymd(mid + DAY), to]];
}

const isBot = (author) => !author || author.__typename === 'Bot' || /\[bot\]$/.test(author.login ?? '');

// GraphQL node → compact record stored on disk (a year of a big org stays a
// few hundred KB). Bots are dropped from the reviewers, the PR keeps a `bot`
// flag (excluded from the team numbers, not from my ratio — consistent with
// the §38 pill, whose search does count them).
export function compactPR(n) {
  if (!n?.mergedAt || !n.repository) return null;
  const author = n.author?.login ?? null;
  // [login, submittedAt, state] — the latest review of each reviewer, i.e.
  // their verdict on the PR (APPROVED / CHANGES_REQUESTED / COMMENTED…).
  const reviewers = [];
  for (const r of n.latestReviews?.nodes ?? []) {
    if (isBot(r.author) || r.author.login === author) continue;
    if (!reviewers.some(([l]) => l === r.author.login)) reviewers.push([r.author.login, r.submittedAt ?? null, r.state ?? null]);
  }
  // The first reviews [login, submittedAt], oldest first: the first review
  // time is computed at display, so an ignored account (automated reviewer)
  // can be skipped without refetching.
  const firsts = (n.firstReviews?.nodes ?? [])
    .filter((r) => !isBot(r.author) && r.author.login !== author && r.submittedAt)
    .map((r) => [r.author.login, r.submittedAt])
    .sort((a, b) => a[1].localeCompare(b[1]));
  return {
    repo: n.repository.nameWithOwner,
    n: n.number,
    a: author,
    bot: isBot(n.author),
    c: n.createdAt,
    rd: n.ready?.nodes?.[0]?.createdAt ?? null,
    m: n.mergedAt,
    add: n.additions ?? 0,
    del: n.deletions ?? 0,
    frs: firsts,
    rv: reviewers,
    ev: n.reviewEvents?.totalCount ?? null,
  };
}

// Unmerged PR node → { repo, n, a, bot, c (created), cl (closed, null if
// open), open, add, del }.
export function compactUnmerged(n) {
  if (!n?.repository || n.mergedAt) return null;
  return {
    repo: n.repository.nameWithOwner,
    n: n.number,
    a: n.author?.login ?? null,
    bot: isBot(n.author),
    c: n.createdAt,
    cl: n.closedAt ?? null,
    open: n.state === 'OPEN',
    add: n.additions ?? 0,
    del: n.deletions ?? 0,
  };
}

// Every PR of `<field>:from..to <qualifier>` (merged dataset: `is:pr merged:`;
// unmerged: `is:pr is:unmerged created:`), as a Map keyed repo#n.
// ⚠️ GitHub truncates a slow search SILENTLY (§10): a page simply says there
// is no next page, the lost PRs never show up — measured: 200 of 339 for a
// month, then 339/339 on a replay. So the result is checked against the
// range's issueCount; if short, the range is refetched in two halves
// (smaller searches time out less), down to one day, a day retried once.
// Returns { prs, count, short }. `ctx` = { size } shared by the whole
// collection (a halved page size sticks); `hooks.onTotal(n)` for the
// top-level range, `hooks.onPrs(map)` after every page.
async function fetchRange(src, qualifier, from, to, ctx, hooks = {}, depth = 0) {
  const q = `${src.prefix}${from}..${to} ${qualifier}`.trim();
  const out = new Map();
  let count = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let after = null;
    for (;;) {
      let page;
      try {
        page = await src.search(q, { first: ctx.size, after });
      } catch (err) {
        if (ctx.size <= MIN_PAGE) throw err;
        ctx.size = Math.max(MIN_PAGE, Math.floor(ctx.size / 2));
        continue;
      }
      if (!after) {
        count = Math.max(count, page.issueCount ?? 0);
        if (depth === 0 && attempt === 0) hooks.onTotal?.(count);
      }
      if (!after && count > SEARCH_CAP) break; // too big to page through: halves below
      for (const node of page.nodes ?? []) {
        const pr = src.compact(node);
        if (pr) out.set(`${pr.repo}#${pr.n}`, pr);
      }
      hooks.onPrs?.(out);
      if (!page.pageInfo?.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    if (out.size >= count) return { prs: out, count, short: false };
    const halves = splitRange(from, to);
    if (halves) {
      for (const [f, t] of halves) {
        const sub = await fetchRange(src, qualifier, f, t, ctx, { onPrs: (m) => { for (const [k, v] of m) out.set(k, v); hooks.onPrs?.(out); } }, depth + 1);
        for (const [k, v] of sub.prs) out.set(k, v);
      }
      return { prs: out, count, short: out.size < count };
    }
    // One day still short: one more pass (the loop), then accept.
  }
  return { prs: out, count, short: out.size < count };
}

// Per-month progress for the page: every month of the window, whether it is
// served from the cache or being fetched. `done` counts both (« x/12 »).
function progressOf(keys, cache, live) {
  const months = keys.map((key) => live.get(key) ?? { key, state: cache.months[key] ? 'cached' : 'pending', fetched: 0, total: null });
  return { done: months.filter((m) => ['cached', 'done', 'short'].includes(m.state)).length, total: keys.length, months };
}

// Fills `cache.months` with the months that need it (mutates `cache`, prunes
// the months out of the window). Returns the errors (a failed month keeps its
// previous bucket, if any — never a hole instead of old data).
// `onProgress({ done, total, months: [{ key, state, fetched, total }] })` after
// every page; `state` ∈ cached | pending | running | done | short | error
// (short = still missing PRs after the retries, refetched next visit), `total` =
// the month's PR count once its first page answered. `monthDone` = the month
// just completed (the caller saves the cache then).
export async function collectStats(gh, scopes, cache, { now = Date.now(), keys = monthKeys(now), force = false, concurrency = CONCURRENCY, onProgress = () => {}, clock = Date.now } = {}) {
  cache.unmerged ??= {};
  const merged = { prefix: 'is:pr merged:', search: (q, o) => gh.searchMergedPRs(q, o), compact: compactPR };
  // Older stubs / callers without the unmerged search: merged dataset only.
  const withUnmerged = typeof gh.searchUnmergedPRs === 'function';
  const unmerged = { prefix: 'is:pr is:unmerged created:', search: (q, o) => gh.searchUnmergedPRs(q, o), compact: compactUnmerged };
  const needM = (k) => needsFetch(cache.months[k], k, now, { force });
  const needU = (k) => withUnmerged && needsFetchUnmerged(cache.unmerged[k], k, now, { force });
  const todo = keys.filter((k) => needM(k) || needU(k));
  const errors = [];
  const live = new Map(todo.map((key) => [key, { key, state: 'pending', fetched: 0, total: null }]));
  const report = (monthDone = null) => onProgress({ ...progressOf(keys, cache, live), monthDone });
  const ctx = { size: PAGE };
  report();
  await mapLimit(todo, concurrency, async (key) => {
    const p = live.get(key);
    p.state = 'running';
    report();
    try {
      const [from, to] = monthRange(key);
      // One dataset of the month (merged, or unmerged) → its bucket. The
      // progress bar sums both datasets.
      let fetched = 0;
      const fill = async (src, queries) => {
        const seen = new Map();
        let count = 0;
        let short = false;
        for (const qualifier of queries) {
          const base = fetched + seen.size;
          const r = await fetchRange(src, qualifier, from, to, ctx, {
            onTotal: (n) => { p.total = (p.total ?? 0) + n; report(); },
            onPrs: (m) => { p.fetched = base + m.size; report(); },
          });
          for (const [k, v] of r.prs) seen.set(k, v);
          count += r.count;
          short ||= r.short;
        }
        fetched += seen.size;
        return { fetchedAt: clock(), count, schema: SCHEMA, ...(short ? { incomplete: true } : {}), prs: [...seen.values()] };
      };
      let short = false;
      if (needM(key)) {
        cache.months[key] = await fill(merged, datasetQueries(scopes));
        short ||= !!cache.months[key].incomplete;
      }
      if (needU(key)) {
        cache.unmerged[key] = await fill(unmerged, unmergedQueries(scopes));
        short ||= !!cache.unmerged[key].incomplete;
      }
      p.fetched = fetched;
      p.state = short ? 'short' : 'done';
    } catch (err) {
      errors.push(err);
      p.state = 'error';
    }
    report(key);
  });
  // No pruning: an older month serves the year views (and never changes).
  if (needsFirstYear(cache, now)) {
    cache.myFirstYearAt = clock();
    try { cache.myFirstYear = await firstPRYear(gh, scopes); } catch { /* retried after a day */ }
  }
  return errors;
}

// The dropdown's lower bound is unknown (never looked up, or the lookup found
// nothing / failed more than a day ago). Checked on its own, not only after a
// month fetch — a cache whose months are all fresh never ran the lookup and the
// dropdown stayed stuck on the current year (real bug).
// `myFirstYear` (not `firstYear`): a first version stored the SCOPE's first
// PR (zorg/* → 2015 while I only arrived in 2021) — a new name so those
// values are not reused.
export function needsFirstYear(cache, now) {
  return cache.myFirstYear == null && (!cache.myFirstYearAt || now - cache.myFirstYearAt > DAY);
}

// Year of MY first activity in the scope (dropdown lower bound): the older of
// my first merged PR and my first review there — a year before that has no
// ratio, rank or heatmap of mine, nothing to show. Merged PRs only, sorted by
// creation, one tiny search each. null when I never did either.
export async function firstPRYear(gh, scopes) {
  const qualifier = toScopeList(scopes) ? ` ${scopesQualifier(scopes).trim()}` : '';
  let year = null;
  for (const me of ['author:@me', 'reviewed-by:@me']) {
    const page = await gh.searchMergedPRs(`is:pr is:merged ${me}${qualifier} sort:created-asc`, { first: 1 });
    const c = page.nodes?.[0]?.createdAt;
    if (c) year = Math.min(year ?? Infinity, Number(c.slice(0, 4)));
  }
  return year;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const basisOf = (pr) => Date.parse(pr.rd ?? pr.c);

// Standard competition rank (1 + how many are strictly ahead; ties share a
// rank) of `me` in a Map login → value, higher first. null when absent.
export function rankOf(values, me) {
  if (!values.has(me)) return null;
  const mine = values.get(me);
  return 1 + [...values.values()].filter((v) => v > mine).length;
}

// q-quantile (nearest rank) of the finite values; null when none.
export function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}
const mean = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const monthOf = (iso) => iso.slice(0, 7);

// An account whose reviews are nearly all plain comments, in volume, looks
// automated (an AI reviewer posting on a human account — real case): the page
// suggests ignoring it.
export const AUTOMATED_MIN_REVIEWS = 30;
export const AUTOMATED_COMMENT_SHARE = 0.9;

// Everything the page shows, from the cached months. Pure.
// `keys` = the period's months (periodKeys); `month` (one of them, optional)
// narrows the tiles, ranks, repos, tables and heatmap focus to that month —
// the per-month charts always span the whole period.
// `waiting` = the PRs currently waiting for my review (dashboard snapshot,
// already scope-filtered by the caller): [{ readyAt, createdAt }].
// Filters (§40): `ignored` = accounts whose reviews do not count (automated
// reviewers, bot-like users) unless `includeIgnored`; `teamMembers` = logins of a
// GitHub team — only their PRs and their reviews count (me always kept, so my
// own numbers stay meaningful).
export function computeStats(cache, me, {
  now = Date.now(), keys = monthKeys(now), month = null, scoped = false, waiting = [],
  ignored = [], includeIgnored = false, teamMembers = null,
} = {}) {
  const drop = new Set(includeIgnored ? [] : ignored);
  const members = teamMembers ? new Set(teamMembers) : null;
  const keepReviewer = (l) => !drop.has(l) && (!members || members.has(l) || l === me);
  const keepAuthor = (a) => !members || members.has(a) || a === me;
  // Filtered copy of a record: reviews of dropped / non-member accounts
  // removed, first review recomputed from what remains (`fr` = v1 records).
  const clean = (pr) => ({
    ...pr,
    rv: pr.rv.filter(([l]) => keepReviewer(l)),
    fr: pr.frs ? (pr.frs.find(([l]) => keepReviewer(l))?.[1] ?? null) : pr.fr ?? null,
  });

  const inPeriod = new Set(keys);
  const focus = month && inPeriod.has(month) ? month : null;
  const inScope = (iso) => (focus ? monthOf(iso) === focus : inPeriod.has(monthOf(iso)));

  // Every cached merged PR (any month: a PR created in the period may be
  // merged after it), filtered; `all` = merged in the period, `prs` = focus.
  const byKey = new Map();
  for (const b of Object.values(cache.months ?? {})) for (const pr of b.prs ?? []) byKey.set(`${pr.repo}#${pr.n}`, pr);
  const raw = [...byKey.values()].filter((pr) => keepAuthor(pr.a));
  const everMerged = raw.map(clean);
  const all = everMerged.filter((pr) => inPeriod.has(monthOf(pr.m)));
  const prs = focus ? all.filter((pr) => monthOf(pr.m) === focus) : all;
  const unmergedAll = keys.flatMap((k) => cache.unmerged?.[k]?.prs ?? []).filter((pr) => keepAuthor(pr.a));

  const isMine = (pr) => pr.a === me;
  const iReviewed = (pr) => pr.a !== me && pr.rv.some(([l]) => l === me);
  const mine = prs.filter(isMine);
  const reviewedByMe = prs.filter(iReviewed);

  // Durations: from « ready for review » (creation if never a draft) to the
  // merge / to the first review by someone else (0 when reviewed while draft).
  const ttmOf = (pr) => Date.parse(pr.m) - basisOf(pr);
  const ttfrOf = (pr) => (pr.fr ? Math.max(0, Date.parse(pr.fr) - basisOf(pr)) : null);
  const ttm = (list) => median(list.map(ttmOf).filter((d) => d >= 0));
  const ttfr = (list) => median(list.map(ttfrOf));
  const human = prs.filter((pr) => !pr.bot);

  let team = null;
  if (scoped) {
    const merged = new Map();
    const reviewed = new Map();
    for (const pr of human) merged.set(pr.a, (merged.get(pr.a) ?? 0) + 1);
    for (const pr of prs) for (const [l] of pr.rv) reviewed.set(l, (reviewed.get(l) ?? 0) + 1);
    const ratios = new Map(
      [...merged].filter(([, n]) => n >= MIN_MERGED_FOR_RATIO).map(([login, n]) => [login, (reviewed.get(login) ?? 0) / n]),
    );
    team = {
      medianRatio: median([...ratios.values()]),
      // Ranks: ratio among the people with ≥ MIN_MERGED_FOR_RATIO merged PRs;
      // reviews among everyone who reviewed; merged among every human author.
      ratio: { rank: rankOf(ratios, me), of: ratios.size },
      reviews: { rank: rankOf(reviewed, me), of: reviewed.size },
      merged: { rank: rankOf(merged, me), of: merged.size },
      ttm: ttm(human),
      ttfr: ttfr(human),
      prs: human.length,
    };
  }

  const months = keys.map((key) => {
    const inMonth = all.filter((pr) => monthOf(pr.m) === key);
    return { key, merged: inMonth.filter(isMine).length, reviewed: inMonth.filter(iReviewed).length };
  });

  // Days I reviewed: the date of MY review on each PR of the period (latest
  // one, per `latestReviews`) — the whole period, the page dims the rest when
  // a month is focused.
  const days = {};
  for (const pr of all.filter(iReviewed)) {
    const at = pr.rv.find(([l]) => l === me)?.[1];
    if (at) days[at.slice(0, 10)] = (days[at.slice(0, 10)] ?? 0) + 1;
  }

  const repoMap = new Map();
  const bump = (repo, k) => {
    const r = repoMap.get(repo) ?? { repo, reviewed: 0, merged: 0 };
    r[k]++;
    repoMap.set(repo, r);
  };
  for (const pr of mine) bump(pr.repo, 'merged');
  for (const pr of reviewedByMe) bump(pr.repo, 'reviewed');
  const repos = [...repoMap.values()]
    .sort((a, b) => (b.reviewed + b.merged) - (a.reviewed + a.merged) || a.repo.localeCompare(b.repo));

  const ageOf = (r) => now - Date.parse(r.readyAt ?? r.createdAt);
  const ages = waiting.map(ageOf).filter(Number.isFinite);

  // Reciprocity: who reviewed my PRs, whose PRs I reviewed — per person.
  const pairs = new Map();
  const pair = (login) => pairs.get(login) ?? pairs.set(login, { login, theyReviewedMine: 0, iReviewedTheirs: 0 }).get(login);
  for (const pr of mine) for (const [l] of pr.rv) pair(l).theyReviewedMine++;
  for (const pr of reviewedByMe) if (pr.a && !pr.bot) pair(pr.a).iReviewedTheirs++;
  const reciprocity = [...pairs.values()]
    .sort((a, b) => (b.theyReviewedMine + b.iReviewedTheirs) - (a.theyReviewedMine + a.iReviewedTheirs) || a.login.localeCompare(b.login));

  // Size vs time to merge: my PRs (linkable) over the team's (context).
  const point = (pr) => ({ repo: pr.repo, n: pr.n, size: (pr.add ?? 0) + (pr.del ?? 0), ttm: ttmOf(pr) });
  const sizes = {
    mine: mine.map(point).filter((p) => p.ttm >= 0),
    team: scoped ? human.filter((pr) => pr.a !== me).map(point).filter((p) => p.ttm >= 0) : [],
  };

  // My verdicts on the PRs I reviewed (my latest review on each).
  const verdicts = { APPROVED: 0, CHANGES_REQUESTED: 0, COMMENTED: 0 };
  for (const pr of reviewedByMe) {
    const st = pr.rv.find(([l]) => l === me)?.[2];
    if (st in verdicts) verdicts[st]++;
  }

  // ── The whole scope (§40 « Repository ») — aggregates, no names ─────────
  let repo = null;
  let shipping = [];
  let reviewing = [];
  if (scoped) {
    const H = human;
    const unmergedKnown = focus ? !!cache.unmerged?.[focus] : keys.some((k) => cache.unmerged?.[k]);
    const createdMerged = everMerged.filter((pr) => !pr.bot && inScope(pr.c));
    const createdUnmerged = unmergedAll.filter((pr) => !pr.bot && inScope(pr.c));
    const byRepo = new Map();
    for (const pr of H) byRepo.set(pr.repo, (byRepo.get(pr.repo) ?? 0) + 1);
    const ttms = H.map(ttmOf).filter((d) => d >= 0);
    const ttfrs = H.map(ttfrOf);
    repo = {
      merged: H.length,
      perMonth: H.length / (focus ? 1 : keys.length),
      noReview: H.filter((pr) => pr.rv.length === 0).length,
      noApproval: H.filter((pr) => !pr.rv.some(([, , st]) => st === 'APPROVED')).length,
      reviewersPerPR: mean(H.map((pr) => pr.rv.length)),
      eventsPerPR: mean(H.map((pr) => pr.ev)),
      size: median(H.map((pr) => (pr.add ?? 0) + (pr.del ?? 0))),
      ttm: { median: median(ttms), p90: quantile(ttms, 0.9) },
      ttfr: { median: median(ttfrs), p90: quantile(ttfrs, 0.9) },
      opened: unmergedKnown ? {
        total: createdMerged.length + createdUnmerged.length,
        merged: createdMerged.length,
        closed: createdUnmerged.filter((pr) => !pr.open).length,
        open: createdUnmerged.filter((pr) => pr.open).length,
      } : null,
      // Per CREATION month: how the PRs opened that month ended (needs the
      // unmerged dataset of that month — `known` false otherwise).
      outcomes: keys.map((key) => {
        const u = (cache.unmerged?.[key]?.prs ?? []).filter((pr) => !pr.bot && keepAuthor(pr.a));
        return {
          key,
          known: !!cache.unmerged?.[key],
          merged: everMerged.filter((pr) => !pr.bot && monthOf(pr.c) === key).length,
          closed: u.filter((pr) => !pr.open).length,
          open: u.filter((pr) => pr.open).length,
        };
      }),
      // Per MERGE month: median / p90 durations of the team.
      speed: keys.map((key) => {
        const inK = all.filter((pr) => !pr.bot && monthOf(pr.m) === key);
        const t = inK.map(ttmOf).filter((d) => d >= 0);
        const f = inK.map(ttfrOf);
        return { key, n: inK.length, ttm: median(t), ttmP90: quantile(t, 0.9), ttfr: median(f), ttfrP90: quantile(f, 0.9) };
      }),
      repos: [...byRepo].map(([name, merged]) => ({ repo: name, merged })).sort((a, b) => b.merged - a.merged || a.repo.localeCompare(b.repo)),
    };

    // Who's shipping: per author — merged in the period, and of the PRs they
    // OPENED in the period, how many were merged / closed / are still open.
    const authors = new Map();
    const au = (login) => authors.get(login) ?? authors.set(login, { login, merged: 0, add: 0, del: 0, ttms: [], ttfrs: [], openedMerged: 0, closed: 0, open: 0 }).get(login);
    for (const pr of H) {
      const a = au(pr.a);
      a.merged++;
      a.add += pr.add ?? 0;
      a.del += pr.del ?? 0;
      const d = ttmOf(pr);
      if (d >= 0) a.ttms.push(d);
      a.ttfrs.push(ttfrOf(pr));
    }
    for (const pr of createdMerged) au(pr.a).openedMerged++;
    for (const pr of createdUnmerged) au(pr.a)[pr.open ? 'open' : 'closed']++;
    shipping = [...authors.values()].map((a) => {
      const opened = a.openedMerged + a.closed + a.open;
      return {
        login: a.login, merged: a.merged,
        opened: unmergedKnown ? opened : null,
        openedMerged: a.openedMerged, closed: a.closed, open: a.open,
        mergeRate: unmergedKnown && opened ? a.openedMerged / opened : null,
        avgAdd: a.merged ? a.add / a.merged : null,
        avgDel: a.merged ? a.del / a.merged : null,
        ttm: median(a.ttms),
        ttfr: median(a.ttfrs),
      };
    }).sort((x, y) => y.merged - x.merged || (y.opened ?? 0) - (x.opened ?? 0) || x.login.localeCompare(y.login));

    // Who's reviewing: per reviewer — PRs reviewed and their verdict on each.
    const revs = new Map();
    const rvw = (login) => revs.get(login) ?? revs.set(login, { login, given: 0, APPROVED: 0, CHANGES_REQUESTED: 0, COMMENTED: 0, other: 0 }).get(login);
    for (const pr of prs) {
      for (const [l, , st] of pr.rv) {
        const r = rvw(l);
        r.given++;
        if (st in r && st !== 'login') r[st]++; else r.other++;
      }
    }
    const mergedBy = new Map();
    for (const pr of H) mergedBy.set(pr.a, (mergedBy.get(pr.a) ?? 0) + 1);
    reviewing = [...revs.values()].map((r) => {
      const m = mergedBy.get(r.login) ?? 0;
      return {
        login: r.login, given: r.given,
        approved: r.APPROVED, changes: r.CHANGES_REQUESTED, commented: r.COMMENTED + r.other,
        merged: m, ratio: m > 0 ? r.given / m : null,
      };
    }).sort((x, y) => y.given - x.given || x.login.localeCompare(y.login));
  }

  // Automated-looking accounts, on the UNFILTERED period (an ignored one keeps
  // being recognised so it can be un-ignored knowingly).
  const rawGiven = new Map();
  for (const pr of raw) {
    if (!inPeriod.has(monthOf(pr.m))) continue;
    for (const [l, , st] of pr.rv) {
      const g = rawGiven.get(l) ?? { login: l, given: 0, commented: 0 };
      g.given++;
      if (st === 'COMMENTED') g.commented++;
      rawGiven.set(l, g);
    }
  }
  const automated = [...rawGiven.values()]
    .filter((g) => g.given >= AUTOMATED_MIN_REVIEWS && g.commented / g.given >= AUTOMATED_COMMENT_SHARE && g.login !== me)
    .map((g) => ({ login: g.login, given: g.given, commentedShare: g.commented / g.given }))
    .sort((a, b) => b.given - a.given);
  const reviewers = [...rawGiven.values()].sort((a, b) => b.given - a.given).map((g) => g.login);

  return {
    since: monthStart(keys[0]),
    until: Math.min(now, nextMonthStart(keys[keys.length - 1]) - 1),
    month: focus,
    months,
    days,
    repos,
    me: {
      reviewed: reviewedByMe.length,
      merged: mine.length,
      ratio: mine.length > 0 ? reviewedByMe.length / mine.length : null,
      ttm: ttm(mine),
      ttfr: ttfr(mine),
      verdicts,
    },
    team,
    queue: { count: waiting.length, oldest: ages.length ? Math.max(...ages) : null },
    reciprocity,
    sizes,
    repo,
    shipping,
    reviewing,
    automated,
    reviewers,
    fetchedAt: Math.max(0, ...keys.map((k) => cache.months?.[k]?.fetchedAt ?? 0)) || null,
    // Months still missing PRs after the retries (truncated searches): said on
    // the page, refetched at the next visit.
    incomplete: keys.filter((k) => cache.months?.[k]?.incomplete).map((k) => ({ key: k, got: cache.months[k].prs.length, count: cache.months[k].count })),
  };
}
