# Masquage clavier des PR des autres — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Masquer au clavier des PR de la table « autres » (jamais les miennes), avec réapparition au prochain trigger, et une option pour réafficher/restaurer les masquées.

**Architecture :** Logique pure de masquage dans `src/hidden.js` (persistance + signatures + réconciliation + labels). `collectPRs` filtre les masquées hors `others`. `render.js` ajoute une colonne de lettres (mode masquage) et un rendu grisé+🙈 (vue masquées). L'entrypoint `gh-notif` gère le clavier (raw mode borné, garde TTY) en watch et en one-shot.

**Tech Stack :** Node ESM, zéro dépendance npm, `node:readline` pour les keypress, tests `node:test`.

## Global Constraints

- Zéro dépendance npm ; ESM ; `node --check` doit passer sur tous les fichiers.
- Interactivité **uniquement** si `process.stdin.isTTY && process.stdout.isTTY` — sinon « affiche puis rend la main » comme aujourd'hui (pas de régression pipe/scripts).
- **Pas** de capture souris, **pas** d'alt-screen : raw mode actif seulement pendant l'écoute clavier.
- On ne masque **jamais** une PR de `mine`.
- Réapparition : une PR masquée revient dès qu'une **URL d'évènement de trigger** absente de son instantané apparaît.
- Apostrophes typographiques `U+2019` dans les libellés FR (`Esc pour sortir`, etc. — pas d'apostrophe ici mais respecter la convention si ajout).
- Persistance : `~/.local/state/gh-notif/hidden-v1.json` (base `XDG_STATE_HOME` ou `~/.local/state`).
- Avant de conclure : `npm test` vert **et** `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`.
- Le runner shell réinitialise le cwd : préfixer les commandes par `cd /home/nikophil/works/github.com/nikophil/gh-notif &&`.

---

### Task 1 : `src/hidden.js` — cœur pur du masquage

**Files:**
- Create: `src/hidden.js`
- Create: `test/hidden.test.js`
- Modify: `src/filter.js` (déplacer/exporter `TRIGGER_FOR` ici pour éviter un cycle d'import)
- Modify: `src/collect.js` (importer `TRIGGER_FOR` depuis `filter.js` au lieu de le définir)

**Interfaces:**
- Consumes: `CATEGORY` de `filter.js`.
- Produces:
  - `hiddenPath() : string`
  - `loadHidden(path) : map` / `saveHidden(path, map) : void`
  - `keyOf(x) : string` — `` `${x.repo}#${x.number}` ``
  - `signatureOf(key, items) : string[]` — URLs des items de trigger de cette PR
  - `isHidden(map, key) : boolean`
  - `toggleHidden(map, key, items, nowIso?) : boolean` (mute ; renvoie `true` si désormais masquée)
  - `reconcile(map, entries, items) : boolean` (mute ; renvoie `true` si la map a changé)
  - `assignLabels(rows) : string[]` — numéro (`'1'`, `'2'`…) par ligne, dans l'ordre d'affichage

**Pourquoi déplacer `TRIGGER_FOR` :** `hidden.js` doit savoir quels items portent un trigger pour calculer la signature ; `collect.js` importe `hidden.js`. Mettre `TRIGGER_FOR` dans `filter.js` (où vit déjà `CATEGORY`) évite le cycle `collect ↔ hidden`.

- [ ] **Step 1 : déplacer `TRIGGER_FOR` dans `filter.js`**

Dans `src/filter.js`, après l'export de `CATEGORY`, ajouter :

```js
// Triggers dérivés des notifications (SANS review_request : cf. collect.js / ARCHITECTURE §1).
// Vit ici (et non dans collect.js) pour être partagé avec hidden.js sans cycle d'import.
export const TRIGGER_FOR = {
  [CATEGORY.MENTION]: 'mention',
  [CATEGORY.THREAD_REPLY]: 'reply',
  [CATEGORY.ON_MY_PR]: 'comment',
};
```

Dans `src/collect.js` : supprimer la définition locale de `TRIGGER_FOR` (lignes ~11-15) et l'importer :

```js
import { classify, CATEGORY, TRIGGER_FOR } from './filter.js';
```

- [ ] **Step 2 : écrire les tests de `hidden.js`**

`test/hidden.test.js` :

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, signatureOf, isHidden, toggleHidden, reconcile, assignLabels } from '../src/hidden.js';

// NB : `category` porte les valeurs de CATEGORY (filter.js) : thread_reply / on_my_pr / mention.
const items = [
  { category: 'thread_reply', repo: 'o/r', number: 42, url: 'u1' },
  { category: 'mention', repo: 'o/r', number: 42, url: 'u2' },
  { category: 'review_request', repo: 'o/r', number: 42, url: 'pr-url' }, // ignoré (pas un trigger)
  { category: 'on_my_pr', repo: 'o/x', number: 7, url: 'u3' },
];

test('keyOf', () => {
  assert.equal(keyOf({ repo: 'o/r', number: 42 }), 'o/r#42');
});

test('signatureOf : URLs des items de trigger de la PR (review_request exclu)', () => {
  assert.deepEqual(signatureOf('o/r#42', items).sort(), ['u1', 'u2']);
  assert.deepEqual(signatureOf('o/x#7', items), ['u3']);
  assert.deepEqual(signatureOf('o/none#1', items), []);
});

test('toggleHidden : masque avec instantané puis restaure', () => {
  const map = {};
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T00:00:00.000Z'), true);
  assert.equal(isHidden(map, 'o/r#42'), true);
  assert.deepEqual(map['o/r#42'].seen.sort(), ['u1', 'u2']);
  assert.equal(map['o/r#42'].at, '2026-06-25T00:00:00.000Z');
  // re-toggle → restaure
  assert.equal(toggleHidden(map, 'o/r#42', items, '2026-06-25T01:00:00.000Z'), false);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile : dé-masque sur nouveau trigger, garde si signature inchangée', () => {
  const map = { 'o/r#42': { at: 'x', seen: ['u1', 'u2'] } };
  const entries = [{ repo: 'o/r', number: 42 }];
  // signature inchangée → reste masquée, pas de changement
  assert.equal(reconcile(map, entries, items), false);
  assert.equal(isHidden(map, 'o/r#42'), true);
  // nouvel évènement u9 → dé-masque
  const items2 = [...items, { category: 'reply', repo: 'o/r', number: 42, url: 'u9' }];
  assert.equal(reconcile(map, entries, items2), true);
  assert.equal(isHidden(map, 'o/r#42'), false);
});

test('reconcile : signature vide reste masquée (review en attente sans interaction)', () => {
  const map = { 'o/r#60': { at: 'x', seen: [] } };
  const entries = [{ repo: 'o/r', number: 60 }];
  assert.equal(reconcile(map, entries, []), false);
  assert.equal(isHidden(map, 'o/r#60'), true);
});

test('reconcile : élague une clé absente des entrées courantes', () => {
  const map = { 'o/r#99': { at: 'x', seen: [] } };
  assert.equal(reconcile(map, [{ repo: 'o/r', number: 1 }], []), true);
  assert.equal(isHidden(map, 'o/r#99'), false);
});

test('assignLabels : numéros 1..N dans l’ordre d’affichage', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ repo: 'o/r', number: i }));
  const labels = assignLabels(rows);
  assert.equal(labels[0], '1');
  assert.equal(labels[8], '9');
  assert.equal(labels[9], '10');   // scale au-delà de 9
  assert.equal(labels[11], '12');
});
```

- [ ] **Step 3 : lancer les tests → échec (module absent)**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: FAIL — `Cannot find module '../src/hidden.js'`.

- [ ] **Step 4 : implémenter `src/hidden.js`**

```js
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TRIGGER_FOR } from './filter.js';

