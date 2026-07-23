# Tri du tableau « PR des autres » (--serve) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trier le tableau « Activité sur les PR des autres » en `--serve` par date / approbations / auteur, via des en-têtes de colonne cliquables, persisté dans `prefs-v1.json`.

**Architecture:** Le tri est un état d'affichage (comme le favori actif, §14 d'ARCHITECTURE.md) : `data` reste brut, `sortRows` s'applique au rendu, juste avant `renderFragment`. Un module pur `src/sort.js` porte toute la logique ; `serve.js` ajoute une route `POST /sort` (0 appel GitHub) ; `html.js` rend les `<th>` cliquables avec indicateur ▴/▾.

**Tech Stack:** Node ESM zéro dépendance, runner `node:test`, `gh` CLI stubé en test.

**Spec :** `docs/superpowers/specs/2026-07-23-sort-others-design.md`

## Global Constraints

- Zéro dépendance npm ; tout en Node ESM natif.
- Aucun appel réseau en test (gh stub / fixtures).
- Défaut : `{ key: 'date', dir: 'desc' }`. Sens par défaut au 1er clic : date → `desc`, approvals → `asc`, author → `asc`.
- Un seul critère actif (jamais de tri cumulé). Tableau `others` uniquement (+ lignes masquées si `?hidden=1`). `mine` inchangé.
- Web (`--serve`) uniquement : terminal (`gh notif`, `--watch`) strictement inchangé.
- Valeurs manquantes (`createdAt`/`author` nuls) en fin de liste quel que soit le sens ; égalité → ordre d'arrivée (sort natif stable).
- ⚠️ prefs : muter l'objet `prefs` entier puis `savePrefs(prefsFile, prefs)` — jamais `savePrefs(path, { sort })`.
- Avant de conclure chaque tâche : `npm test` vert et `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`.

---

### Task 1: Module pur `src/sort.js`

**Files:**
- Create: `src/sort.js`
- Test: `test/sort.test.js`

**Interfaces:**
- Produces: `SORT_KEYS: string[]` (`['date','approvals','author']`), `DEFAULT_SORT: {key:'date',dir:'desc'}`, `normalizeSort(raw) → {key,dir}` (toujours valide), `toggleSort(current, key) → {key,dir}`, `sortRows(rows, sort) → rows[]` (copie triée, ne mute pas). Consommés par Task 3 (html.js, indicateur) et Task 4 (serve.js, route + tri au rendu).

- [ ] **Step 1: Écrire les tests qui échouent**

