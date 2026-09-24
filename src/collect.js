import { classify, classifyVerdict, CATEGORY, TRIGGER_FOR } from './filter.js';
import { reconcile, isHidden, keyOf } from './hidden.js';
import { approvalsOf, changesRequestedOf } from './approvals.js';
import { isStaleStack } from './stale.js';

// Max concurrency of `gh` calls (avoids spawning dozens of processes at once /
// hitting GitHub's secondary rate-limit). Lowered to smooth out the cold-start
// spike and spare the secondary rate limit.
const CONCURRENCY = 6;

// Merges two lists of review-comments by `id` (the `fresh` version wins),
// sorted by `created_at`. Used for incremental fetching (`since`): we don't
// re-paginate a whole thread, we merge the delta with the cache.
export function mergeReviewComments(prev, fresh) {
  const byId = new Map();
  for (const c of prev || []) byId.set(c.id, c);
  for (const c of fresh || []) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => {
    const x = a.created_at || '';
    const y = b.created_at || '';
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// Upper bound of the `updated_at` (fallback `created_at`) of a list of
// comments — the next `since` for incremental fetching. null if empty.
export function watermarkOf(comments) {
  let max = null;
  for (const c of comments || []) {
    const t = c.updated_at || c.created_at;
    if (t && (max === null || t > max)) max = t;
  }
  return max;
}

// scope : null (everything) | { type:'org', value } | { type:'repo', value:'owner/name' }
// The public entry points (collectPRs & co) also accept an ARRAY of scopes
// (union of favorites) — cf. toScopeList / matchesAnyScope below.
export function scopeMatches(scope, fullName) {
  if (!scope) return true;
  if (scope.type === 'org') return (fullName || '').startsWith(`${scope.value}/`);
  return fullName === scope.value;
}

// GitHub search qualifier matching the scope (string prefixed with a space).
export function scopeQualifier(scope) {
  if (!scope) return '';
  return scope.type === 'org' ? ` org:${scope.value}` : ` repo:${scope.value}`;
}

// ── Multiple scopes (favorites) ──────────────────────────────────────────
// From favorites, `scope` can be a LIST of scopes whose union we want. The
// three helpers below generalize the previous two without modifying them (a
// single scope stays a special case).

// Normalizes a `scope` parameter: null | single object | array → null | non-empty
// array. An empty array means « no filter ».
export function toScopeList(scope) {
  if (!scope) return null;
  const list = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
  return list.length > 0 ? list : null;
}

// Does the repo belong to AT LEAST ONE of the scopes? (null → everything passes)
export function matchesAnyScope(scopes, fullName) {
  const list = toScopeList(scopes);
  if (!list) return true;
  return list.some((s) => scopeMatches(s, fullName));
}

// Search qualifier for the union of scopes. GitHub OR-s repeated scope
// qualifiers (measured: `repo:a` 6 + `repo:b` 9 → both 15), including when
// mixing `org:` and `repo:` → the union costs ONE search, not N.
export function scopesQualifier(scopes) {
  const list = toScopeList(scopes);
  if (!list) return '';
  return list.map(scopeQualifier).join('');
}

export async function inspectThread(gh, thread, me, cacheEntry = null) {
  // Cache hit: the thread hasn't moved since the last poll (same
  // `updated_at`) → we reuse the previous inspection, **0 requests**.
  if (cacheEntry && cacheEntry.threadUpdatedAt === thread.updated_at) {
    return cacheEntry.inspection;
  }
  // We fetch the latest comment (actor of the mention/author) AND the
  // review-comments (detection of a reply to my thread), because the `reason`
  // is « sticky »: a real reply can arrive under a reason=mention OR
  // review_requested (hence fetching even for review requests).
  // Incremental fetching: only the comments after the last seen one
  // (`since`), merged with those from the cache.
  const number = Number(thread.subject.url.split('/').pop());
  const url = thread.subject?.latest_comment_url;
  const since = cacheEntry?.since ?? null;
  // An Issue thread (« all » mode) has no review-comments — fetching
  // pulls/N/comments would 404 and the catch would drop the whole inspection.
  const isIssue = thread.subject?.type === 'Issue';
  const [latestComment, fresh] = await Promise.all([
    url ? gh.getComment(url) : Promise.resolve(null),
    isIssue ? Promise.resolve([]) : gh.getReviewComments(thread.repository.full_name, number, { since }),
  ]);
  const reviewComments = since
    ? mergeReviewComments(cacheEntry?.inspection?.reviewComments ?? [], fresh)
    : fresh;
  return { latestComment, reviewComments };
}

export const PURGE_AGE_DAYS = 14;

export async function collectNotifications(gh, me, { all = false, scope = null, cache = null, debug = null, watchAll = null, now = Date.now() } = {}) {
  const threads = await gh.listNotifications({ all });
  // Age purge (ARCHITECTURE §22): anything older than PURGE_AGE_DAYS is dead —
  // one server-side PUT purges it all, and ONLY when something qualifies (no
  // request in the common case). Best-effort: on failure the threads stay
  // unread and the next poll retries. Whole account on purpose (not the scope):
  // gh-notif is the only notification UI, out-of-scope threads are never seen
  // anywhere and would inflate the listing forever.
  const cutoffMs = now - PURGE_AGE_DAYS * 86400e3;
  if (typeof gh.markReadBefore === 'function' && threads.some((t) => Date.parse(t.updated_at) < cutoffMs)) {
    await gh.markReadBefore(new Date(cutoffMs).toISOString()).catch(() => {});
  }
  // Keep only the PRs in scope before any request (filtering = free). A repo
  // covered by an « all »-mode favorite (`watchAll` predicate) ALSO keeps its
  // Issue threads (cf. ARCHITECTURE §18); everything else is unchanged.
  const inAllMode = (t) => !!watchAll?.(t.repository?.full_name);
  const prThreads = threads.filter(
    (t) => (t.subject?.type === 'PullRequest' || (t.subject?.type === 'Issue' && inAllMode(t)))
      && matchesAnyScope(scope, t.repository?.full_name),
  );
  // Inspection in parallel (instead of a sequential await per thread): that's the
  // big time gain. `mapLimit` preserves order; a failed thread → null.
  // With `cache` (long loop): an unchanged thread costs 0 requests, otherwise we
  // fetch only the delta of comments and update the entry.
  const inspections = await mapLimit(prThreads, CONCURRENCY, (t) => {
    const prev = cache?.get(t.id) ?? null;
    return inspectThread(gh, t, me, prev)
      .then((inspection) => {
        if (cache && inspection) {
          const hit = prev && prev.threadUpdatedAt === t.updated_at;
          const since = hit ? prev.since : watermarkOf(inspection.reviewComments);
          cache.set(t.id, { threadUpdatedAt: t.updated_at, since, inspection });
        }
        return inspection;
      })
      .catch(() => null);
  });
  // Prune the cache of threads that are no longer in the notification list.
  if (cache) {
    const present = new Set(prThreads.map((t) => t.id));
    for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  }
  const items = [];
  const purgeIds = [];
  prThreads.forEach((thread, i) => {
    const inspection = inspections[i];
    const { item, reason } = classifyVerdict(thread, me, inspection, { watchAll: inAllMode(thread) });
    if (item) items.push(item);
    // Auto-purge: a thread the verdict rejects as noise is marked read on
    // GitHub, so it stops accumulating (listing pages + cold-restart
    // inspection cost). A null inspection is a fetch FAILURE, never noise.
    else if (inspection) purgeIds.push(thread.id);
    // Debug sink (optional): compact verdict per thread, without the comment
    // body (cost + privacy). Produced for free (data already fetched).
    if (debug) {
      debug.push({
        repo: thread.repository?.full_name ?? null,
        number: Number(thread.subject.url.split('/').pop()),
        title: thread.subject?.title ?? null,
        ghReason: thread.reason,
        updatedAt: thread.updated_at,
        lastReadAt: thread.last_read_at ?? null,
        commentsCount: inspection?.reviewComments?.length ?? 0,
        latestCommentAuthor: inspection?.latestComment?.user?.login ?? null,
        verdict: { kept: !!item, category: item?.category ?? null, reason },
      });
    }
  });
  // Best-effort: a failed PATCH leaves the thread unread → retried at the
  // next poll for free. `typeof` guard: same motive as `scopeExists` (older
  // gh stubs without markThreadRead must keep working).
  if (typeof gh.markThreadRead === 'function') {
    await mapLimit(purgeIds, CONCURRENCY, (id) => gh.markThreadRead(id).catch(() => {}));
  }
  return items;
}

const pendingEntry = (it) => ({
  repo: it.repository_url.replace('https://api.github.com/repos/', ''),
  number: it.number,
  title: it.title,
  url: it.html_url,
  updatedAt: it.updated_at,
});

const authoredEntry = (it) => ({
  repo: it.repository_url.replace('https://api.github.com/repos/', ''),
  number: it.number,
  title: it.title,
  url: it.html_url,
});

export async function collectPending(gh, scope = null) {
  return (await gh.searchReviewRequested(scopesQualifier(scope))).map(pendingEntry);
}

export async function collectAuthored(gh, scope = null) {
  return (await gh.searchAuthored(scopesQualifier(scope))).map(authoredEntry);
}

// One dashboard search → `{ entries, authoritative }`. A response GitHub
// flagged `incomplete_results` (or truncated outright: `err.incomplete`, the
// partial items attached — cf. github.js) is NOT authoritative: absence from
// it proves nothing. Any other error (rate-limit…) propagates.
async function searchEntries(run, toEntry) {
  try {
    const items = await run();
    return { entries: items.map(toEntry), authoritative: !items.incomplete };
  } catch (err) {
    if (!err.incomplete) throw err;
    return { entries: (err.items ?? []).map(toEntry), authoritative: false, truncated: err.message };
  }
}

// Search memo (§10, object owned by the poll loop: `memo[key] = { qualifier,
// items }`). A non-authoritative response is MERGED with the last known list
// of the same scope qualifier; the GraphQL details then decide who is really
// gone (`memoAlive`). Returns the remembered entries the response lacks.
function memoExtras(memo, key, qualifier, res, warn) {
  const last = memo?.[key];
  if (res.authoritative) return [];
  if (!last || last.qualifier !== qualifier) {
    if (res.truncated) warn(`${key} search truncated by GitHub (${res.truncated}) · nothing remembered yet, showing the partial list`);
    return [];
  }
  const known = new Set(res.entries.map((e) => `${e.repo}#${e.number}`));
  const extras = last.items.filter((e) => !known.has(`${e.repo}#${e.number}`));
  if (extras.length) warn(`${key} search ${res.truncated ? `truncated by GitHub (${res.truncated})` : `flagged incomplete by GitHub (${res.entries.length} items)`} · keeping ${extras.length} remembered PR(s) until GraphQL says otherwise`);
  return extras;
}

const reviewedByMe = (d, me) => (d?.reviews ?? []).some((r) => r.author?.login === me);

// A remembered PR is dead once GraphQL shows it merged/closed — and, for a
// review request, once I reviewed it (GitHub drops the request). A failed
// chunk (`d` null) is no evidence: kept.
function memoAlive(key, d, me) {
  if (!d) return true;
  const s = prState(d);
  if (s === 'merged' || s === 'closed') return false;
  return key === 'pending' ? !reviewedByMe(d, me) : true;
}

// Runs fn on each item with at most `limit` concurrent executions
// (avoids launching dozens of `gh pr view` at once).
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

// Translates the state of the GraphQL statusCheckRollup (a single aggregated
// state from GitHub) into: 'fail' | 'pending' | 'pass' | 'none'.
export function ciFromState(state) {
  const s = (state || '').toUpperCase();
  if (s === 'SUCCESS') return 'pass';
  if (s === 'FAILURE' || s === 'ERROR') return 'fail';
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
  return 'none'; // no checks (rollup null)
}

// Recomputes the CI verdict ('fail'|'pending'|'pass'|'none') from the
// individual checks, first removing the jobs listed in `ignored` (per-repo
// blocklist). Exact match on the name, trimmed on the config side (the check name
// comes from GitHub, we don't touch it; case-sensitive). A `fail` dominates,
// otherwise a `pending`, otherwise (at least one remaining check) `pass`, otherwise
// `none`. Used instead of `ciFromState` only for a repo that has a blocklist (cf. §compat).
export function ciFromChecks(checks, ignored = []) {
  const blocked = new Set((ignored || []).map((n) => String(n).trim()));
  const kept = (checks || []).filter((c) => !blocked.has(c.name));
  if (kept.some((c) => c.state === 'fail')) return 'fail';
  if (kept.some((c) => c.state === 'pending')) return 'pending';
  return kept.length ? 'pass' : 'none';
}

// CI verdict of a PR from its details (`{ checks, statusCheckRollupState }`)
// and the repo's blocklist. ⚠️ SINGLE SOURCE shared by collection (collectPRs)
// and the local recompute after a web toggle (recomputeCi/serve /ignore-check): IF the
// repo has ignored jobs, we recompute via `ciFromChecks`; otherwise we keep the GitHub
// rollup as-is (`ciFromState`) → byte-identical compat for anyone who configured nothing.
export function ciOf(detail, ignoredList = []) {
  return (ignoredList && ignoredList.length)
    ? ciFromChecks(detail?.checks, ignoredList)
    : ciFromState(detail?.statusCheckRollupState);
}

// Recomputes IN PLACE the `ci` of each row (mine/others/hidden) from `row.checks`
// (already in memory) and the current blocklist — NO GitHub call. Used by the web toggle
// (POST /ignore-check): toggling a job → the CI icons update without a refetch.
export function recomputeCi(data, ignoredChecks = {}) {
  const forRepo = (repo) => (Array.isArray(ignoredChecks[repo]) ? ignoredChecks[repo] : []);
  for (const key of ['mine', 'hiddenMine', 'others', 'hidden']) {
    for (const row of data?.[key] ?? []) row.ci = ciOf(row, forRepo(row.repo));
  }
  return data;
}

// Number of approvals: distinct users whose MOST RECENT review is APPROVED
// (cf. approvalsOf). Kept for the ✅ column of the tables.
export function countApprovals(reviews) {
  return approvalsOf(reviews).length;
}

// Displayed state of a PR from `gh pr view`: 'draft' | 'open' | 'merged' | 'closed'.
export function prState(d) {
  if (d?.isDraft) return 'draft';
  const s = (d?.state || '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

// Aggregates a PR's changed files by extension for the per-type diff popover:
// [{ ext: '.php', files, additions, deletions }] (`files` = how many files of
// that type) sorted by volume (adds + dels)
// descending — the heaviest type first (alphabetical tie-break). `ext` is the
// display label — lowercased suffix after the last dot (so a dotfile keeps its
// dot: '.gitignore'), or the bare lowercased filename when there is none
// ('makefile'). '.yml' is folded into '.yaml' (same format, two spellings).
export function diffByType(files) {
  const byExt = new Map();
  for (const f of files ?? []) {
    const base = String(f.path).split('/').pop().toLowerCase();
    const dot = base.lastIndexOf('.');
    let ext = dot > 0 ? base.slice(dot) : base;
    if (ext === '.yml') ext = '.yaml';
    const acc = byExt.get(ext) ?? { ext, files: 0, additions: 0, deletions: 0 };
    acc.files += 1;
    acc.additions += f.additions || 0;
    acc.deletions += f.deletions || 0;
    byExt.set(ext, acc);
  }
  return [...byExt.values()].sort((a, b) =>
    (b.additions + b.deletions) - (a.additions + a.deletions) || a.ext.localeCompare(b.ext));
}

// Per-repo CI blocklist lookup (§16): the ignored job names of a repo, [] if none.
const ignoredFor = (ignoredChecks, repo) => (Array.isArray(ignoredChecks?.[repo]) ? ignoredChecks[repo] : []);

// One table row from a search entry `{ repo, number, title, url, triggers }` and
// its GraphQL detail `d` (null if not found / failed chunk → fallbacks on the
// entry). Shared by the dashboard (collectPRs) and the search page
// (collectSearch, §29): both tables show exactly the same information.
export function buildRow(e, d, ignoredForRepo = []) {
  return {
    repo: e.repo,
    number: e.number,
    url: e.url,
    title: d?.title ?? e.title,
    triggers: [...(e.triggers ?? [])],
    author: d?.author?.login ?? null,
    branch: d?.branch ?? null,
    branchRepo: d?.branchRepo ?? null,
    base: d?.base ?? null,
    defaultBranch: d?.defaultBranch ?? null,
    behindBy: d?.behindBy ?? null, // commits of the base the PR lacks (Behind column)
    labels: d?.labels ?? [], // GitHub labels ({name, color}), Labels column of the web tables
    createdAt: d?.createdAt ?? null,
    readyAt: d?.readyAt ?? null, // draft → ready date (easter-egg gate, cf. html.js)
    updatedAt: d?.updatedAt ?? null,
    additions: d?.additions ?? 0,
    deletions: d?.deletions ?? 0,
    changedFiles: d?.changedFiles ?? null, // GitHub total of changed files (Files column)
    diffTypes: diffByType(d?.files), // per-extension diff (popover of the Diff/Files cells)
    moreFiles: d?.moreFiles ?? 0, // files beyond the fetched page of 100
    // Per-repo blocklist: IF the repo has ignored jobs, we recompute the verdict
    // from the individual checks; otherwise we keep the GitHub rollup as-is
    // (byte-identical compat for anyone who configured nothing — cf. §16).
    ci: ciOf(d, ignoredForRepo),
    checks: d?.checks ?? [], // raw list (debug view + local recompute; zero cost)
    statusCheckRollupState: d?.statusCheckRollupState ?? null, // basis of ciFromState for recomputeCi
    state: prState(d),
    // Merge conflict with the base branch. Only an explicit CONFLICTING counts:
    // UNKNOWN means « GitHub has not computed it yet » (cf. github.js), not « fine ».
    conflicting: d?.mergeable === 'CONFLICTING',
    staleStack: false, // set by collectPRs (§31): the conflict drags a rewritten parent's commits
    approvals: approvalsOf(d?.reviews).length,
    changesRequested: changesRequestedOf(d?.reviews).length, // reviewers whose latest review requests changes
  };
}

// Search page (§29): the query as typed, whitespace normalized, `is:pr` forced
// (PRs only — never issues). Also the cache key upstream.
export function searchQuery(raw) {
  const q = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return /(^|\s)is:pr(\s|$)/.test(q) ? q : `is:pr ${q}`.trim();
}

// Search page (§29): ONE search (the `max` most recently updated matches) +
// the GraphQL details of those PRs → full rows, like the dashboard's. On
// demand only — never in the poll (a wide query would cost dozens of GraphQL
// batches per minute: real rate-limit). `total` = GitHub's count, `capped`
// tells the page the set was truncated.
export async function collectSearch(gh, raw, { max = 200, ignoredChecks = {} } = {}) {
  const query = searchQuery(raw);
  const { items, total } = await gh.searchPRs(query, { max });
  const entries = items.map((it) => ({
    repo: it.repository_url.replace('https://api.github.com/repos/', ''),
    number: it.number,
    title: it.title,
    url: it.html_url,
    triggers: new Set(),
  }));
  const details = await gh.getPullDetailsBatch(entries.map((e) => ({ repo: e.repo, number: e.number })));
  const rows = entries.map((e, i) => buildRow(e, details[i], ignoredFor(ignoredChecks, e.repo)));
  return { query, url: `https://github.com/pulls?q=${encodeURIComponent(query)}`, rows, total, capped: total > rows.length };
}

// Groups notifications + pending reviews by PR, aggregates the triggers,
// fetches the details of each PR (author / date / diff / CI) in parallel,
// then splits according to whether the PR is mine or someone else's.
export async function collectPRs(gh, me, { all = false, scope = null, hidden = {}, cache = null, ignoredChecks = {}, watchAll = null, searchMemo = null, warn = () => {} } = {}) {
  const debug = []; // compact verdict per thread (always produced: zero cost)
  const qualifier = scopesQualifier(scope);
  const [items, pendingRes, authoredRes] = await Promise.all([
    collectNotifications(gh, me, { all, scope, cache, debug, watchAll }),
    searchEntries(() => gh.searchReviewRequested(qualifier), pendingEntry),
    searchEntries(() => gh.searchAuthored(qualifier), authoredEntry),
  ]);
  const pending = pendingRes.entries;
  const authored = authoredRes.entries;
  // Remembered PRs a non-authoritative search lacks (§10): seeded below
  // WITHOUT a trigger, the GraphQL details decide whether they are still alive.
  const extras = {
    pending: memoExtras(searchMemo, 'pending', qualifier, pendingRes, warn),
    authored: memoExtras(searchMemo, 'authored', qualifier, authoredRes, warn),
  };

  const byKey = new Map();
  const ensure = (repo, number, title) => {
    const key = `${repo}#${number}`;
    if (!byKey.has(key)) {
      byKey.set(key, { repo, number, title, url: `https://github.com/${repo}/pull/${number}`, triggers: new Set() });
    }
    return byKey.get(key);
  };
  // Watched issues (« all » mode): their own rows, OUTSIDE the PR pipeline
  // (no GraphQL details, no hiding). One item per thread per poll → one row.
  const issues = [];
  for (const it of items) {
    if (it.subjectType !== 'issue') continue;
    issues.push({
      repo: it.repo, number: it.number, title: it.title, url: it.url,
      actor: it.actor ?? null, createdAt: it.createdAt ?? null, updatedAt: it.updatedAt ?? null,
      triggers: [TRIGGER_FOR[it.category]].filter(Boolean),
    });
  }
  for (const it of items) {
    if (it.subjectType === 'issue') continue; // issue rows built above
    const trig = TRIGGER_FOR[it.category];
    if (!trig) continue; // review_request: ignored here (cf. TRIGGER_FOR / collectPending)
    const row = ensure(it.repo, it.number, it.title);
    row.triggers.add(trig);
    // mention / reply / comment: `it.url` points at the precise comment →
    // the row's link leads there directly (and not to the PR alone).
    row.url = it.url;
  }
  for (const p of pending) ensure(p.repo, p.number, p.title).triggers.add('review');
  for (const a of authored) ensure(a.repo, a.number, a.title); // dashboard: no trigger
  const memoOnly = new Set(); // remembered PRs nothing else surfaced this poll
  const remembered = { pending: new Map(), authored: new Map() };
  for (const key of ['pending', 'authored']) {
    for (const e of extras[key]) {
      const k = `${e.repo}#${e.number}`;
      if (!byKey.has(k)) memoOnly.add(k);
      ensure(e.repo, e.number, e.title);
      remembered[key].set(k, e);
    }
  }

  const candidates = [...byKey.values()];
  const details = await gh.getPullDetailsBatch(candidates.map((e) => ({ repo: e.repo, number: e.number })));

  // Verdict on the remembered PRs (§10): alive → kept (a review request
  // regains its trigger) and remembered again; dead → dropped from this poll
  // unless something else surfaced the PR. The memo is then rewritten:
  // the search's own entries + the survivors (an authoritative search has no
  // survivors → the memo IS the search).
  const alive = { pending: [], authored: [] };
  const seen = [];
  candidates.forEach((e, i) => {
    const k = `${e.repo}#${e.number}`;
    let keep = !memoOnly.has(k);
    for (const key of ['pending', 'authored']) {
      const r = remembered[key].get(k);
      if (!r || !memoAlive(key, details[i], me)) continue;
      alive[key].push(r);
      keep = true;
      if (key === 'pending') e.triggers.add('review');
    }
    if (keep) seen.push([e, details[i]]);
  });
  if (searchMemo) {
    searchMemo.pending = { qualifier, items: [...pending, ...alive.pending] };
    searchMemo.authored = { qualifier, items: [...authored, ...alive.authored] };
  }
  const entries = seen.map(([e]) => e);

  // Stale stacks (§31): among the CONFLICTING PRs, which ones drag another
  // PR's commits (parent force-pushed / squash-merged)? A second small batch,
  // only for those. `gh.getStaleSignals` may be absent (older stub) → no flag.
  const conflicting = seen.filter(([, d]) => d?.mergeable === 'CONFLICTING');
  const signals = conflicting.length && gh.getStaleSignals
    ? await gh.getStaleSignals(conflicting.map(([e]) => ({ repo: e.repo, number: e.number })))
    : [];
  const stale = new Set(conflicting
    .filter(([e], i) => isStaleStack(e.number, signals[i]))
    .map(([e]) => `${e.repo}#${e.number}`));

  const mineAll = [];   // my PRs (drafts kept), before hide filtering
  const othersAll = []; // others' PRs (excluding drafts), before hide filtering
  const approvalEvents = []; // one entry per approval on MY open PRs
  const changesRequestedEvents = []; // idem, for the reviewers requesting changes
  seen.forEach(([e, d]) => {
    const approvers = approvalsOf(d?.reviews);
    const row = buildRow(e, d, ignoredFor(ignoredChecks, e.repo));
    row.staleStack = stale.has(`${e.repo}#${e.number}`);
    if (d && d.author?.login === me) {
      mineAll.push(row); // my PRs: we keep my drafts
      // Approval / changes-requested events: only on my OPEN PRs (not draft/merged/
      // closed). « ready to merge » makes no sense otherwise (and avoids noise).
      if (row.state === 'open') {
        for (const ap of approvers) {
          approvalEvents.push({
            repo: e.repo, number: e.number, title: row.title,
            actor: ap.login, url: e.url, submittedAt: ap.submittedAt,
            count: approvers.length,
          });
        }
        for (const cr of changesRequestedOf(d?.reviews)) {
          changesRequestedEvents.push({
            repo: e.repo, number: e.number, title: row.title,
            actor: cr.login, url: e.url, submittedAt: cr.submittedAt,
          });
        }
      }
    } else if (row.state !== 'draft' && !row.staleStack) {
      othersAll.push(row); // others' PRs: we hide the drafts and the stale stacks (§31)
    }
  });

  // Un-hide on a new trigger + date the absences (mutates `hidden`), then split
  // each section into visible / hidden. ⚠️ reconcile receives **`entries`** (all
  // the PRs seen this poll), not `mineAll + othersAll`: the latter drop others'
  // drafts, so a hidden PR turned draft counted as absent and started its purge
  // countdown for a reason that has nothing to do with being dead. What
  // reconcile needs is « was this PR seen this poll? », not « is it displayable? ».
  // The approval / changes-requested events above are computed BEFORE the split:
  // a hidden PR of mine keeps notifying them (raw data feeds the notifs, cf. §14).
  const hiddenChanged = reconcile(hidden, entries, items);
  const mine = mineAll.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenMine = mineAll.filter((r) => isHidden(hidden, keyOf(r)));
  const others = othersAll.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = othersAll.filter((r) => isHidden(hidden, keyOf(r)));

  // `notifications` = already-classified notification items (with event url),
  // exposed so that the poll loop detects new things without redoing the work.
  // `debug` = pipeline verdict per thread (debug mode).
  return { mine, hiddenMine, hiddenMineCount: hiddenMine.length, others, hidden: hiddenRows, hiddenCount: hiddenRows.length, hiddenChanged, issues, notifications: items, approvalEvents, changesRequestedEvents, debug };
}
