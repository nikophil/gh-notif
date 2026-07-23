# Lien « PR fermées » contextualisé (mode --serve)

**Date** : 2026-07-23
**Statut** : validé

## Problème

« Tes PR » est alimenté par `search author:@me is:open` (ARCHITECTURE §7) : dès qu'une PR est
mergée ou fermée, elle disparaît de la vue. Aucun moyen de retrouver son historique depuis
gh-notif.

## Décision

**Aucune collecte, aucune pagination côté gh-notif.** Un simple lien externe vers la recherche
GitHub :

```
https://github.com/pulls?q=is:pr+author:@me+is:closed+<scope…>
```

GitHub gère l'affichage et la pagination. Périmètre : **mode `--serve` (web) uniquement** —
pas de version terminal ni `--watch`.

`is:closed` couvre mergées **et** fermées sans merge (choix validé : un seul lien, GitHub
permet d'affiner ensuite).

## Contextualisation du lien

Le lien reflète exactement ce que la vue affiche, en réutilisant la logique de scope
existante :

| État de la vue | Qualifier ajouté |
|---|---|
| Scope ad-hoc (champ filtré à la main) | `org:x` ou `repo:o/n` de ce scope |
| Favori actif | le qualifier de ce favori |
| « ⭐ tous » avec des favoris | l'union des favoris (GitHub OR-ise les qualifiers répétés, cf. ARCHITECTURE §14 — réutilise `scopesQualifier`) |
| Aucun favori, aucun scope | aucun qualifier (tout GitHub) |

## Implémentation

- **`src/favorites.js`** : helper **pur** `closedPRsUrl(scopes)` (à côté de
  `scopesQualifier`), renvoie l'URL encodée. `scopes` : `null`, un scope, ou un tableau
  (mêmes formes que le reste du code).
- **`src/serve.js`** : calcule l'URL aux deux points qui construisent déjà le fragment
  (`buildView` / `handleRequest`, où `scope`/`activeFav`/`favorites` sont déjà disponibles)
  et la passe à `renderFragment` via `opts`.
- **`src/html.js`** : dans le `<h2>📥 Tes PR ouvertes (N)</h2>`, un petit lien discret à
  droite du titre (`fermées ↗`), `target="_blank"`, URL passée par `escapeHtml`. Style
  léger : taille réduite, couleur `--muted`.

## Cas limite (validé)

Si `mine` est vide, la section « Tes PR » n'était pas rendue → le lien disparaîtrait. On
rend désormais le titre de section avec le lien même quand `mine` est vide (avec `(0)` et
sans tableau), pour garder l'accès à l'historique. Ceci ne s'applique que si une URL est
fournie (compat : sans `opts`, comportement inchangé).

## Tests

- `test/favorites.test.js` : `closedPRsUrl` sur les 4 cas de scope (org, repo, union,
  `null`) + encodage de l'URL.
- `test/html.test.js` : présence du lien dans le fragment, échappement, absence du lien si
  pas d'URL fournie (compat), section « Tes PR (0) » rendue quand `mine` vide et URL
  fournie.

## Hors périmètre

- Pagination/affichage des PR fermées dans gh-notif lui-même.
- Version terminal ou `--watch`.
- Lien distinct mergées vs fermées.
