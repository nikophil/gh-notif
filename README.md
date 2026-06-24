# gh-notif

Extension [`gh`](https://cli.github.com/) qui te donne des notifications GitHub **filtrées finement**
et un affichage en tableaux, là où l'inbox GitHub native est trop bruyante.

```
📥 Tes PR ouvertes (6)
┌──────────────────┬───────┬──────────────────────────────┬──────┬─────┬──────────┬────┐
│ Dépôt            │ PR    │ Titre                        │ État │ Rev │ Triggers │ CI │
├──────────────────┼───────┼──────────────────────────────┼──────┼─────┼──────────┼────┤
│ mapado/ticketing │ #7020 │ [WaitingList] Export waiting…│ 🟢   │ 3   │ 💬       │ ✅ │
│ mapado/ticketing │ #7045 │ [CI] fix block-labeled-prs   │ 📝   │ ·   │          │ 🟡 │
└──────────────────┴───────┴──────────────────────────────┴──────┴─────┴──────────┴────┘

👥 Activité sur les PR des autres (34)
┌──────────────────┬──────┬───────────────┬─────────┬───────────┬──────────┬──────┬─────┬──────────┬────┐
│ Dépôt            │ PR   │ Titre         │ Auteur  │ Ouverte   │ Diff     │ État │ Rev │ Triggers │ CI │
├──────────────────┼──────┼───────────────┼─────────┼───────────┼──────────┼──────┼─────┼──────────┼────┤
│ mapado/oauth-srv │ #388 │ feat: add api…│ @lnahiro│ il y a 2h │ +451 −10 │ 🟢   │ 4   │ 🔍       │ ✅ │
└──────────────────┴──────┴───────────────┴─────────┴───────────┴──────────┴──────┴─────┴──────────┴────┘
```

## Ce que ça fait

`gh notif` affiche **deux tableaux** :

- **📥 Tes PR ouvertes** — toutes tes PR ouvertes (un dashboard), avec leur état, le nombre de
  reviews reçues, l'état CI et les triggers d'activité éventuels.
- **👥 Activité sur les PR des autres** — les PR des autres qui te concernent (reviews demandées,
  mentions, réponses à tes fils), avec auteur, date d'ouverture, taille du diff, état, nombre de
  reviews, CI.

Colonnes communes : **État** (📝 draft · 🟢 ouverte · 🟣 mergée · 🔴 fermée) et **Rev** (nombre de
reviews reçues, `·` si aucune).

Le **dépôt / la PR / le titre sont cliquables** (liens de terminal OSC 8) et mènent directement à
la bonne cible.

### Ce qui déclenche une ligne (les « triggers »)

| Icône | Trigger | Quand |
|-------|---------|-------|
| 🔍 | review | on t'a demandé une review (ou elle est encore en attente) |
| 💬 | mention | on t'a `@`-mentionné |
| ↩️ | réponse | quelqu'un a répondu dans un fil de review où tu as participé |
| 🗨 | commentaire | quelqu'un a commenté **ta** PR |

Dans les tableaux, seul l'emoji est affiché (pour gagner de la place) ; cette légende en donne le
sens. Une même PR peut cumuler plusieurs triggers.

### Ce qui est volontairement **ignoré**

- les mises à jour de PR : push, nouveau commit, état de la CI, merge/close, label/assignee ;
- l'activité de tiers sur une PR où tu es **simple reviewer** (sauf si on répond à ton fil ou qu'on
  te mentionne) ;
- tout ce qui n'est pas une Pull Request (issues, releases, discussions).

## `--watch`

`gh notif --watch` affiche **les mêmes deux tableaux que `gh notif`**, mais **rafraîchis
automatiquement** (~60 s, avec un compte à rebours), et **pousse en plus une notification desktop**
(`notify-send`) pour chaque nouvel évènement. Les évènements détectés pendant la session sont aussi
journalisés sous les tableaux :

```
🔄 gh notif --watch · maj 14:36:50 · toutes les 60s · Ctrl-C pour arrêter

📥 Tes PR ouvertes (5)
┌────…
👥 Activité sur les PR des autres (18)
┌────…

🔔 Évènements détectés (session)
🔔 14:36:50  @lnahiro t'a répondu  ·  mapado/ticketing #7020 [WaitingList] Export…
⏳ prochain check dans 42s…
```

Au tout premier lancement, le backlog existant est marqué « vu » **sans alerter** : les tableaux
s'affichent, mais tu n'es notifié (desktop) que des évènements survenant **après** le démarrage.

## Prérequis

- [`gh`](https://cli.github.com/) authentifié (`gh auth login`)
- Node ≥ 18
- `notify-send` (paquet `libnotify-bin`) pour les notifications desktop (optionnel : sans lui,
  `--watch` logge quand même dans le terminal)

## Installation

```bash
gh extension install .
# ou depuis le dépôt distant :
# gh extension install nikophil/gh-notif
```

## Usage

```bash
gh notif                      # deux tableaux : tes PR / les PR des autres
gh notif --all                # inclut les notifications déjà lues
gh notif --watch              # surveille et pousse des notifs desktop (~60s)
gh notif --org mapado         # limite à une organisation
gh notif --repo mapado/web    # limite à un dépôt
gh notif --repo               # limite au dépôt courant (gh repo view)
```

`--org` et `--repo` sont mutuellement exclusifs et fonctionnent aussi avec `--watch`.

> 💡 Couleurs et liens cliquables s'activent en terminal interactif. En pipe/redirection (ou avec
> `NO_COLOR`), la sortie est en texte simple et déterministe.

## Développement

Zéro dépendance npm, ESM, tests via le runner natif de Node :

```bash
npm test          # node --test
```

L'architecture est décrite dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
