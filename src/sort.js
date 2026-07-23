// Tri du tableau « PR des autres » en --serve. C'est un ÉTAT D'AFFICHAGE, comme
// le favori actif (cf. ARCHITECTURE.md §14) : les données restent brutes en
// mémoire, sortRows s'applique au rendu. Un seul critère actif à la fois —
// cliquer sur une autre colonne REMPLACE le tri (jamais de cumul).

export const SORT_KEYS = ['date', 'approvals', 'author'];

// Sens par défaut au premier clic sur une colonne : date → récente d'abord,
// approvals → les moins approuvées d'abord (celles qui ont le plus besoin d'une
// review), author → alphabétique.
const DEFAULT_DIR = { date: 'desc', approvals: 'asc', author: 'asc' };
const DIRS = ['asc', 'desc'];

export const DEFAULT_SORT = { key: 'date', dir: 'desc' };

// Valide un état de tri venu de prefs-v1.json (fichier ancien/trafiqué → défaut,
// calqué sur themeOf). Renvoie toujours une copie fraîche.
export function normalizeSort(raw) {
  if (!raw || !SORT_KEYS.includes(raw.key) || !DIRS.includes(raw.dir)) return { ...DEFAULT_SORT };
  return { key: raw.key, dir: raw.dir };
}

// Clic sur un en-tête : même colonne → inverse le sens ; autre colonne → cette
// colonne avec son sens par défaut.
export function toggleSort(current, key) {
  const cur = normalizeSort(current);
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: DEFAULT_DIR[key] ?? 'asc' };
}

// Valeur de comparaison d'une ligne pour une clé. null = manquante (classée en fin).
function valueOf(row, key) {
  if (key === 'approvals') return row.approvals ?? null; // 0 est une vraie valeur
  if (key === 'author') return row.author ? String(row.author).toLowerCase() : null;
  return row.createdAt ?? null; // ISO 8601 : la comparaison lexicale suffit
}

// Copie triée (ne mute pas l'entrée). Manquants toujours en fin quel que soit le
// sens ; égalité → ordre d'arrivée conservé (le sort natif est stable).
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
