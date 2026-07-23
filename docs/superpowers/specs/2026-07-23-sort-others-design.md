# Tri du tableau « PR des autres » (--serve) — design

Date : 2026-07-23
Statut : validé

## Besoin

Pouvoir trier les PR à review (tableau « Activité sur les PR des autres ») dans le mode
`--serve`, sur trois champs : **date de création**, **nombre d'approbations** (colonne ✅),
**auteur**.

## Décisions produit

- **Web (`--serve`) uniquement.** Terminal (`gh notif`, `--watch`) inchangé.
- **Tableau « others » seulement.** « Tes PR » garde son ordre actuel. Les lignes masquées
  affichées via `?hidden=1` suivent le même tri (cohérence visuelle).
- **Champ « reviews » = approbations** : le champ `approvals` déjà calculé (users distincts
  dont la dernière review est APPROVED). Aucun nouveau champ à collecter.
- **UI : en-têtes de colonne cliquables** (Date / ✅ / Auteur). La colonne active porte un
  indicateur `▴`/`▾` ; re-clic sur la même colonne inverse le sens.
- **Un seul critère actif à la fois** : cliquer sur une autre colonne REMPLACE le tri,
  jamais de tri cumulé multi-colonnes.
- **Défaut : `{ key: 'date', dir: 'desc' }`** (plus récente d'abord), appliqué dès le
  premier affichage.
- **Sens par défaut au premier clic sur une colonne** : date → `desc` (récent d'abord),
  ✅ → `asc` (les moins approuvées d'abord : celles qui ont le plus besoin d'une review),
  auteur → `asc` (alphabétique).
- **Persisté dans `prefs-v1.json`** (clé `sort`), même mécanique que `theme`/`notify`/
  `favorites` : survit au redémarrage du serveur.

## Architecture

Le tri est un **état d'affichage**, comme le favori actif (§14 d'ARCHITECTURE.md) :
`data` reste **brut** en mémoire, le tri s'applique en aval, juste avant le rendu.

```
collectPRs (brut) → reconcile → notifyNew → filterDataByScope → sortRows(others) → renderFragment
```

Le tri ne touche ni la collecte, ni le masquage, ni les notifs. Coût : **0 requête GitHub**.

### Modèle

État : `{ key: 'date'|'approvals'|'author', dir: 'asc'|'desc' }`.

- Comparaison : `date` sur `createdAt` (ISO, comparaison lexicale), `approvals` numérique,
  `author` lexicale insensible à la casse.
- **Valeurs manquantes** (`createdAt`/`author` nuls) → toujours en **fin de liste**, quel
  que soit le sens.
- **Égalité → ordre d'arrivée conservé** (le sort natif est stable).

### Composants

| Fichier | Changement |
|---------|-----------|
| `src/sort.js` (nouveau, pur) | `SORT_KEYS`, `DEFAULT_SORT`, `normalizeSort(raw)` (validation + défauts, calqué sur `themeOf`), `toggleSort(current, key)` (autre colonne → sens par défaut de la colonne ; même colonne → inverse), `sortRows(rows, sort)` (renvoie une copie triée, ne mute pas). |
| `src/prefs.js` | Clé `sort` dans les défauts. ⚠️ Piège habituel : muter l'objet `prefs` entier puis `savePrefs(prefs)` — jamais `savePrefs({ sort })`. |
| `src/html.js` | `renderFragment` reçoit une option `sort` ; les `<th>` Date / ✅ / Auteur du tableau « others » deviennent cliquables (`data-sort-key="date|approvals|author"`), la colonne active porte `▴`/`▾`. Le JS du shell délègue le clic → `POST /sort?key=…` → `inject()`. Échappement `escapeHtml` inchangé partout. |
| `src/serve.js` | Route `POST /sort?key=…` : `toggleSort` → mute `prefs.sort` + `savePrefs` → recompute **local** du fragment (aucun refetch, comme `/hide`) → JSON `{chips, fragment, updatedAt}`. Clé invalide → 400. |

## Hors périmètre

- Tri en terminal (`gh notif`, `--watch`).
- Tri de « Tes PR ».
- Tri multi-critères.
- Nombre total de reviews (commentaires/changes requested) — seul `approvals` est utilisé.

## Tests

- `test/sort.test.js` : chaque clé, chaque sens, nulls en fin (deux sens), stabilité sur
  égalité, `toggleSort` (bascule + sens par défaut par colonne), `normalizeSort`
  (valeurs invalides/partielles → défaut).
- `test/prefs.test.js` : défaut `sort` appliqué à la lecture d'un fichier ancien/partiel ;
  sauvegarde sans écraser `theme`/`notify`/`favorites`.
- `test/serve.test.js` : `POST /sort` change l'ordre du fragment et persiste ; clé
  invalide → 400 ; aucun refetch déclenché.
- `test/html.test.js` : indicateur ▴/▾ sur la bonne colonne, `data-sort-key` présents,
  données GitHub toujours échappées.