```js
// test/sort.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS, DEFAULT_SORT, normalizeSort, toggleSort, sortRows } from '../src/sort.js';

// Fixtures : 3 PR aux valeurs toutes distinctes (auteur volontairement avec
// une casse mélangée pour tester l'insensibilité à la casse).
const rows = () => [
  { repo: 'o/a', number: 1, author: 'zoe', createdAt: '2026-07-20T00:00:00Z', approvals: 2 },
  { repo: 'o/b', number: 2, author: 'Alice', createdAt: '2026-07-22T00:00:00Z', approvals: 0 },
  { repo: 'o/c', number: 3, author: 'bob', createdAt: '2026-07-21T00:00:00Z', approvals: 1 },
];
const order = (list) => list.map((r) => r.number);

test('normalizeSort : valide passe, invalide/absent → défaut', () => {
  assert.deepEqual(normalizeSort({ key: 'author', dir: 'asc' }), { key: 'author', dir: 'asc' });
  assert.deepEqual(normalizeSort(null), DEFAULT_SORT);
  assert.deepEqual(normalizeSort(undefined), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'nope', dir: 'asc' }), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'date', dir: 'sideways' }), DEFAULT_SORT);
  assert.deepEqual(DEFAULT_SORT, { key: 'date', dir: 'desc' });
  assert.deepEqual(SORT_KEYS, ['date', 'approvals', 'author']);
});

test('normalizeSort renvoie une copie (jamais DEFAULT_SORT lui-même)', () => {
  const s = normalizeSort(null);
  s.dir = 'asc';
  assert.equal(DEFAULT_SORT.dir, 'desc'); // pas pollué par la mutation
});

test('toggleSort : même colonne → inverse le sens', () => {
  assert.deepEqual(toggleSort({ key: 'date', dir: 'desc' }, 'date'), { key: 'date', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'date'), { key: 'date', dir: 'desc' });
});

test('toggleSort : autre colonne → REMPLACE, avec le sens par défaut de la colonne', () => {
  // date → récent d'abord ; approvals → les moins approuvées d'abord ; author → A→Z
  assert.deepEqual(toggleSort({ key: 'date', dir: 'asc' }, 'approvals'), { key: 'approvals', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'approvals', dir: 'desc' }, 'author'), { key: 'author', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'author', dir: 'desc' }, 'date'), { key: 'date', dir: 'desc' });
});

test('sortRows : date desc (défaut) → plus récente d’abord ; asc → inverse', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'date', dir: 'asc' })), [1, 3, 2]);
});

test('sortRows : approvals asc → les moins approuvées d’abord', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'approvals', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows : author insensible à la casse (Alice < bob < zoe)', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'asc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(rows(), { key: 'author', dir: 'desc' })), [1, 3, 2]);
});

test('sortRows : valeurs manquantes en FIN quel que soit le sens', () => {
  const withNulls = [
    { number: 1, author: null, createdAt: null, approvals: 0 },
    { number: 2, author: 'bob', createdAt: '2026-07-22T00:00:00Z', approvals: 1 },
    { number: 3, author: 'alice', createdAt: '2026-07-20T00:00:00Z', approvals: 2 },
  ];
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'desc' })), [2, 3, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'date', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'asc' })), [3, 2, 1]);
  assert.deepEqual(order(sortRows(withNulls, { key: 'author', dir: 'desc' })), [2, 3, 1]);
});

test('sortRows : égalité → ordre d’arrivée conservé (stable)', () => {
  const ties = [
    { number: 1, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 2, approvals: 1, author: 'a', createdAt: 'x' },
    { number: 3, approvals: 1, author: 'a', createdAt: 'x' },
  ];
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'asc' })), [1, 2, 3]);
  assert.deepEqual(order(sortRows(ties, { key: 'approvals', dir: 'desc' })), [1, 2, 3]);
});

test('sortRows : ne mute pas l’entrée, tolère null/undefined', () => {
  const input = rows();
  const before = order(input);
  sortRows(input, { key: 'date', dir: 'asc' });
  assert.deepEqual(order(input), before);
  assert.deepEqual(sortRows(null, DEFAULT_SORT), []);
  assert.deepEqual(sortRows(undefined, DEFAULT_SORT), []);
});

test('sortRows : sort invalide → tri par défaut (date desc), pas de crash', () => {
  assert.deepEqual(order(sortRows(rows(), { key: 'nope' })), [2, 3, 1]);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test test/sort.test.js`
Expected: FAIL — `Cannot find module '../src/sort.js'`

- [ ] **Step 3: Implémenter `src/sort.js`**

```js
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
```

- [ ] **Step 4: Vérifier le vert**

Run: `node --test test/sort.test.js`
Expected: PASS (tous les tests)

- [ ] **Step 5: Vérifs globales + commit**

Run: `npm test && for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`
Expected: tout vert.

```bash
git add src/sort.js test/sort.test.js
git commit -m "feat: module pur de tri des PR des autres (sort.js)"
```

---

### Task 2: Clé `sort` dans les prefs

**Files:**
- Modify: `src/prefs.js:16` (DEFAULTS)
- Test: `test/prefs.test.js` (5 `deepEqual` existants à compléter + 1 test neuf)

**Interfaces:**
- Consumes: rien (la validation vit dans `normalizeSort`, Task 1 — prefs stocke la valeur brute).
- Produces: `loadPrefs(path).sort` — `null` par défaut (= « non choisi », `normalizeSort` appliquera `DEFAULT_SORT`), sinon l'objet `{key,dir}` persisté.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à la fin de `test/prefs.test.js` :

