# gh-notif

Extension [`gh`](https://cli.github.com/) qui te donne des notifications GitHub **filtrées finement**
et un affichage en tableaux, là où l'inbox GitHub native est trop bruyante.

```
📥 Tes PR ouvertes (6)
┌──────────────────┬───────┬──────────────────────────────┬──────┬────┬──────────┬────┐
│ Dépôt            │ PR    │ Titre                        │ État │ ✅ │ Triggers │ CI │
├──────────────────┼───────┼──────────────────────────────┼──────┼────┼──────────┼────┤
│ mapado/ticketing │ #7020 │ [WaitingList] Export waiting…│ 🟢   │ 2  │ 💬       │ ✅ │
│ mapado/ticketing │ #7045 │ [CI] fix block-labeled-prs   │ 📝   │ ·  │          │ 🟡 │
└──────────────────┴───────┴──────────────────────────────┴──────┴────┴──────────┴────┘

👥 Activité sur les PR des autres (34)
┌──────────────────┬──────┬───────────────┬─────────┬───────────┬──────────┬──────┬────┬──────────┬────┐
│ Dépôt            │ PR   │ Titre         │ Auteur  │ Ouverte   │ Diff     │ État │ ✅ │ Triggers │ CI │
├──────────────────┼──────┼───────────────┼─────────┼───────────┼──────────┼──────┼────┼──────────┼────┤
│ mapado/oauth-srv │ #388 │ feat: add api…│ @lnahiro│ il y a 2h │ +451 −10 │ 🟢   │ 1  │ 🔍       │ ✅ │
└──────────────────┴──────┴───────────────┴─────────┴───────────┴──────────┴──────┴────┴──────────┴────┘
```

## Ce que ça fait

`gh notif` affiche **deux tableaux** :

- **📥 Tes PR ouvertes** — toutes tes PR ouvertes (un dashboard), avec leur état, le nombre de
  reviews reçues, l'état CI et les triggers d'activité éventuels.
- **👥 Activité sur les PR des autres** — les PR des autres qui te concernent (reviews demandées,
  mentions, réponses à tes fils), avec auteur, date d'ouverture, taille du diff, état, nombre de
  reviews, CI.

Colonnes communes : **État** (📝 draft · 🟢 ouverte · 🟣 mergée · 🔴 fermée) et **✅** (nombre
d'**approbations** — utilisateurs distincts dont la dernière review approuve, `·` si aucune).

Sur **tes** PR ouvertes, dès **2 approbations** la colonne ✅ affiche **`2 🎉`** : la PR est
**prête à merger**. En `--watch` / `--serve`, chaque nouvelle approbation pousse aussi une
**notification desktop** (`@bob a approuvé ta PR`, suffixée de `🎉 prête à merger` au-delà de 2).

Le **dépôt / la PR / le titre sont cliquables** (liens de terminal OSC 8) et mènent directement à
la bonne cible.

### Ce qui déclenche une ligne (les « triggers »)

| Icône | Trigger | Quand |
|-------|---------|-------|
| 🔍 | review | on t'a demandé une review (ou elle est encore en attente) |
| 💬 | mention | on t'a `@`-mentionné |
| ↩️ | réponse | quelqu'un a répondu dans un fil de review où tu as participé |
| 🗨️ | commentaire | quelqu'un a commenté **ta** PR |

Dans les tableaux, seul l'emoji est affiché (pour gagner de la place) ; cette légende en donne le
sens. Une même PR peut cumuler plusieurs triggers.

### Ce qui est volontairement **ignoré**

- les mises à jour de PR : push, nouveau commit, état de la CI, merge/close, label/assignee ;
- l'activité de tiers sur une PR où tu es **simple reviewer** (sauf si on répond à ton fil ou qu'on
  te mentionne) ;
- les **PR en draft des autres** (tes propres drafts restent affichés dans « Tes PR ouvertes ») ;
- tout ce qui n'est pas une Pull Request (issues, releases, discussions).

### Masquer une PR des autres

Un rappel s'affiche sous les tableaux : **`↳ appuie sur h pour masquer une PR des autres`**.
Appuie sur **`h`**, puis tape le **numéro de la PR** (celui de la colonne « PR », ex. `6861`) et
**`Entrée`** : la PR est masquée et le mode masquage se **referme aussitôt** (`Backspace` corrige,
`Esc` annule). On ne masque jamais tes propres PR. `q` quitte `gh notif`.

Une PR masquée **réapparaît automatiquement dès qu'un nouveau trigger arrive** (réponse à ton fil,
mention, commentaire). Une review demandée que tu masques reste cachée jusqu'à une vraie
interaction.

`gh notif --show-hidden` réaffiche les PR masquées (grisées, 🙈) ; en mode masquage, retaper leur
numéro les **restaure**. Disponible aussi avec `--watch` (où, avec `-v`, masquer/restaurer ajoute
une ligne au journal). La liste des masquées est persistée dans
`~/.local/state/gh-notif/hidden-v1.json`.

