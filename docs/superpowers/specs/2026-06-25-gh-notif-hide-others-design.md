# gh-notif — masquage des PR des autres (clavier)

## Contexte

Dans la table « 👥 Activité sur les PR des autres », des PR restent affichées alors qu'on n'a
plus rien à en faire dans l'immédiat (typiquement de vieilles PR où une review a été demandée il
y a longtemps). On veut pouvoir les **masquer** à la demande, jusqu'à ce qu'il s'y passe quelque
chose de nouveau.

Un premier essai d'interaction **souris** (clic sur une croix) a été abandonné : la capture souris
désactive le scroll natif, les liens cliquables et le curseur main du terminal — compromis
inacceptable. On repart donc sur une interaction **100 % clavier**, sans capture souris ni
alt-screen, de façon à préserver scroll et liens hors interaction.

## Objectif

- Masquer une PR de la table « autres » via une interaction clavier simple.
- Ne **jamais** pouvoir masquer ses propres PR (table « 📥 Tes PR ouvertes » intacte).
- Une PR masquée **réapparaît automatiquement dès qu'un nouveau trigger arrive** (réponse à mon
  fil, mention, commentaire dont l'URL d'évènement n'était pas connue au moment du masquage).
- Pouvoir afficher quand même les PR masquées (pour les revoir / les restaurer).
- Aucune régression hors TTY (pipe/redirection) : comportement « affiche puis rend la main ».

## Interaction

Mode **modal**, déclenché à la demande — pas d'écoute permanente intrusive :

- `h` → entre en **mode masquage**. Une colonne de **numéros** (`1`, `2`, `3`…) apparaît devant
  chaque ligne de la table « autres », l'écran se redessine, un bandeau d'aide s'affiche.
- Tu **tapes le numéro puis `Entrée`** → la PR correspondante est **masquée** (ou **restaurée** si
  elle était affichée en vue « cachées »). L'écran se redessine et **on reste en mode masquage**
  pour en enchaîner plusieurs. `Backspace` corrige la saisie en cours.
- `Esc` → sort du mode masquage (retour à l'affichage normal).

Disponible dans **`gh notif --watch`** et **`gh notif` one-shot** :

- En `--watch`, la boucle redessine déjà l'écran ; on lui ajoute l'écoute clavier. Pendant le mode
  masquage, le **poll est mis en pause** (pas de redraw sous les doigts de l'utilisateur) ; il
  reprend à la sortie du mode.
- En one-shot, après l'affichage le programme **reste vivant** en attente de `h`/`q` (au lieu de
  rendre la main). Masquer ne nécessite **aucun refetch** : on redessine depuis les données déjà
  en mémoire. `q` quitte.

**Garde TTY (obligatoire).** L'interactivité ne s'active que si `process.stdin.isTTY` **et**
`process.stdout.isTTY`. En pipe/redirection (ou `NO_COLOR`), `gh notif` affiche puis rend la main
exactement comme aujourd'hui — les scripts ne changent pas de comportement.

**Pas de capture souris, pas d'alt-screen.** Le terminal reste sur l'écran principal ; on ne met
stdin en *raw mode* que pendant l'écoute des touches. Hors mode masquage, scroll et liens
cliquables fonctionnent normalement.

### Numéros

Les numéros sont attribués dans l'ordre d'affichage de la table « autres » : `1`, `2`, `3`…
Comme un chiffre unique ne couvre que 1–9 et que la table peut être plus longue, la saisie est
**bufferisée** : en mode masquage, les chiffres s'accumulent (affichés dans le bandeau), `Entrée`
valide le numéro saisi (toggle de la PR), `Backspace` efface le dernier chiffre, `Esc` sort. Un
numéro hors plage est ignoré (buffer remis à zéro).

## Affichage des PR masquées

- `gh notif --show-hidden` (compatible `--watch`) : affiche **aussi** les PR masquées, **grisées**
  et préfixées d'un marqueur `🙈`. En mode masquage, leur lettre les **restaure** (toggle).
- Le titre de la table indique le compte masqué quand il y en a :
  `👥 Activité sur les PR des autres (5, 2 masquées)`.
- Sans `--show-hidden`, les PR masquées sont simplement absentes et le compteur principal ne les
  compte pas (mais le « N masquées » reste indiqué pour ne pas masquer silencieusement).

## Sémantique « réapparaît au prochain trigger »

C'est le point subtil. On s'appuie sur les **URL d'évènements** déjà calculées par `collectPRs`
(`notifications` = items classifiés, chacun avec `repo`/`number`/`url`).

- **Signature d'activité** d'une PR = l'ensemble des `url` des items de notification qui la
  concernent et portent un trigger (`mention`/`reply`/`comment` — cf. `TRIGGER_FOR`). Une PR dont
  le seul motif d'apparition est une demande de review (`collectPending`, sans item de
  notification) a une signature **vide**.