export function hiddenPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'hidden-v1.json');
}

export function loadHidden(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function saveHidden(path, map) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
}

export function keyOf(x) {
  return `${x.repo}#${x.number}`;
}

// URLs des items de notification qui portent un trigger (mention/reply/comment)
// pour cette PR. review_request est exclu (cf. TRIGGER_FOR) : sa signature est vide.
export function signatureOf(key, items) {
  const urls = [];
  for (const it of items || []) {
    if (keyOf(it) === key && TRIGGER_FOR[it.category] && it.url) urls.push(it.url);
  }
  return [...new Set(urls)];
}

export function isHidden(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Masque (instantané de la signature courante) ou restaure. Renvoie true si désormais masquée.
export function toggleHidden(map, key, items, nowIso = new Date().toISOString()) {
  if (isHidden(map, key)) { delete map[key]; return false; }
  map[key] = { at: nowIso, seen: signatureOf(key, items) };
  return true;
}

// Dé-masque une PR dès qu'un nouvel évènement apparaît, élague les clés absentes
// des entrées courantes. Mute la map ; renvoie true si elle a changé.
export function reconcile(map, entries, items) {
  const present = new Set((entries || []).map(keyOf));
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!present.has(key)) { delete map[key]; changed = true; continue; }
    const seen = new Set(map[key].seen || []);
    const hasNew = signatureOf(key, items).some((u) => !seen.has(u));
    if (hasNew) { delete map[key]; changed = true; }
  }
  return changed;
}

// Numéro par ligne (dans l'ordre d'affichage) : '1', '2', '3'…  Saisi au clavier
// (buffer + Entrée) dans l'entrypoint, donc multi-chiffres OK — aucune limite.
export function assignLabels(rows) {
  return rows.map((_, i) => String(i + 1));
}
```

- [ ] **Step 5 : lancer les tests → succès**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: PASS (hidden + collect + render + tous les anciens tests, `TRIGGER_FOR` déplacé sans régression).

- [ ] **Step 6 : commit**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
git add src/hidden.js test/hidden.test.js src/filter.js src/collect.js
git commit -m "feat(hidden): cœur pur du masquage (signatures, reconcile, labels)"
```

