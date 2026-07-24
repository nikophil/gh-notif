// Sorting of the « others' PRs » table in --serve. It's a DISPLAY STATE, like
// the active favorite (cf. ARCHITECTURE.md §14): the data stays raw in memory,
// sortRows applies at render time. A single active criterion at a time —
// clicking another column REPLACES the sort (never a cumulation).

export const SORT_KEYS = ['date', 'approvals', 'author'];

// Default direction on the first click on a column: date → newest first,
// approvals → least approved first (the ones that most need a review), author →
// alphabetical.
const DEFAULT_DIR = { date: 'desc', approvals: 'asc', author: 'asc' };
const DIRS = ['asc', 'desc'];

export const DEFAULT_SORT = { key: 'date', dir: 'desc' };

// Validates a sort state coming from prefs-v1.json (old/tampered file → default,
// modeled on themeOf). Always returns a fresh copy.
export function normalizeSort(raw) {
  if (!raw || !SORT_KEYS.includes(raw.key) || !DIRS.includes(raw.dir)) return { ...DEFAULT_SORT };
  return { key: raw.key, dir: raw.dir };
}

// Click on a header: same column → flip the direction; other column → that
// column with its default direction.
export function toggleSort(current, key) {
  const cur = normalizeSort(current);
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: DEFAULT_DIR[key] ?? 'asc' };
}

// Comparison value of a row for a key. null = missing (sorted at the end).
function valueOf(row, key) {
  if (key === 'approvals') return row.approvals ?? null; // 0 is a real value
  if (key === 'author') return row.author ? String(row.author).toLowerCase() : null;
  return row.createdAt ?? null; // ISO 8601: lexical comparison is enough
}

// Sorted copy (does not mutate the input). Missing always at the end whatever
// the direction; equality → arrival order preserved (the native sort is stable).
export function sortRows(rows, sort) {
  const { key, dir } = normalizeSort(sort);
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
