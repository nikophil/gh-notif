# Design — Jobs de CI ignorés (blocklist par repo)

> Statut : validé en brainstorming, prêt pour plan d'implémentation.
> Voir aussi `docs/ARCHITECTURE.md` (§8 coût/CI, §12 debug, §14 prefs & compat).

## Problème

La colonne CI du dashboard vient d'un **seul état agrégé** GitHub
(`statusCheckRollup.state`, `github.js` → `ciFromState`). Ce rollup passe à `FAILURE`
dès qu'**un seul** check échoue. Or certains repos ont des jobs volontairement
peu importants : sur `mapado/ticketing`, *Check Pull Requests label for merge block*
est un workflow-rappel pour lancer les migrations à la main ; le vrai job qui compte
est `continuous-integration/jenkins/branch`. Résultat : une PR affiche ❌ alors que
le job important est vert — le signal utile est noyé.

## Objectif

Permettre de déclarer, **par repo**, une liste de jobs à **ignorer** (blocklist).
Le verdict CI affiché est alors **recalculé** à partir des seuls jobs restants :
le job important vert ⇒ ✅, même si un job ignoré est rouge. Le job ignoré devient
invisible dans la colonne CI.

## Décisions (issues du brainstorming)

1. **Modèle = blocklist** (on liste ce qu'on ignore), pas allowlist.
2. **Portée = par repo** (`owner/name`), pas globale ni par org.
3. **Affichage = jobs importants seuls** : l'icône CI recalcule le verdict sans les
   jobs ignorés (pas de marqueur/tooltip pour signaler qu'un job ignoré a échoué —
   il disparaît purement et simplement du calcul).
4. **Config = édition manuelle** de `prefs-v1.json` (aucune UI interactive à coder).
5. **Découverte des noms** = via la **vue debug existante** (§12), enrichie.
6. **Compat forte** : sans blocklist pour un repo, comportement **byte-identique** à
   aujourd'hui (on garde `ciFromState`). Le recalcul ne s'active **que** par repo configuré.
7. **La liste des checks d'une PR est portée par la row** (à côté de
   `additions`/`deletions`), pas dans une structure debug séparée.

## Architecture

### 1. `github.js` — récupérer les checks individuels

`PR_FRAGMENT` ajoute les `contexts` du rollup **dans la même requête GraphQL** (aucune
requête réseau supplémentaire, cf. §8) :

```graphql
commits(last: 1) { nodes { commit { statusCheckRollup {
  state
  contexts(first: 100) { nodes {
    __typename
    ... on CheckRun      { name    conclusion status }
    ... on StatusContext { context state }
  } }
} } } }
```

Deux types de nœuds coexistent :

- **`CheckRun`** (GitHub Actions, ex. *Check Pull Requests label for merge block*) :
  nom dans `name`, résultat dans `conclusion` (avec `status` pour l'en-cours).
- **`StatusContext`** (statuts commit classiques, ex. Jenkins
  `continuous-integration/jenkins/branch`) : nom dans `context`, résultat dans `state`.

`normalizePull` produit un tableau normalisé **`checks: [{ name, state }]`** où
`state ∈ {'pass','fail','pending'}`. Mapping :

- **CheckRun** : `conclusion` `SUCCESS`/`NEUTRAL`/`SKIPPED` → `pass` (non-bloquant,
  comme le rollup GitHub) ; `FAILURE`/`ERROR`/`TIMED_OUT`/`CANCELLED`/`ACTION_REQUIRED`/
  `STARTUP_FAILURE` → `fail` ; `conclusion` nul (donc en cours, `status`
  `QUEUED`/`IN_PROGRESS`/`PENDING`/`WAITING`/`REQUESTED`) → `pending`.
- **StatusContext** : `state` `SUCCESS` → `pass` ; `FAILURE`/`ERROR` → `fail` ;
  `PENDING`/`EXPECTED` → `pending`.

On **conserve** `statusCheckRollupState` (utilisé pour le fallback compat).

### 2. `collect.js` — recalcul pur du verdict

Nouvelle fonction pure `ciFromChecks(checks, ignored)` à côté de `ciFromState` :

- retire de `checks` ceux dont le `name` est dans `ignored` (matching **exact, trimmé**,
  sensible à la casse — le nom est copié tel quel depuis la vue debug) ;
- agrège les restants : un `fail` domine → `'fail'` ; sinon un `pending` → `'pending'` ;
  sinon (au moins un check) → `'pass'` ; sinon (liste vide) → `'none'`.

Dans `collectPRs(gh, me, { …, ignoredChecks = {} })`, le `ci` de chaque row :

```js
const ignoredForRepo = ignoredChecksFor(ignoredChecks, e.repo); // [] par défaut
ci: ignoredForRepo.length
  ? ciFromChecks(d?.checks, ignoredForRepo)
  : ciFromState(d?.statusCheckRollupState),
```

**Compat** : sans entrée pour le repo, on garde exactement `ciFromState` — donc byte-identique
pour qui n'a rien configuré (même esprit que §14, « strictement inchangé pour qui n'a aucun favori »).