---

### Task 2 : intégration dans `collectPRs`

**Files:**
- Modify: `src/collect.js` (`collectPRs` : option `hidden`, filtrage, `reconcile`, valeurs de retour)
- Modify: `test/collect.test.js` (nouveaux cas)

**Interfaces:**
- Consumes: `reconcile`, `isHidden`, `keyOf` de `hidden.js`.
- Produces: `collectPRs(gh, me, { all, scope, hidden }) → { mine, others, hidden, hiddenCount, hiddenChanged, notifications }` où `hidden` (retour) est la **liste des lignes masquées** et l'option `hidden` est la **map** (défaut `{}`).

- [ ] **Step 1 : écrire les tests**

Ajouter à `test/collect.test.js` (import en tête : `import { collectPRs } from '../src/collect.js';` déjà présent) :

```js
test('collectPRs: une PR « autres » masquée sort de others et passe dans hidden', async () => {
  const gh = fakeGh({
    search: [{ number: 60, title: 'À review', html_url: 'https://github.com/o/r/pull/60', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 60, title: 'À review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const hidden = { 'o/r#60': { at: 'x', seen: [] } };
  const { others, hidden: hiddenRows, hiddenCount } = await collectPRs(gh, ME, { hidden });
  assert.equal(others.length, 0);
  assert.equal(hiddenCount, 1);
  assert.equal(hiddenRows[0].number, 60);
});

test('collectPRs: on ne masque JAMAIS une PR à moi', async () => {
  const gh = fakeGh({
    authored: [{ number: 81, title: 'Ma PR', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 81, title: 'Ma PR', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const hidden = { 'o/x#81': { at: 'x', seen: [] } }; // même si présente dans la map
  const { mine, hiddenCount } = await collectPRs(gh, ME, { hidden });
  assert.equal(mine.length, 1);     // reste dans mine
  assert.equal(hiddenCount, 0);     // jamais comptée comme masquée
});

test('collectPRs: dé-masquage au nouveau trigger (reconcile) + hiddenChanged', async () => {
  const thread = {
    id: 't1', reason: 'subscribed', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR R', url: 'https://api.github.com/repos/o/r/pulls/50', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const gh = fakeGh({
    notifications: [thread],
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/50#discussion_r2' },
    ],
    details: () => ({ number: 50, title: 'PR R', author: { login: 'bob' }, createdAt: '2026-06-20T12:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  // masquée avec un instantané vide → l'évènement #discussion_r2 est « nouveau »
  const hidden = { 'o/r#50': { at: 'x', seen: [] } };
  const { others, hiddenCount, hiddenChanged } = await collectPRs(gh, ME, { hidden });
  assert.equal(others.length, 1);    // réapparue
  assert.equal(hiddenCount, 0);
  assert.equal(hiddenChanged, true); // reconcile a modifié la map
  assert.equal('o/r#50' in hidden, false);
});
```

- [ ] **Step 2 : lancer → échec**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: FAIL — `hiddenCount`/`hidden` (rows)/`hiddenChanged` `undefined`.

- [ ] **Step 3 : modifier `collectPRs`**

En tête de `src/collect.js`, ajouter l'import :

```js
import { reconcile, isHidden, keyOf } from './hidden.js';
```

Remplacer la signature et le bloc de split (lignes ~138-192) par :

```js
export async function collectPRs(gh, me, { all = false, scope = null, hidden = {} } = {}) {
  const [items, pending, authored] = await Promise.all([
    collectNotifications(gh, me, { all, scope }),
    collectPending(gh, scope),
    collectAuthored(gh, scope),
  ]);

  const byKey = new Map();
  const ensure = (repo, number, title) => {
    const key = `${repo}#${number}`;
    if (!byKey.has(key)) {
      byKey.set(key, { repo, number, title, url: `https://github.com/${repo}/pull/${number}`, triggers: new Set() });
    }
    return byKey.get(key);
  };
  for (const it of items) {
    const trig = TRIGGER_FOR[it.category];
    if (!trig) continue;
    const row = ensure(it.repo, it.number, it.title);
    row.triggers.add(trig);
    row.url = it.url;
  }
  for (const p of pending) ensure(p.repo, p.number, p.title).triggers.add('review');
  for (const a of authored) ensure(a.repo, a.number, a.title);

  const entries = [...byKey.values()];
  const details = await gh.getPullDetailsBatch(entries.map((e) => ({ repo: e.repo, number: e.number })));

  const mine = [];
  const othersAll = []; // PR des autres (hors draft), avant filtrage du masquage
  entries.forEach((e, i) => {
    const d = details[i];
    const row = {
      repo: e.repo,
      number: e.number,
      url: e.url,
      title: d?.title ?? e.title,
      triggers: [...e.triggers],
      author: d?.author?.login ?? null,
      createdAt: d?.createdAt ?? null,
      additions: d?.additions ?? 0,
      deletions: d?.deletions ?? 0,
      ci: ciFromState(d?.statusCheckRollupState),
      state: prState(d),
      approvals: countApprovals(d?.reviews),
    };
    if (d && d.author?.login === me) mine.push(row); // mes PR : jamais masquées, on garde mes drafts
    else if (row.state !== 'draft') othersAll.push(row); // PR des autres : on masque les drafts
  });

  // Dé-masque sur nouveau trigger + élague les clés obsolètes (mute `hidden`).
  const hiddenChanged = reconcile(hidden, othersAll, items);
  const others = othersAll.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = othersAll.filter((r) => isHidden(hidden, keyOf(r)));

  return { mine, others, hidden: hiddenRows, hiddenCount: hiddenRows.length, hiddenChanged, notifications: items };
}
```

- [ ] **Step 4 : lancer → succès**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: PASS (anciens tests `collectPRs` toujours verts : sans option `hidden`, rien n'est masqué).

- [ ] **Step 5 : commit**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
git add src/collect.js test/collect.test.js
git commit -m "feat(hidden): filtrer les PR masquées dans collectPRs"
```