> En pipe/redirection (non-TTY), `gh notif` affiche puis rend la main : aucune interaction.

## `--watch`

`gh notif --watch` affiche **les mêmes deux tableaux que `gh notif`**, mais **rafraîchis
automatiquement** (~60 s, avec un compte à rebours), et **pousse en plus une notification desktop**
(`notify-send` sous Linux, `osascript` sous macOS) pour chaque nouvel évènement.

Avec **`-v`** (`--verbose`), les évènements détectés pendant la session sont aussi journalisés sous
les tableaux (le compte à rebours et le spinner restent dans tous les cas) :

```
🔄 gh notif --watch · maj 14:36:50 · toutes les 60s · Ctrl-C pour arrêter

📥 Tes PR ouvertes (5)
┌────…
👥 Activité sur les PR des autres (18)
┌────…

🔔 Évènements détectés (session)        ← uniquement avec -v
🔔 14:36:50  @lnahiro t'a répondu  ·  mapado/ticketing #7020 [WaitingList] Export…
⏳ prochain check dans 42s…
```

Au tout premier lancement, le backlog existant est marqué « vu » **sans alerter** : les tableaux
s'affichent, mais tu n'es notifié (desktop) que des évènements survenant **après** le démarrage.

### Coût des requêtes (boucles longues)

`--watch` et `--serve` tournent longtemps : pour ménager le **rate-limit** GitHub, un poll ne
ré-inspecte que les fils de notification **qui ont changé** depuis le dernier (un cache par thread) ;
les autres coûtent **0 requête**. Un poll « calme » se réduit donc à quelques requêtes (liste des
notifications + recherches + un batch GraphQL) au lieu de plusieurs dizaines. Si GitHub renvoie
malgré tout un rate-limit (403/429), le prochain poll **recule automatiquement** (backoff, jusqu'à
10 min) et une bannière l'indique. `--interval N` règle la cadence (plancher **60 s**).

## `--serve` (page web)

`gh notif --serve` lance un petit **serveur HTTP local** et ouvre une **page web** présentant les
**mêmes deux tableaux que `gh notif`**, qui se **rafraîchit toute seule** (sans recharger la page) :

```bash
gh notif --serve              # http://localhost:7777, ouvre le navigateur
gh notif --serve --port 8080  # sur un autre port
gh notif --serve --org mapado # restreint le scope (comme les autres modes)
```

Le navigateur s'ouvre automatiquement sur l'URL. Une **unique boucle de poll côté serveur**
(~60 s) interroge GitHub et alimente la page ; plusieurs onglets ouverts ne multiplient donc pas
les appels. La page se rafraîchit toute seule (~10 s) avec un **compte à rebours** ; les liens
s'ouvrent dans un **nouvel onglet**. Comme `--watch`, chaque nouvel évènement pousse une
**notification desktop** (`notify-send` sous Linux, `osascript` sous macOS).

Depuis la page, tu peux :

- **🔄 rafraîchir** immédiatement (sans attendre le prochain poll) ;
- **masquer / restaurer** une PR des autres via le bouton **✕** sur sa ligne (persisté, même liste
  que la touche `h` du terminal ; réapparaît sur nouveau trigger), et **🙈 masquées** affiche les
  PR cachées (grisées, bouton restaurer) ;
- **filtrer par org/repo** : tape `mapado` ou `mapado/web` dans le champ puis **Filtrer** (le serveur
  ne charge **que** ce scope) ; **Tout** réaffiche tout.
- **couper les notifications desktop** : décoche **🔔 notifs** dans l'en-tête. Le serveur continue de
  suivre les évènements (ils sont marqués « vus » en silence), il cesse simplement de pousser des
  notifs — recocher ne déclenche donc **pas** de rafale de vieilles notifs. Le choix est
  **persisté** dans `~/.local/state/gh-notif/prefs-v1.json` (survit à un redémarrage).
- **choisir le thème** : le switcher **🌗 auto / ☀️ clair / 🌙 sombre** dans l'en-tête. `auto` suit ton
  système (défaut) ; `clair`/`sombre` forcent. Appliqué immédiatement (sans recharger) et **persisté**
  dans le même fichier de préférences.

Le **look & feel** reprend les couleurs GitHub (Primer, clair/sombre selon ton système). Zéro
dépendance : servi par le module HTTP natif de Node, tout est inline (aucun asset externe).
`Ctrl-C` arrête le serveur. Un lien **🐛** dans l'en-tête mène à la page de debug (voir ci-dessous).

### Lancer au démarrage (Linux · systemd)

Pour avoir le dashboard en permanence, sans le relancer à la main à chaque session, déclare-le en
**service systemd *utilisateur*** (`~/.config/systemd/user/gh-notif.service`) :

