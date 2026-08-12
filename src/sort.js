// Sorting of the PR tables in --serve. It's a DISPLAY STATE, like the active
// favorite (cf. ARCHITECTURE.md §14): the data stays raw in memory, sortRows
// applies at render time. A single active criterion per table at a time —
// clicking another column REPLACES the sort (never a cumulation). Each table
// has its own key set and its own persisted state (`sort` for « others »,
// `sortMine` for « Your PRs »).

export const SORT_KEYS = ['date', 'updated', 'approvals', 'author', 'diff', 'status'];
// « Your PRs »: the two date columns, the diff size and the status (author = me,
// approvals of little use there).
export const MINE_SORT_KEYS = ['date', 'updated', 'diff', 'status'];

// Default direction on the first click on a column: dates → newest first,
// approvals → least approved first (the ones that most need a review), author →
// alphabetical, diff → smallest first (the quick reviews), status → actionable
// first (open before draft before merged/closed).
const DEFAULT_DIR = { date: 'desc', updated: 'desc', approvals: 'asc', author: 'asc', diff: 'asc', status: 'asc' };
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

// Comparison value of a row for a key. null = missing (sorted at the end).
function valueOf(row, key) {
  if (key === 'approvals') return row.approvals ?? null; // 0 is a real value
  if (key === 'author') return row.author ? String(row.author).toLowerCase() : null;
  if (key === 'updated') return row.updatedAt ?? null; // ISO 8601: lexical comparison is enough
  if (key === 'status') return STATE_RANK[row.state] ?? null;
  if (key === 'diff') {
    // Size = additions + deletions (the two cells of the Diff column). Both
    // absent → missing; a lone 0 is a real value (empty diff).
    if (row.additions == null && row.deletions == null) return null;
    return (row.additions ?? 0) + (row.deletions ?? 0);
  }
  return row.createdAt ?? null;
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