---

### Task 3 : rendu (colonne de lettres + vue masquées)

**Files:**
- Modify: `src/render.js` (`othersTable`/`renderList` : `hideMode`, `labels`, `hiddenFlags`, compteur masquées)
- Modify: `test/render.test.js`

**Interfaces:**
- Consumes: rien de neuf (labels/flags fournis par l'appelant).
- Produces: `renderList(data, opts)` où `opts` accepte en plus `{ hideMode, labels, hiddenFlags }` et `data` accepte `hiddenCount`. Rétro-compatible : sans ces champs, rendu identique à aujourd'hui.

- [ ] **Step 1 : écrire les tests**

Ajouter à `test/render.test.js` (helper de dépouillement ANSI/OSC déjà présent dans ce fichier ; sinon utiliser le pattern ci-dessous) :

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderList, displayWidth } from '../src/render.js';

const strip = (s) => s
  .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '') // OSC 8 (liens)
  .replace(/\x1b\[[0-9;]*m/g, '');          // SGR (couleurs)

const others = [
  { repo: 'o/r', number: 60, url: 'u', title: 'À review', triggers: ['review'], author: 'carol', createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, ci: 'pass', state: 'open', approvals: 0 },
  { repo: 'o/x', number: 7, url: 'v', title: 'Autre', triggers: ['reply'], author: 'bob', createdAt: '2026-06-19T09:00:00Z', additions: 2, deletions: 0, ci: 'none', state: 'open', approvals: 1 },
];

test('renderList: mode masquage affiche une colonne de numéros alignée', () => {
  const out = renderList({ others }, { color: false, hyperlinks: false, now: Date.parse('2026-06-25T00:00:00Z'), hideMode: true, labels: ['1', '2'], hiddenFlags: [false, false] });
  const tableLines = strip(out).split('\n').filter((l) => /^[│┌├└]/.test(l));
  const w = displayWidth(tableLines[0]);
  for (const l of tableLines) assert.equal(displayWidth(l), w, `largeur: ${JSON.stringify(l)}`);
  assert.match(strip(out), /\b1\b/);
  assert.match(strip(out), /\b2\b/);
});

test('renderList: vue masquées affiche 🙈 + compteur « N masquées »', () => {
  const data = { others: [...others, { repo: 'o/h', number: 9, url: 'w', title: 'Cachée', triggers: ['review'], author: 'dan', createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, ci: 'pass', state: 'open', approvals: 0 }], hiddenCount: 1 };
  const out = renderList(data, { color: false, hyperlinks: false, now: Date.parse('2026-06-25T00:00:00Z'), showHidden: true, hiddenFlags: [false, false, true] });
  assert.match(strip(out), /🙈/);
  assert.match(strip(out), /2, 1 masquée/); // 2 visibles, 1 masquée
});

test('renderList: sans flags, rendu inchangé (pas de colonne de lettres)', () => {
  const out = strip(renderList({ others }, { color: false, hyperlinks: false, now: 0 }));
  assert.equal(out.includes(' a '), false);
  assert.match(out, /Activité sur les PR des autres \(2\)/);
});
```

- [ ] **Step 2 : lancer → échec**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: FAIL (pas de colonne de lettres, pas de 🙈, pas de compteur masquées).

- [ ] **Step 3 : modifier `render.js`**

Étendre `resolveOpts` pour propager les nouveaux champs :

```js
function resolveOpts(opts) {
  const tty = !!process.stdout.isTTY;
  return {
    color: opts?.color ?? (tty && !process.env.NO_COLOR),
    hyperlinks: opts?.hyperlinks ?? tty,
    now: opts?.now ?? Date.now(),
    hideMode: !!opts?.hideMode,
    showHidden: !!opts?.showHidden,
    labels: opts?.labels ?? [],
    hiddenFlags: opts?.hiddenFlags ?? [],
  };
}
```

Remplacer `othersTable` pour accepter la colonne de marqueur :

```js
function othersTable(rows, opts) {
  const withMarker = opts.hideMode || opts.showHidden;
  const columns = [
    ...(withMarker ? [{ header: '#' }] : []),
    { header: 'Dépôt', max: REPO_MAX },
    { header: 'PR' },
    { header: 'Titre', max: TITLE_MAX },
    { header: 'Auteur' },
    { header: 'Ouverte' },
    { header: 'Diff' },
    { header: 'État' },
    { header: '✅' },
    { header: 'Triggers' },
    { header: 'CI' },
  ];
  const cells = rows.map((r, i) => {
    const diff = diffStat(r.additions, r.deletions);
    const isHid = !!opts.hiddenFlags[i];
    // marqueur : lettre en mode masquage, sinon 🙈 si masquée, sinon vide
    const marker = opts.hideMode ? (opts.labels[i] || '') : (isHid ? '🙈' : '');
    const txt = (color) => (isHid ? C.dim : color); // grisé pour les lignes masquées
    const row = [
      { text: r.repo, color: txt(C.cyan), url: r.url },
      { text: `#${r.number}`, color: txt(C.yellow), url: r.url },
      { text: r.title, color: txt(undefined), url: r.url },
      { text: r.author ? `@${r.author}` : '?', color: txt(C.magenta) },
      { text: relativeDate(r.createdAt, opts.now), color: C.dim },
      { text: diff.text, render: diff.render },
      { text: stateIcon(r.state) },
      { text: r.approvals ? String(r.approvals) : '·', color: txt(C.green) },
      { text: triggersLabel(r.triggers) },
      { text: ciIcon(r.ci) },
    ];
    return withMarker ? [{ text: marker, color: C.dim }, ...row] : row;
  });
  return buildTable(columns, cells, opts);
}
```

Adapter `renderList` pour le compteur « masquées » et passer `o` :

```js
export function renderList(data, opts) {
  const o = resolveOpts(opts);
  const blocks = [];
  if (data.mine && data.mine.length > 0) {
    const heading = `📥 ${paint('Tes PR ouvertes', C.bold, o)} ${paint(`(${data.mine.length})`, C.dim, o)}`;
    blocks.push(`${heading}\n${mineTable(data.mine, o)}`);
  }
  if (data.others && data.others.length > 0) {
    const hiddenInView = o.hiddenFlags.filter(Boolean).length;
    const visible = data.others.length - hiddenInView;
    const hiddenCount = data.hiddenCount ?? hiddenInView;
    const count = hiddenCount > 0
      ? `(${visible}, ${hiddenCount} masquée${hiddenCount > 1 ? 's' : ''})`
      : `(${data.others.length})`;
    const heading = `👥 ${paint('Activité sur les PR des autres', C.bold, o)} ${paint(count, C.dim, o)}`;
    blocks.push(`${heading}\n${othersTable(data.others, o)}`);
  }
  if (blocks.length === 0) return 'Rien à signaler ✨\n';
  return blocks.join('\n\n') + '\n';
}
```

Note alignement : la colonne marqueur a un header vide ; sa largeur naturelle vaut `max(0, …)`
des cellules (🙈 = 2, lettre = 1). `buildTable` calcule déjà la largeur par colonne, donc
l'alignement reste correct. Le test d'alignement le vérifie.

- [ ] **Step 4 : lancer → succès + alignement**

Run: `cd /home/nikophil/works/github.com/nikophil/gh-notif && npm test`
Expected: PASS, y compris le test d'alignement (toutes les lignes du tableau = même `displayWidth`).

- [ ] **Step 5 : commit**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
git add src/render.js test/render.test.js
git commit -m "feat(hidden): colonne de lettres et vue grisée des masquées (render)"
```

---

### Task 4 : entrypoint — clavier, watch, one-shot, `--show-hidden`

**Files:**
- Modify: `gh-notif` (parseArgs, HELP, runList interactif, runWatch interactif, gestion clavier)

**Interfaces:**
- Consumes: `collectPRs(..., { hidden })`, `hiddenPath/loadHidden/saveHidden/toggleHidden/assignLabels/keyOf` de `hidden.js`, `renderList(data, { hideMode, showHidden, labels, hiddenFlags })`.
- Produces: rien (I/O). Non testé unitairement (cf. ARCHITECTURE) → smoke test manuel.

**Conception du clavier (sans dépendance) :**
- `readline.emitKeypressEvents(process.stdin)` + `process.stdin.setRawMode(true)` **uniquement** si `process.stdin.isTTY && process.stdout.isTTY`.
- Un état partagé `hideMode`/`buffer`. Hors `hideMode`, on n'intercepte que `h` (entrer) et `q`/Ctrl-C (quitter). En `hideMode`, les chiffres alimentent `buffer`, `Entrée` valide le toggle, `Backspace` efface, `Esc` sort.
- On **ne met pas** d'alt-screen ; on réutilise le clear existant `\x1b[2J\x1b[3J\x1b[H` au redraw.
- Restauration terminal sur sortie (`setRawMode(false)`), y compris `SIGINT`.

- [ ] **Step 1 : `parseArgs` + `HELP`**

Dans `parseArgs`, ajouter `showHidden: false` au flags initial et :

```js
else if (a === '--show-hidden') flags.showHidden = true;
```

Dans `HELP`, ajouter une ligne :

```
  gh notif --show-hidden     Affiche aussi les PR masquées (grisées, 🙈)
```

Et une ligne dans la section interactive :

```
Touches : h = masquer une PR des autres · (en mode masquage) numéro + Entrée = masquer/restaurer · Esc = sortir.
```

- [ ] **Step 2 : helper de rendu interactif partagé**

Ajouter en haut de `gh-notif` (après imports) un module clavier inline :

```js
import readline from 'node:readline';
import { hiddenPath, loadHidden, saveHidden, toggleHidden, assignLabels, keyOf } from './src/hidden.js';

const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

// Construit les lignes « autres » à afficher (+ flags/labels) selon le mode courant.
function viewModel(data, { hideMode, showHidden }) {
  const rows = showHidden ? [...data.others, ...data.hidden] : data.others;
  const hiddenFlags = showHidden
    ? [...data.others.map(() => false), ...data.hidden.map(() => true)]
    : data.others.map(() => false);
  const labels = hideMode ? assignLabels(rows) : [];
  return { rows, hiddenFlags, labels };
}
```

- [ ] **Step 3 : rendre `runList` interactif (one-shot)**

Remplacer `runList` :

```js
async function runList(gh, { all, scope, showHidden }) {
  const hidden = loadHidden(hiddenPath());
  const fetchData = async () => {
    const stop = startSpinner('Récupération des PRs et notifications…');
    try {
      const me = await gh.getCurrentUser();
      const data = await collectPRs(gh, me, { all, scope, hidden });
      if (data.hiddenChanged) saveHidden(hiddenPath(), hidden);
      return data;
    } finally { stop(); }
  };
  let data = await fetchData();

  if (!interactive()) { process.stdout.write(renderList(data, { showHidden })); return; }

  await runInteractive({
    draw: (hideMode, buffer) => {
      const vm = viewModel(data, { hideMode, showHidden });
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      process.stdout.write(renderList({ mine: data.mine, others: vm.rows, hiddenCount: data.hiddenCount },
        { hideMode, showHidden, labels: vm.labels, hiddenFlags: vm.hiddenFlags }));
      if (hideMode) process.stdout.write(`\n\x1b[2mn° à masquer/restaurer : \x1b[0m${buffer}\x1b[2m_  ·  Entrée valide · Esc sort\x1b[0m\n`);
      else process.stdout.write(`\n\x1b[2mh = masquer · q = quitter\x1b[0m\n`);
    },
    rowsFor: () => viewModel(data, { hideMode: true, showHidden }).rows,
    onToggle: (key) => { toggleHidden(hidden, key, data.notifications); saveHidden(hiddenPath(), hidden); data = recompute(data, hidden); },
  });
}
```

où `recompute` re-filtre `others`/`hidden` depuis les données déjà en mémoire (pas de refetch) :

```js
import { isHidden } from './src/hidden.js';
function recompute(data, hidden) {
  const all = [...data.others, ...data.hidden];
  const others = all.filter((r) => !isHidden(hidden, keyOf(r)));
  const hiddenRows = all.filter((r) => isHidden(hidden, keyOf(r)));
  return { ...data, others, hidden: hiddenRows, hiddenCount: hiddenRows.length };
}
```

- [ ] **Step 4 : boucle clavier générique `runInteractive`**

`draw(hideMode, buffer)` reçoit le buffer de saisie courant pour l'afficher dans le bandeau.

```js
// Boucle clavier partagée (one-shot). Résout quand l'utilisateur quitte (q hors mode masquage).
function runInteractive({ draw, rowsFor, onToggle }) {
  return new Promise((resolve) => {
    let hideMode = false;
    let buffer = ''; // chiffres saisis en mode masquage
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => { try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); process.stdin.removeListener('keypress', onKey); };
    const onKey = (str, key) => {
      if (key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); resolve(); return; }
      if (!hideMode) {
        if (str === 'h') { hideMode = true; buffer = ''; draw(true, buffer); }
        else if (str === 'q') { cleanup(); resolve(); }
        return;
      }
      // mode masquage : buffer de chiffres, Entrée valide, Backspace efface, Esc sort
      if (key.name === 'escape') { hideMode = false; buffer = ''; draw(false, ''); return; }
      if (key.name === 'return' || key.name === 'enter') {
        const rows = rowsFor();
        const idx = assignLabels(rows).indexOf(buffer);
        if (idx >= 0) onToggle(keyOf(rows[idx]));
        buffer = '';
        draw(true, buffer);
        return;
      }
      if (key.name === 'backspace') { buffer = buffer.slice(0, -1); draw(true, buffer); return; }
      if (str && /[0-9]/.test(str)) { buffer += str; draw(true, buffer); return; }
    };
    process.stdin.on('keypress', onKey);
    draw(false, '');
  });
}
```

- [ ] **Step 5 : intégrer le clavier dans `runWatch`**

Dans `runWatch`, ajouter l'état `hideMode` et l'écoute clavier ; pendant `hideMode`, **suspendre** le `countdown`/poll (drapeau `paused`). Modifications ciblées :

```js
async function runWatch(gh, { scope, verbose, showHidden }) {
  const me = await gh.getCurrentUser();
  const path = statePath();
  const hiddenFile = hiddenPath();
  const hidden = loadHidden(hiddenFile);
  let primed = existsSync(path);
  const state = loadState(path);
  const recent = [];
  let data = null;
  let hideMode = false;
  let buffer = '';

  const redraw = () => {
    if (!data) return;
    const vm = viewModel(data, { hideMode, showHidden });
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    process.stdout.write(`\x1b[2m🔄 gh notif --watch · maj ${now()} · toutes les ${POLL_SECONDS}s · Ctrl-C pour arrêter\x1b[0m\n\n`);
    process.stdout.write(renderList({ mine: data.mine, others: vm.rows, hiddenCount: data.hiddenCount },
      { hideMode, showHidden, labels: vm.labels, hiddenFlags: vm.hiddenFlags }));
    if (hideMode) process.stdout.write(`\n\x1b[2mn° à masquer/restaurer : \x1b[0m${buffer}\x1b[2m_  ·  Entrée valide · Esc sort\x1b[0m\n`);
    if (verbose && recent.length > 0) {
      process.stdout.write(`\n\x1b[1m🔔 Évènements détectés (session)\x1b[0m\n`);
      for (const line of recent) process.stdout.write(`${line}\n`);
    }
  };

  if (interactive()) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (str, key) => {
      if (key.ctrl && key.name === 'c') { try { process.stdin.setRawMode(false); } catch {} process.stdout.write('\n'); process.exit(0); }
      if (!hideMode) { if (str === 'h') { hideMode = true; buffer = ''; redraw(); } return; }
      if (key.name === 'escape') { hideMode = false; buffer = ''; redraw(); return; }
      if (key.name === 'return' || key.name === 'enter') {
        const rows = viewModel(data, { hideMode: true, showHidden }).rows;
        const idx = assignLabels(rows).indexOf(buffer);
        if (idx >= 0) { toggleHidden(hidden, keyOf(rows[idx]), data.notifications); saveHidden(hiddenFile, hidden); data = recompute(data, hidden); }
        buffer = ''; redraw(); return;
      }
      if (key.name === 'backspace') { buffer = buffer.slice(0, -1); redraw(); return; }
      if (str && /[0-9]/.test(str)) { buffer += str; redraw(); }
    });
  }

  for (;;) {
    if (!hideMode) {
      try {
        const stop = startSpinner('Mise à jour…');
        try { data = await collectPRs(gh, me, { all: false, scope, hidden }); }
        finally { stop(); }
        if (data.hiddenChanged) saveHidden(hiddenFile, hidden);
        const items = data.notifications ?? [];
        if (!primed) {
          for (const item of items) markSeen(state, item);
          saveState(path, state); primed = true;
        } else {
          const openKeys = new Set([...data.mine, ...data.others, ...data.hidden].map((r) => `${r.repo}#${r.number}`));
          const fresh = items.filter((i) => isNew(state, i));
          for (const item of fresh) {
            markSeen(state, item);
            if (item.category === CATEGORY.REVIEW_REQUEST && !openKeys.has(`${item.repo}#${item.number}`)) continue;
            sendNotification(item);
            recent.unshift(watchEventLine(item, now(), { hyperlinks: process.stdout.isTTY }));
          }
          if (fresh.length > 0) saveState(path, state);
        }
        while (recent.length > RECENT_MAX) recent.pop();
        redraw();
      } catch (err) {
        process.stderr.write(`gh notif --watch: ${err.message}\n`);
      }
    }
    await countdown(POLL_SECONDS); // en hideMode, on saute le poll mais on attend (voir note)
  }
}
```

Note : pendant `hideMode`, on ne refetch pas (le bloc est sauté) ; `countdown` continue de
patienter sans redraw automatique pour ne pas écraser l'écran sous l'utilisateur. `openKeys`
inclut désormais `data.hidden` pour ne pas re-notifier une review sur une PR masquée comme si
elle était fermée.

Brancher les flags dans `main` :

```js
if (flags.watch) await runWatch(gh, { scope, verbose: flags.verbose, showHidden: flags.showHidden });
else await runList(gh, { all: flags.all, scope, showHidden: flags.showHidden });
```

- [ ] **Step 6 : `node --check` + smoke tests manuels**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
for f in gh-notif src/*.js test/*.js; do node --check "$f"; done && echo CHECK-OK
npm test
```

Smoke (manuel, en vrai terminal) :
- `gh notif` → `h` → une lettre masque une PR des autres → `q` quitte ; relancer → la PR reste masquée.
- `gh notif --show-hidden` → la PR masquée apparaît grisée + 🙈 ; `h` + sa lettre → restaurée.
- `gh notif | cat` (non-TTY) → affiche puis rend la main, aucune interaction, aucune colonne de lettres.
- `gh notif --watch` → `h`/lettre masque, l'écran ne refetch pas pendant le mode, `Esc` reprend le poll.

- [ ] **Step 7 : commit**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
git add gh-notif
git commit -m "feat(hidden): interaction clavier (h) en one-shot et watch + --show-hidden"
```

---

### Task 5 : documentation

**Files:**
- Modify: `README.md` (section masquage, `--show-hidden`, touches)
- Modify: `docs/ARCHITECTURE.md` (module `hidden.js`, piège « réapparition au trigger », garde TTY)

- [ ] **Step 1 : README**

Ajouter une sous-section après « Ce qui est volontairement ignoré » :

```markdown
### Masquer une PR des autres

Dans un terminal interactif, appuie sur **`h`** pour entrer en *mode masquage* : un numéro
apparaît devant chaque PR de la table « autres ». Tape le **numéro puis `Entrée`** pour **masquer**
la PR (jamais les tiennes ; `Backspace` corrige). `Esc` sort du mode.

Une PR masquée **réapparaît automatiquement dès qu'un nouveau trigger arrive** (réponse à ton
fil, mention, commentaire). Une review demandée que tu masques reste cachée jusqu'à une vraie
interaction.

`gh notif --show-hidden` réaffiche les PR masquées (grisées, 🙈) ; en mode masquage, leur lettre
les **restaure**. Disponible aussi avec `--watch`. La liste des masquées est persistée dans
`~/.local/state/gh-notif/hidden-v1.json`.

> En pipe/redirection (non-TTY), `gh notif` affiche puis rend la main : aucune interaction.
```

Ajouter dans la liste d'usage :

```bash
gh notif --show-hidden        # affiche aussi les PR masquées (grisées)
```

- [ ] **Step 2 : ARCHITECTURE**

Ajouter une ligne au tableau des modules :

```
| `src/hidden.js` | Masquage des PR des autres : persistance, signatures d'évènements, réconciliation, labels. | oui |
```

Ajouter un piège (§10) :

```markdown
10. **Masquage « jusqu'au prochain trigger » (`hidden.js`).** Seules les PR de `others` sont
    masquables (jamais `mine`). On stocke un instantané des **URLs d'évènements de trigger**
    (`signatureOf`, review_request exclu) au moment du masquage ; `reconcile` dé-masque dès qu'une
    URL nouvelle apparaît et élague les clés absentes des entrées courantes. Conséquence : une
    review demandée (signature vide) reste cachée jusqu'à une vraie interaction. L'interaction est
    **100 % clavier** (`h`, puis numéro + Entrée, `Esc`), sans capture souris ni alt-screen, et **seulement**
    si stdin+stdout sont des TTY — sinon comportement « affiche puis rend la main ».
```

- [ ] **Step 3 : commit**

```bash
cd /home/nikophil/works/github.com/nikophil/gh-notif
git add README.md docs/ARCHITECTURE.md
git commit -m "docs(hidden): README + ARCHITECTURE pour le masquage clavier"
```

---

## Auto-revue du plan

- **Couverture spec** : périmètre (T2 garde `mine`), interaction `h`/lettre/`Esc`/`q` (T4), watch+one-shot (T4), garde TTY (T4), `--show-hidden` + grisé/🙈 + compteur (T3/T4), réapparition au trigger (T1 `reconcile`, T2), persistance (T1), alphabet sans `h`/`q` (T1). ✅
- **Placeholders** : aucun — tout le code est fourni.
- **Cohérence des types** : `collectPRs` renvoie `{ mine, others, hidden, hiddenCount, hiddenChanged, notifications }` (T2) ; `renderList(data, opts)` consomme `data.others/hiddenCount` + `opts.hideMode/showHidden/labels/hiddenFlags` (T3) ; `assignLabels`/`keyOf`/`toggleHidden`/`isHidden` partagés (T1) et réutilisés à l'identique en T4. ✅