```js
test('loadPrefs : sort null par défaut, persisté tel quel sans perdre les autres clés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'prefs.json');
  // Fichier antérieur au tri : la clé apparaît, nulle (normalizeSort fera le défaut).
  savePrefs(p, { notify: false });
  assert.equal(loadPrefs(p).sort, null);
  // Round-trip : on mute l'objet ENTIER puis on le réécrit (piège habituel).
  const prefs = loadPrefs(p);
  prefs.sort = { key: 'author', dir: 'asc' };
  savePrefs(p, prefs);
  assert.deepEqual(loadPrefs(p), {
    notify: false, theme: 'auto', favorites: [], activeFav: null,
    sort: { key: 'author', dir: 'asc' },
  });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test test/prefs.test.js`
Expected: FAIL — `loadPrefs(p).sort` vaut `undefined`, pas `null`.

- [ ] **Step 3: Implémenter**

Dans `src/prefs.js`, ligne 16 :

```js
const DEFAULTS = { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null };
```

Et compléter le commentaire de tête (lignes 5-10) : `favorites`/`activeFav`… ajouter `sort` (tri du tableau « autres » en --serve, validé par `normalizeSort` à l'usage).

- [ ] **Step 4: Mettre à jour les 5 `deepEqual` existants**

Les assertions de `test/prefs.test.js` lignes 16, 25, 33, 81 et 95 comparent l'objet complet : ajouter `sort: null` à chacune. Exemple ligne 16 :

```js
assert.deepEqual(loadPrefs('/nope/nope/prefs.json'), { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null });
```

(même ajout `sort: null` aux 4 autres.)

- [ ] **Step 5: Vérifier le vert + commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/prefs.js test/prefs.test.js
git commit -m "feat: clé sort persistée dans prefs-v1.json"
```

---

### Task 3: En-têtes cliquables dans `html.js`

**Files:**
- Modify: `src/html.js` (`table`, `othersTable`, `renderFragment`, `renderShell` : CSS + JS)
- Test: `test/html.test.js`

**Interfaces:**
- Consumes: rien de sort.js — `renderFragment` reçoit l'état `{key,dir}` déjà validé via `opts.sort`.
- Produces: `renderFragment(data, { …, sort })` — si `opts.sort` est fourni, les `<th>` Auteur / Ouverte / ✅ du tableau « autres » portent `data-sort-key="author|date|approvals"`, la colonne active porte l'indicateur ` ▴`/` ▾`. **Sans `opts.sort`, sortie strictement inchangée** (compat tests/appels existants). Le shell (`renderShell`) gère le clic → `POST /sort?key=…` (Task 4 fournit la route).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/html.test.js` (mêmes imports que le fichier existant — `renderFragment`, `renderShell` y sont déjà importés) :

```js
test('renderFragment avec opts.sort : th cliquables + indicateur sur la colonne active', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: '2026-07-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'date', dir: 'desc' } });
  assert.match(html, /<th[^>]*data-sort-key="author"[^>]*>Auteur<\/th>/);
  assert.match(html, /<th[^>]*data-sort-key="date"[^>]*>Ouverte ▾<\/th>/); // colonne active + sens
  assert.match(html, /<th[^>]*data-sort-key="approvals"/);
  // asc → ▴
  const asc = renderFragment(data, { now: Date.parse('2026-07-23T00:00:00Z'), sort: { key: 'author', dir: 'asc' } });
  assert.match(asc, /<th[^>]*data-sort-key="author"[^>]*>Auteur ▴<\/th>/);
  assert.match(asc, /<th[^>]*data-sort-key="date"[^>]*>Ouverte<\/th>/); // inactive : pas d'indicateur
});

test('renderFragment sans opts.sort : sortie inchangée (aucun data-sort-key)', () => {
  const data = { mine: [], others: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', author: 'alice', createdAt: null, additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
  ] };
  const html = renderFragment(data, { now: 0 });
  assert.ok(!html.includes('data-sort-key'), 'compat : pas de th triable sans opts.sort');
});

test('le tableau « Tes PR » n’a jamais d’en-tête triable', () => {
  const data = { mine: [
    { repo: 'o/r', number: 1, url: 'u', title: 't', triggers: [], ci: 'pass', state: 'open', approvals: 0 },
  ], others: [] };
  const html = renderFragment(data, { now: 0, sort: { key: 'date', dir: 'desc' } });
  assert.ok(!html.includes('data-sort-key'), 'mine : aucun tri');
});

test('renderShell : le JS gère le clic sur th[data-sort-key] → POST /sort', () => {
  const page = renderShell({});
  assert.match(page, /data-sort-key/);
  assert.match(page, /\/sort/);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test test/html.test.js`
Expected: FAIL sur les 4 nouveaux tests (pas de `data-sort-key`).

- [ ] **Step 3: Implémenter dans `src/html.js`**

3a. `table()` accepte des en-têtes enrichis (string = comportement actuel) :

```js
// Un en-tête est soit une chaîne (th nu), soit { html, attrs } (th triable —
// attrs porte data-sort-key pour la délégation de clic côté client).
function table(headers, rows) {
  const head = `<thead><tr>${headers
    .map((h) => (typeof h === 'string' ? `<th>${h}</th>` : `<th${h.attrs}>${h.html}</th>`))
    .join('')}</tr></thead>`;
  const body = `<tbody>${rows.join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}
```

3b. Helper d'en-tête triable (près de `APPROVALS_TH`) :

```js
// Indicateur de tri sur la colonne active (▴ asc / ▾ desc).
const SORT_ARROW = { asc: ' ▴', desc: ' ▾' };

// En-tête triable : data-sort-key (délégation de clic, cf. renderShell) +
// indicateur si c'est la colonne active. `sort` absent → th nu (compat).
function sortableTh(html, key, sort) {
  if (!sort) return html;
  const active = sort.key === key;
  return {
    attrs: ` data-sort-key="${key}" title="Trier"`,
    html: active ? `${html}${SORT_ARROW[sort.dir] ?? ''}` : html,
  };
}
```

3c. `othersTable` reçoit et applique `sort` :

```js
function othersTable(others, hiddenRows, now, showHidden, sort = null) {
  const headers = [
    'Dépôt', 'PR', 'Titre',
    sortableTh('Auteur', 'author', sort),
    sortableTh('Ouverte', 'date', sort),
    'Diff', 'État',
    sortableTh(APPROVALS_TH, 'approvals', sort),
    'Triggers', 'CI', '',
  ];
  const trs = [
    ...others.map((r) => otherRow(r, now, false)),
    ...(showHidden ? hiddenRows.map((r) => otherRow(r, now, true)) : []),
  ];
  return table(headers, trs);
}
```

3d. `renderFragment` : extraire `const sort = opts.sort ?? null;` (à côté de `closedUrl`) et passer `sort` à l'appel `othersTable(others, hiddenRows, now, showHidden, sort)`. Compléter le commentaire de tête de `renderFragment` : `sort` (optionnel) = état de tri `{key,dir}` du tableau « autres » — en-têtes cliquables + indicateur ; absent → th nus (compat).

3e. CSS dans `renderShell` (après la règle `th { … }`, vers la ligne 301) :

```css
  th[data-sort-key] { cursor: pointer; user-select: none; }
  th[data-sort-key]:hover { color: var(--accent); }
```

3f. JS dans `renderShell` — remplacer le listener `content` existant :

```js
  content.addEventListener('click', function (e) {
    // Tri : clic sur un en-tête triable du tableau « autres ».
    var th = e.target.closest('th[data-sort-key]');
    if (th) { act('/sort', 'key=' + encodeURIComponent(th.getAttribute('data-sort-key'))); return; }
    var btn = e.target.closest('.act');
    if (!btn) return;
    act('/hide', 'key=' + encodeURIComponent(btn.getAttribute('data-key')));
  });
```

⚠️ `APPROVALS_TH` contient un `<abbr>` avec `cursor:help` : inchangé, le `cursor:pointer` du th s'applique autour — pas de conflit fonctionnel (le clic sur l'abbr remonte au th par la délégation `closest`).

- [ ] **Step 4: Vérifier le vert**

Run: `node --test test/html.test.js`
Expected: PASS (nouveaux + anciens tests — la compat sans `opts.sort` garde les anciens verts).

- [ ] **Step 5: Vérifs globales + commit**

Run: `npm test && for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`
Expected: tout vert.

```bash
git add src/html.js test/html.test.js
git commit -m "feat: en-têtes triables (Auteur/Ouverte/✅) dans le tableau des autres"
```

---

### Task 4: Route `POST /sort` + tri appliqué au rendu (`serve.js`)

**Files:**
- Modify: `src/serve.js` (import, `fragmentBody`, `handleRequest`, `currentView`, état `sort`, route POST)
- Test: `test/serve.test.js`

**Interfaces:**
- Consumes: `normalizeSort`, `toggleSort`, `sortRows`, `SORT_KEYS` (Task 1) ; `renderFragment(data, { …, sort })` (Task 3) ; `prefs.sort` (Task 2).
- Produces: `handleRequest(pathname, snapshot, { …, sort })` (GET, pur) ; `POST /sort?key=date|approvals|author` → JSON `{chips, fragment, updatedAt}` (clé inconnue → 400) ; persistance `prefs.sort`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/serve.test.js` :

```js
// ── tri du tableau « autres » ──────────────────────────────────────────────
const sortedSnapshot = () => ({
  data: {
    mine: [],
    others: [
      { repo: 'o/old', number: 1, url: 'u', title: 'vieille', author: 'zoe', createdAt: '2026-06-01T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 2 },
      { repo: 'o/new', number: 2, url: 'u', title: 'récente', author: 'alice', createdAt: '2026-06-20T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
    ],
  },
  updatedAt: NOW,
  error: null,
});

test('GET /fragment : opts.sort trie les autres et marque la colonne active', () => {
  const desc = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'date', dir: 'desc' } });
  assert.ok(desc.body.indexOf('o/new#2') < desc.body.indexOf('o/old#1'), 'date desc : récente d’abord');
  assert.match(desc.body, /data-sort-key="date"[^>]*>Ouverte ▾/);
  const byAuthor = handleRequest('/fragment', sortedSnapshot(), { ...OPTS, sort: { key: 'author', dir: 'asc' } });
  assert.ok(byAuthor.body.indexOf('o/new#2') < byAuthor.body.indexOf('o/old#1'), 'alice avant zoe');
});

test('GET /fragment?hidden : les lignes masquées suivent le même tri', () => {
  const snap = sortedSnapshot();
  snap.data.hidden = [
    { repo: 'o/hb', number: 8, url: 'u', title: 'b', author: 'bob', createdAt: '2026-06-05T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
    { repo: 'o/ha', number: 9, url: 'u', title: 'a', author: 'ann', createdAt: '2026-06-10T00:00:00Z', additions: 0, deletions: 0, triggers: ['review'], ci: 'none', state: 'open', approvals: 0 },
  ];
  snap.data.hiddenCount = 2;
  const res = handleRequest('/fragment', snap, { ...OPTS, showHidden: true, sort: { key: 'date', dir: 'desc' } });
  assert.ok(res.body.indexOf('o/ha#9') < res.body.indexOf('o/hb#8'), 'masquées triées aussi (date desc)');
});

test('POST /sort : trie, inverse au re-clic, persiste, 400 sur clé inconnue', async () => {
  const gh = {
    getCurrentUser: async () => 'moi',
    listNotifications: async () => [],
    searchReviewRequested: async () => [
      { repository_url: 'https://api.github.com/repos/o/old', number: 1, title: 'vieille', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
      { repository_url: 'https://api.github.com/repos/o/new', number: 2, title: 'récente', html_url: 'u', updated_at: '2026-06-24T00:00:00Z' },
    ],
    searchAuthored: async () => [],
    getPullDetailsBatch: async (prs) => prs.map((p) => ({
      number: p.number, title: p.number === 1 ? 'vieille' : 'récente',
      author: { login: p.number === 1 ? 'zoe' : 'alice' },
      createdAt: p.number === 1 ? '2026-06-01T00:00:00Z' : '2026-06-20T00:00:00Z',
      additions: 0, deletions: 0, isDraft: false, state: 'OPEN', reviews: [], statusCheckRollupState: 'SUCCESS',
    })),
    getComment: async () => null,
    getReviewComments: async () => [],
  };
  const tmp = `/tmp/gh-notif-test-sort-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  process.env.XDG_STATE_HOME = tmp;

  const PORT = 7797;
  const server = serve({ gh, me: 'moi', scope: null, port: PORT, intervalSeconds: 3600 });
  try {
    await new Promise((r) => setTimeout(r, 250)); // 1er poll
    // Défaut date desc : la récente (#2) d'abord.
    const frag1 = await (await fetch(`http://localhost:${PORT}/fragment`)).text();
    assert.ok(frag1.indexOf('o/new#2') < frag1.indexOf('o/old#1'), 'défaut : date desc');

    // Clic « Auteur » → alice avant zoe, et l'état est persisté sur disque.
    const r1 = await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.ok(d1.fragment.indexOf('o/new#2') < d1.fragment.indexOf('o/old#1'), 'author asc : alice d’abord');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'asc' });

    // Re-clic « Auteur » → sens inversé.
    const d2 = await (await fetch(`http://localhost:${PORT}/sort?key=author`, { method: 'POST' })).json();
    assert.ok(d2.fragment.indexOf('o/old#1') < d2.fragment.indexOf('o/new#2'), 'author desc : zoe d’abord');
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });

    // Clé inconnue → 400, préférence intacte.
    const bad = await fetch(`http://localhost:${PORT}/sort?key=nope`, { method: 'POST' });
    assert.equal(bad.status, 400);
    assert.deepEqual(loadPrefs(prefsPath()).sort, { key: 'author', dir: 'desc' });
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test test/serve.test.js`
Expected: FAIL — pas de tri dans `/fragment`, `POST /sort` → 404.

- [ ] **Step 3: Implémenter dans `src/serve.js`**

3a. Import (avec les autres imports src) :

```js
import { normalizeSort, toggleSort, sortRows, SORT_KEYS } from './sort.js';
```

3b. `fragmentBody` : le tri s'applique ICI, au rendu, après le filtre de favori — jamais à la collecte (même règle que §14) :

```js
function fragmentBody(snapshot, { now, showHidden, viewScope = null, closedUrl = null, sort = null } = {}) {
  if (snapshot.error) return `<p class="empty offline">⚠️ Erreur : ${escapeHtml(snapshot.error)}</p>`;
  if (!snapshot.updatedAt) return renderLoading();
  let data = filterDataByScope(snapshot.data ?? { mine: [], others: [] }, viewScope);
  // Tri d'affichage du tableau « autres » (les masquées suivent, cohérence en
  // mode ?hidden=1). `sort` absent → ordre de collecte inchangé (compat).
  if (sort) data = { ...data, others: sortRows(data.others, sort), hidden: sortRows(data.hidden, sort) };
  return renderFragment(data, { now, showHidden, closedUrl, sort });
}
```

3c. `handleRequest` : ajouter `sort = null` à la destructuration des opts et le passer aux deux appels `fragmentBody` (routes `/fragment` et `/view`) : `fragmentBody(snapshot, { now, showHidden, viewScope, closedUrl, sort })`.

3d. Dans `serve()` : état mutable initialisé depuis les prefs (près de `let theme = themeOf(prefs);`) :

```js
  let sort = normalizeSort(prefs.sort); // tri du tableau « autres » (persisté)
