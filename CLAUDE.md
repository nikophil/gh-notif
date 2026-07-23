# CLAUDE.md

## ⚠️ À LIRE EN PREMIER, À CHAQUE FOIS

**Avant toute tâche sur ce dépôt, lis [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** Il décrit
les modules, le flux de données et surtout les **décisions non-évidentes** (pièges qui ont déjà
causé des bugs : `reason` collante, fils de review aplatis, dédup par URL, largeur des emojis,
apostrophes typographiques…). Ne propose ni n'écris de code avant de l'avoir relu.

## Repères rapides

- Extension `gh` CLI, **Node ESM, zéro dépendance npm**. Tout accès GitHub passe par `gh`.
- Tests : `npm test` (runner natif `node:test`). La logique difficile est dans des **fonctions
  pures testées sur fixtures** — ajoute/maintiens les tests, ne casse pas l'isolation (pas de réseau
  en test).
- Avant de conclure une modif : `npm test` vert **et**
  `for f in gh-notif src/*.js test/*.js; do node --check "$f"; done`, plus un smoke test si tu as
  touché l'entrypoint ou le rendu.
- **Tout smoke test de `--serve` DOIT passer `--no-open`** (sinon chaque lancement ouvre un onglet
  dans le navigateur de l'utilisateur).
- L'alignement des tableaux dépend de `render.js#displayWidth` : toute nouvelle icône/emoji doit
  passer le test d'alignement (toutes les lignes d'un tableau ont la même largeur).

## Spec

La spec de design détaillée (historique des décisions produit) :
`docs/superpowers/specs/2026-06-24-gh-notif-design.md`.
