// Sorting of the PR tables in --serve. It's a DISPLAY STATE, like the active
// favorite (cf. ARCHITECTURE.md §14): the data stays raw in memory, sortRows
// applies at render time. A single active criterion per table at a time —
// clicking another column REPLACES the sort (never a cumulation). Each table
// has its own key set and its own persisted state (`sort` for « others »,
// `sortMine` for « Your PRs »).

export const SORT_KEYS = ['repo', 'number', 'title', 'labels', 'branch', 'date', 'review', 'updated', 'approvals', 'author', 'diff', 'status', 'triggers', 'ci'];
// « Your PRs »: every column except Author (always me).
export const MINE_SORT_KEYS = SORT_KEYS.filter((k) => k !== 'author');

// Default direction on the first click on a column: dates → newest first,
// number → highest first (a higher number = a more recent PR within a repo),
// approvals → least approved first (the ones that most need a review),
// review → longest in review first (the ones waiting the most), text
// columns (repo/title/branch/author) → alphabetical, diff → smallest first
// (the quick reviews), status/triggers/ci → actionable first (open, review,
// failing CI…).
const DEFAULT_DIR = {
  repo: 'asc', number: 'desc', title: 'asc', labels: 'asc', branch: 'asc',
  date: 'desc', review: 'asc', updated: 'desc', approvals: 'asc', author: 'asc',
  diff: 'asc', status: 'asc', triggers: 'asc', ci: 'asc',
};
const DIRS = ['asc', 'desc'];

// `updated` desc: the PRs that moved last come first (valid for BOTH key
// sets — keep it in MINE_SORT_KEYS).
export const DEFAULT_SORT = { key: 'updated', dir: 'desc' };

// Validates a sort state coming from prefs-v1.json (old/tampered file → default,
// modeled on themeOf). `keys` restricts to the table's key set (MINE_SORT_KEYS
// for « Your PRs »). Always returns a fresh copy.
export function normalizeSort(raw, keys = SORT_KEYS) {
  if (!raw || !keys.includes(raw.key) || !DIRS.includes(raw.dir)) return { ...DEFAULT_SORT };
  return { key: raw.key, dir: raw.dir };
}

// Click on a header: same column → flip the direction; other column → that
// column with its default direction.
export function toggleSort(current, key, keys = SORT_KEYS) {
  const cur = normalizeSort(current, keys);
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: DEFAULT_DIR[key] ?? 'asc' };
}

// Semantic rank of the 🚦 column: NOT alphabetical — actionable first (open),
// then draft, then the finished ones (merged/closed). Unknown state → missing.
const STATE_RANK = { open: 0, draft: 1, merged: 2, closed: 3 };
// CI: failing first (needs action), then pending, then green. `none` → missing.
const CI_RANK = { fail: 0, pending: 1, pass: 2 };
// ⚡ triggers: rank of the MOST important trigger of the row (same order as
// TRIGGER_META in html.js — review first). NOT alphabetical, like STATE_RANK.
const TRIGGER_RANK = { review: 0, mention: 1, reply: 2, comment: 3, new: 4, activity: 5 };

const lower = (s) => (s ? String(s).toLowerCase() : null);

// Comparison value of a row for a key. null = missing (sorted at the end).
function valueOf(row, key) {
  if (key === 'repo') return lower(row.repo);
  if (key === 'number') return row.number ?? null;
  if (key === 'title') return lower(row.title);
  if (key === 'labels') {
    // Alphabetical on the label names (already GitHub-ordered on the row);
    // joined so rows sharing a first label still order deterministically.
    const names = (row.labels ?? []).map((l) => l?.name).filter(Boolean);
    return names.length ? names.join(',').toLowerCase() : null;
  }
  if (key === 'branch') return lower(row.branch);
  if (key === 'review') {
    // In-review start = readyAt (last draft → ready) falling back on createdAt,
    // same basis as the easter egg (§21). Only an OPEN PR is in review: draft,
    // merged and closed → missing (at the end).
    return row.state === 'open' ? (row.readyAt ?? row.createdAt ?? null) : null;
  }
  if (key === 'approvals') return row.approvals ?? null; // 0 is a real value
  if (key === 'author') return lower(row.author);
  if (key === 'updated') return row.updatedAt ?? null; // ISO 8601: lexical comparison is enough
  if (key === 'status') return STATE_RANK[row.state] ?? null;
  if (key === 'ci') return CI_RANK[row.ci] ?? null;
  if (key === 'triggers') {
    const ranks = (row.triggers ?? []).map((t) => TRIGGER_RANK[t]).filter((r) => r != null);
    return ranks.length ? Math.min(...ranks) : null;
  }
  if (key === 'diff') {
    // Size = additions + deletions (the two cells of the Diff column). Both
    // absent → missing; a lone 0 is a real value (empty diff).
    if (row.additions == null && row.deletions == null) return null;
    return (row.additions ?? 0) + (row.deletions ?? 0);
  }
  return row.createdAt ?? null;
}