Chaque row porte aussi **`checks`** (le tableau normalisé, donnée déjà fetchée → coût nul),
consommé par la vue debug. Le rendu des tableaux (`render.js`/`html.js`) ignore ce champ.

### 3. `prefs.js` — clé `ignoredChecks`

Nouvelle clé dans `prefs-v1.json`, défaut `{}` :

```json
"ignoredChecks": {
  "mapado/ticketing": ["Check Pull Requests label for merge block"]
}
```

- `loadPrefs` applique le défaut `{}` et **recopie** l'objet (comme `favorites`, pour ne
  pas partager la référence entre appels), tolère la clé absente ou malformée (→ `{}`).
- Accesseurs purs : `ignoredChecksOf(prefs)` → la map ; `ignoredChecksFor(prefs, repo)` →
  le tableau de noms pour ce repo (`[]` si absent).
- **Pas de bump de version de fichier** : les défauts à la lecture rendent tout fichier
  antérieur valide.

⚠️ Édition **manuelle** uniquement. Piège à documenter : si un `--serve` tourne, il a un
objet `prefs` mutable en mémoire réécrit **en entier** à chaque POST (§14) → une édition
manuelle du fichier serait écrasée. Éditer application arrêtée, puis relancer.

### 4. Câblage — `gh-notif`, `serve.js`

L'entrypoint (`runList`/`runWatch`) et `serve` chargent déjà `prefs`. Ils lisent
`ignoredChecksOf(prefs)` et le passent en option `ignoredChecks` à `collectPRs`.
Aucun autre chemin ne change.

### 5. Vue debug (§12) — « Checks par PR »

`renderDebug` (web) / `renderDebugText` (terminal) gagnent une section listant, par PR
(depuis `data.mine` + `data.others`), les checks : nom + état, les **ignorés barrés/grisés**,
et le **verdict recalculé** de la PR. C'est la source pour copier le nom exact d'un job à
ajouter à la blocklist, et pour vérifier que la config prend effet.

- Coût nul (donnée déjà fetchée), **always-on** en `--serve` via `/debug` comme le reste (§12).
- Noms de checks **échappés** (`escapeHtml`) côté web (anti-injection, §12/§13).
- Les noms de jobs CI ne sont pas des données privées (pas de corps de commentaire).

## Formes de données (mise à jour)

- **Row** gagne `checks: [{ name, state }]` (`state ∈ {pass,fail,pending}`) — normalisé
  dans `github.js`, ré-agrégé en `ci` par `collectPRs`.
- **prefs** gagne `ignoredChecks: { "owner/name": [nom, …] }`, défaut `{}`.

## Tests (fixtures, pas de réseau)

- `ciFromChecks` (pur) : un `fail` domine ; le seul `fail` ignoré → `pass` ; tout ignoré → `none` ;
  liste vide → `none` ; pending sans fail → `pending`.
- `normalizePull` (via runner stub) : payload mixant `CheckRun` et `StatusContext` →
  `checks` normalisé correct (nom + état pour chaque type, mapping `skipped`/`neutral`/`cancelled`).
- `ignoredChecksFor` / `ignoredChecksOf` : défaut `{}`, clé absente → `[]`, fichier malformé toléré.
- `collectPRs` avec `ignoredChecks` : une PR dont le seul check en échec est ignoré → `ci: 'pass'` ;
  sans entrée pour le repo → identique à `ciFromState` (compat).
- Rendu debug : la section « Checks par PR » liste les noms, marque les ignorés, montre le verdict.
- **Alignement** : aucune nouvelle icône de tableau introduite → test d'alignement inchangé.

## Fichiers touchés

- `src/github.js` — `PR_FRAGMENT` + `normalizePull` (`checks`).
- `src/collect.js` — `ciFromChecks`, option `ignoredChecks` dans `collectPRs`, `checks` sur la row.
- `src/prefs.js` — clé `ignoredChecks` + accesseurs.
- `src/html.js` / `src/render.js` — section debug « Checks par PR ».
- `gh-notif` / `src/serve.js` — chargement prefs → option `ignoredChecks`.
- `docs/ARCHITECTURE.md` — forme Row (`checks`), clé prefs, nouveau piège (compat + édition manuelle).
- Tests correspondants.

## Hors périmètre (YAGNI)

- Pas d'allowlist, pas de portée org, pas de globale.
- Pas d'UI interactive (terminal ou web) pour gérer la blocklist.
- Pas de marqueur/tooltip signalant qu'un job ignoré a échoué (il disparaît du calcul).
- Pas de glob/pattern sur les noms (match exact) — à reconsidérer seulement si besoin réel.