```ini
[Unit]
Description=gh notif --serve (dashboard GitHub local)
After=graphical-session.target network-online.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=%h
# node installé via nvm/asdf ? le shebang est `#!/usr/bin/env node` : donne un PATH explicite
# Environment=PATH=%h/.nvm/versions/node/vXX.Y.Z/bin:/usr/local/bin:/usr/bin:/bin
# évite d'ouvrir un onglet de navigateur à chaque (re)démarrage
Environment=BROWSER=/bin/true
ExecStart=/usr/bin/gh notif --serve --port 7777

Restart=always
RestartSec=10
# ne jamais abandonner, même après des crashs en rafale
StartLimitIntervalSec=0

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now gh-notif.service
```

Trois points qui font échouer le service si on les rate :

- **service *utilisateur*, pas système** : les notifications desktop passent par le D-Bus de ta
  session et `gh` lit ton auth dans `~/.config/gh`. Un service système n'a ni l'un ni l'autre.
- **`PATH` explicite si node vient de nvm/asdf** : systemd démarre avec un `PATH` minimal, et
  l'entrypoint est un `#!/usr/bin/env node` — sans ça, `node: command not found`.
- **`BROWSER=/bin/true`** : `--serve` ouvre le navigateur au démarrage (via `xdg-open`) ; sans ce
  garde-fou, chaque redémarrage du service t'ouvre un onglet.

Piloter le service au quotidien :

```bash
systemctl --user status gh-notif        # état, PID, dernières lignes de log
systemctl --user restart gh-notif       # relance (après une mise à jour de l'extension)
systemctl --user stop gh-notif          # arrête — et ne redémarre PAS (stop explicite ≠ crash)
systemctl --user disable gh-notif       # ne se lance plus au login
journalctl --user -u gh-notif -f        # logs en direct
```

Après avoir modifié le fichier `.service`, un `systemctl --user daemon-reload` est **obligatoire**
avant le `restart` : sinon systemd relance l'ancienne version gardée en mémoire.

> ⚠️ Ne tue jamais le process à la main : `gh` lance un **process node enfant** qui survit au `kill`
> du parent et garde le port occupé (le service redémarre alors en boucle sur `EADDRINUSE`). Passe
> par `systemctl --user restart/stop`, qui nettoie tout le cgroup.

## Debug — vérifier la détection

Pour comprendre *pourquoi* une PR remonte (ou pas), le mode debug expose le **verdict du pipeline**
par thread de notification : la `reason` GitHub, le nombre de commentaires, et la décision de
classification — **gardé** (en trigger X) ou **droppé** (avec la raison).

- **`gh notif --debug`** (et `gh notif --watch --debug`) : ajoute ce dump sous les tableaux, en terminal.
- **`gh notif --serve`** : la page **`/debug`** (lien 🐛 dans l'en-tête) est **toujours disponible**
  et s'auto-rafraîchit ; **`/api/debug`** renvoie le même diagnostic en JSON.

> ⚠️ GitHub **ne crée pas de notification pour tes propres actions** : commenter toi-même une PR
> au calme ne la fera pas remonter (il n'y a rien à détecter). Le debug montre donc le raisonnement
> du pipeline sur les données réelles, pas « tes messages ». La capture du diagnostic est **toujours
> active** (coût nul : la donnée est déjà récupérée par le poll) ; seul l'affichage est gaté.

## Prérequis

- [`gh`](https://cli.github.com/) authentifié (`gh auth login`)
- Node ≥ 18
- Notifications desktop (optionnel : sans elles, `--watch` logge quand même dans le terminal) :
  - **Linux** : `notify-send` (paquet `libnotify-bin`)
  - **macOS** : `osascript` (fourni de base, rien à installer)

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
gh notif --watch -v           # + journal des évènements sous les tableaux
gh notif --serve              # page web locale auto-rafraîchie (http://localhost:7777)
gh notif --serve --port 8080  # page web sur un autre port
gh notif --watch --interval 120  # poll toutes les 120s (plancher 60s)
gh notif --show-hidden        # affiche aussi les PR masquées (grisées, 🙈)
gh notif --debug              # dump du verdict du pipeline (terminal ; /debug en --serve)
gh notif --org mapado         # limite à une organisation
gh notif --repo mapado/web    # limite à un dépôt
gh notif --repo               # limite au dépôt courant (gh repo view)
```

`--org` et `--repo` sont mutuellement exclusifs et fonctionnent aussi avec `--watch` et `--serve`.

> 💡 Couleurs et liens cliquables s'activent en terminal interactif. En pipe/redirection (ou avec
> `NO_COLOR`), la sortie est en texte simple et déterministe.

## Développement

Zéro dépendance npm, ESM, tests via le runner natif de Node :

```bash
npm test          # node --test
```

L'architecture est décrite dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