// Stacked PRs: a render pass applied AFTER sortRows (the sort stays intact for
// the roots; a child is pulled right under its parent). A child is a row whose
// `base` is the head branch of another row of the SAME repo — a fork-hosted
// head cannot be a base ref, so forks are excluded from the parent map. Rows
// are never mutated: children are re-emitted as copies carrying `stackDepth`,
// and a stacked row whose parent is NOT in the table gets `orphanBase` (only
// when the default branch is known, to avoid a badge on every base:main PR).
function stackLinks(list) {
  const byBranch = new Map();
  for (const r of list) {
    if (r.branch && (r.branchRepo == null || r.branchRepo === r.repo)) byBranch.set(`${r.repo}#${r.branch}`, r);
  }
  const parentOf = new Map();
  const childrenOf = new Map();
  for (const r of list) {
    const p = r.base ? byBranch.get(`${r.repo}#${r.base}`) : null;
    if (!p || p === r) continue;
    parentOf.set(r, p);
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(r);
  }
  return { parentOf, childrenOf };
}

// At least one parent/child link among these rows? Gates the « ⤷ stacks »
// toggle in the section titles (an orphan alone doesn't count: nothing to group).
export function hasStacks(rows) {
  return stackLinks(rows ?? []).parentOf.size > 0;
}

export function groupStacks(rows) {
  const list = rows ?? [];
  const { parentOf, childrenOf } = stackLinks(list);
  // Canonical stacked view — NO sort semantics (the sorts are dropped while
  // stacks mode is on, cf. §20): the stacks come FIRST, one block under the
  // other (block order = first appearance in the incoming list), each block
  // root-first then its children depth-first (siblings keep the incoming
  // order); the non-stacked rows follow below, in their incoming order.
  const inStack = new Set();
  for (const [child, parent] of parentOf) { inStack.add(child); inStack.add(parent); }
  const out = [];
  const solos = [];
  const visited = new Set();
  let nextBlock = 0;
  // A block is « branched » when one of its members has 2+ children: the DFS
  // order alone no longer tells the tree, so its children get a PER-DEPTH
  // indent (`stackBranched`) — a linear chain keeps the single fixed indent.
  const isBranched = (root) => {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      const kids = childrenOf.get(n) ?? [];
      if (kids.length > 1) return true;
      stack.push(...kids);
    }
    return false;
  };
  // `inStack` flags every row of a block and `stackIndex` numbers it →
  // alternating block backgrounds (two adjacent stacks must read as two units).
  const emit = (r, depth, block, branched) => {
    if (visited.has(r)) return;
    visited.add(r);
    const orphan = depth === 0 && r.base && r.defaultBranch && r.base !== r.defaultBranch;
    out.push({
      ...r, inStack: true, stackIndex: block,
      ...(depth > 0 ? { stackDepth: depth } : {}),
      ...(depth > 0 && branched ? { stackBranched: true } : {}),
      ...(orphan ? { orphanBase: r.base } : {}),
    });
    for (const c of childrenOf.get(r) ?? []) emit(c, depth + 1, block, branched);
  };
  for (const r of list) {
    if (!inStack.has(r)) {
      // solo row; `orphanBase` if it is stacked on something not in the table.
      const orphan = r.base && r.defaultBranch && r.base !== r.defaultBranch;
      solos.push(orphan ? { ...r, orphanBase: r.base } : r);
    } else if (!parentOf.has(r)) emit(r, 0, nextBlock++, isBranched(r));
  }
  // base cycle (defensive): a component without a root, emit it as its own block
  for (const r of list) if (inStack.has(r) && !visited.has(r)) emit(r, 0, nextBlock++, false);
  return [...out, ...solos];
}

// Sorted copy (does not mutate the input). Missing always at the end whatever
// the direction; equality → arrival order preserved (the native sort is stable).
export function sortRows(rows, sort, keys = SORT_KEYS) {
  const { key, dir } = normalizeSort(sort, keys);
  const mul = dir === 'asc' ? 1 : -1;
  return [...(rows ?? [])].sort((a, b) => {
    const x = valueOf(a, key);
    const y = valueOf(b, key);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -mul : x > y ? mul : 0;
  });
}