```

3e. `currentView` : passer `sort` au `fragmentBody` interne (même objet d'opts que `viewScope`/`closedUrl`).

3f. Route POST (avec les autres, avant `/notify`) :

```js
      if (pathname === '/sort') {
        // Tri = état d'affichage pur : recompute local, AUCUN appel GitHub.
        const key = url.searchParams.get('key');
        if (!SORT_KEYS.includes(key)) return send(400, 'text/plain; charset=utf-8', `clé de tri inconnue : ${key ?? ''}`);
        sort = toggleSort(sort, key);
        prefs.sort = sort; // ⚠️ muter + réécrire EN ENTIER (sinon notify/theme perdus)
        savePrefs(prefsFile, prefs);
        return send(200, json, currentView(showHidden));
      }
```

3g. L'appel GET `handleRequest(...)` en bas de `createServer` : ajouter `sort,` aux opts passés.

- [ ] **Step 4: Vérifier le vert**

Run: `node --test test/serve.test.js`
Expected: PASS (nouveaux + anciens — les anciens tests `handleRequest` sans `sort` restent inchangés car `sort = null` → pas de tri).

- [ ] **Step 5: Vérifs globales + commit**

Run: `npm test && for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`
Expected: tout vert.

```bash
git add src/serve.js test/serve.test.js
git commit -m "feat: tri du tableau des autres en --serve (POST /sort, persisté)"
```

---

### Task 5: Documentation + smoke test

**Files:**
- Modify: `docs/ARCHITECTURE.md` (tableau des modules + nouveau piège §15)

**Interfaces:** aucune (doc).

- [ ] **Step 1: Ajouter `sort.js` au tableau des modules**

Après la ligne `src/ratelimit.js` du tableau :

```markdown
| `src/sort.js` | Tri du tableau « PR des autres » en `--serve` : `normalizeSort`, `toggleSort` (cycle des clics), `sortRows` (copie triée, manquants en fin). Purs. | oui |
```

- [ ] **Step 2: Documenter la décision (nouveau §15, après §14)**

```markdown
15. **Tri des « PR des autres » (`--serve`) = état d'affichage, comme le favori actif.** Un seul
    critère `{key: date|approvals|author, dir}` (jamais de cumul multi-colonnes), persisté dans
    `prefs-v1.json` (clé `sort`, `null` par défaut — `normalizeSort` applique `{date, desc}` à
    l'usage, aucune migration). Le tri s'applique dans `fragmentBody` (serve.js), APRÈS
    `filterDataByScope` et jamais à la collecte — même ordre critique que §14 (`data` reste brut :
    masquage, notifs et compteurs de favoris ne voient aucun changement). Les lignes masquées
    (`?hidden=1`) suivent le même tri. `POST /sort?key=…` = `toggleSort` (même colonne → inverse ;
    autre → sens par défaut : date `desc`, approvals `asc` — les moins approuvées d'abord —,
    author `asc`) + recompute local, **0 appel GitHub**. En-têtes cliquables rendus par
    `sortableTh` (html.js) **seulement si `opts.sort` est fourni** à `renderFragment` — sans lui,
    sortie strictement inchangée (compat ; le terminal ne trie pas). Manquants (`author`/
    `createdAt` nuls) en fin de liste quel que soit le sens ; égalité → ordre d'arrivée (sort
    stable). « Tes PR » n'est jamais triable. Spec :
    `docs/superpowers/specs/2026-07-23-sort-others-design.md`.
```

- [ ] **Step 3: Smoke test manuel du rendu**

Run:
```bash
node --input-type=module -e "
import { renderFragment } from './src/html.js';
const data = { mine: [], others: [
  { repo: 'o/a', number: 1, url: 'u', title: 'A', author: 'zoe', createdAt: '2026-07-01T00:00:00Z', additions: 1, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 2 },
  { repo: 'o/b', number: 2, url: 'u', title: 'B', author: 'al', createdAt: '2026-07-20T00:00:00Z', additions: 1, deletions: 0, triggers: ['review'], ci: 'pass', state: 'open', approvals: 0 },
] };
console.log(renderFragment(data, { now: Date.now(), sort: { key: 'date', dir: 'desc' } }).slice(0, 400));
"
```
Expected: en-têtes avec `data-sort-key` et `Ouverte ▾` présents, aucune erreur.

- [ ] **Step 4: Vérifs finales + commit**

Run: `npm test && for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`
Expected: tout vert.

```bash
git add docs/ARCHITECTURE.md
git commit -m "doc: tri des PR des autres (module sort.js, piège §15)"
```