- **Masquer** la PR `repo#number` : on stocke `{ at: <ISO>, seen: [<URLs de la signature>] }`.
- **À chaque rendu** (`reconcile`) : pour chaque PR encore masquée, on calcule sa signature
  courante `S`. Si `S` contient **au moins une URL absente de `seen`** → un **nouveau** trigger est
  arrivé → on **dé-masque** (suppression de l'entrée) et la PR réapparaît. Sinon elle reste cachée.
- **Conséquence voulue** : une PR « en review depuis longtemps » (signature vide) reste cachée
  jusqu'à une **vraie interaction** (réponse/mention/commentaire). Une simple re-demande de review
  (qui ne produit pas d'URL d'évènement de notification) ne la fait **pas** réapparaître — conforme
  au « laisse-moi tranquille jusqu'à du neuf ».
- **Élagage** : `reconcile` ne conserve dans la map que les clés correspondant à une PR encore
  présente dans les entrées courantes (évite une croissance illimitée). Masquer ne marque pas la
  notification « lue » côté GitHub : tant qu'elle est non lue, la PR reste dans les entrées et
  donc masquée ; si on la lit sur GitHub, elle disparaît des entrées et son entrée est élaguée.

## Persistance

Nouveau fichier `~/.local/state/gh-notif/hidden-v1.json` (même base que `state.js` :
`XDG_STATE_HOME` ou `~/.local/state`). Forme :

```json
{
  "mapado/ticketing#7004": { "at": "2026-06-25T14:10:00.000Z", "seen": [] },
  "mapado/oauth-srv#388":  { "at": "2026-06-25T14:12:00.000Z", "seen": ["https://api.github.com/.../comments/123"] }
}
```

## Découpage technique

| Fichier | Changement | Testable |
|---------|------------|----------|
| `src/hidden.js` (nouveau) | `hiddenPath()`, `loadHidden`/`saveHidden`, `keyOf(row)`, `signatureOf(key, items)`, `toggleHidden(map, key, items)`, `reconcile(map, entries, items)` (dé-masque + élague), `isHidden(map, key)`. Fonctions pures (sauf load/save). | oui |
| `src/collect.js` | `collectPRs` : applique `reconcile` puis sépare `others` en visibles / masquées ; renvoie `{ mine, others, hidden, hiddenCount, notifications }`. Le calcul des signatures réutilise `notifications` + `TRIGGER_FOR`. | oui (gh stub) |
| `src/render.js` | `renderList(data, { hideMode, showHidden, labels })` : colonne de lettres optionnelle sur la table « autres » (mode masquage), rendu grisé + `🙈` des masquées (showHidden), compteur « N masquées » dans le titre. Largeur d'affichage validée par le test d'alignement. | oui |
| `gh-notif` | Gestion clavier (`readline` keypress, raw mode borné, garde TTY), boucle interactive one-shot, pause du poll en watch pendant le mode masquage, flag `--show-hidden`, aide. | non (I/O) → smoke test |

### Interfaces clés

```js
// src/hidden.js
export function hiddenPath()                      // chemin du fichier d'état
export function loadHidden(path)                  // map ou {}
export function saveHidden(path, map)
export function keyOf(row)                         // `${row.repo}#${row.number}`
export function signatureOf(key, items)            // string[] d'URLs d'évènements (triggers)
export function isHidden(map, key)                 // bool
export function toggleHidden(map, key, items)      // mute: masque (snapshot signature) ou restaure
export function reconcile(map, entries, items)     // mute: dé-masque sur nouveau trigger + élague ; renvoie la map
```

`entries` = la liste des PR « autres » avant filtrage (objets `{ repo, number, ... }`), `items` =
`notifications`.

### Flux `collectPRs` (mis à jour)

```
… (inchangé jusqu'au split mine/others) …
reconcile(hiddenMap, othersEntries, notifications)   // dé-masque + élague, persiste si modifié
others       = othersEntries non masquées
hidden       = othersEntries masquées (pour --show-hidden)
hiddenCount  = hidden.length
return { mine, others, hidden, hiddenCount, notifications }
```

`reconcile` est appelé dans `collectPRs` ; la persistance (`saveHidden`) du dé-masquage/élagage se
fait là si la map a changé. Le **toggle** interactif (masquer/restaurer à la main) est piloté par
l'entrypoint qui appelle `toggleHidden` + `saveHidden` puis redessine.

## Cas limites / erreurs

- **Non-TTY** : pas d'interaction, pas de raw mode, sortie déterministe (tests `{color:false}`).
- **Plus de ~48 PR « autres »** : lignes excédentaires sans lettre (non masquables clavier).
- **PR masquée qui disparaît des entrées** (lue sur GitHub, mergée hors review-requested) : élaguée
  par `reconcile`.
- **`Ctrl-C`** en mode interactif : restaure le terminal (raw mode off) puis quitte proprement.
- **Fichier d'état corrompu** : `loadHidden` renvoie `{}` (comme `loadState`).

## Tests

- `test/hidden.test.js` : `signatureOf`, `toggleHidden` (masque/restaure + snapshot), `reconcile`
  (dé-masque sur nouvelle URL, garde si signature inchangée, signature vide reste masquée, élagage
  des clés absentes), `keyOf`.
- `test/collect.test.js` : `collectPRs` filtre les masquées hors `others`, expose `hidden`/
  `hiddenCount`, et **ne masque jamais une PR à moi** ; dé-masquage au nouveau trigger.
- `test/render.test.js` : colonne de lettres alignée en mode masquage ; rendu grisé + 🙈 +
  compteur « N masquées » en `--show-hidden` ; alignement (toutes les lignes même `displayWidth`).
- Entrypoint : smoke test manuel (raw mode, `h`/lettre/`q`, watch + one-shot, pipe).

## Hors périmètre

- Le polling configurable / l'atténuation du rate-limit (commit séparé, à brainstormer ensuite).
- Toute interaction souris (abandonnée).
- Masquer des PR à moi.
