import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Préférences UI persistées : `notify` (notifications desktop), `theme` (skin
// CSS), `favorites` (scopes épinglés), `activeFav` (favori affiché) et `sort`
// (tri du tableau « autres » en --serve, validé par `normalizeSort` à l'usage).
// Calqué sur state.js / hidden.js : fonctions pures + persistance JSON, testables sur
// fixtures. Défauts appliqués à la lecture pour qu'un fichier ancien/partiel reste
// valide (notifs activées, thème auto, aucun favori, tri non choisi) — donc aucune
// migration à prévoir en ajoutant une clé.
//
// ⚠️ Écriture : muter l'objet prefs en mémoire puis le ré-écrire EN ENTIER
// (`prefs.favorites = …; savePrefs(path, prefs)`). Surtout pas
// `savePrefs(path, { favorites })` : ça effacerait notify/theme.

const DEFAULTS = { notify: true, theme: 'auto', favorites: [], activeFav: null, sort: null, ignoredChecks: {} };
const THEMES = ['light', 'dark', 'auto'];

export function prefsPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'prefs-v1.json');
}

// ⚠️ `favorites` est un tableau : un simple `{ ...DEFAULTS }` en partagerait la
// référence entre tous les appels (une mutation polluerait DEFAULTS). On en
// recopie donc toujours une instance fraîche.
const defaults = () => ({ ...DEFAULTS, favorites: [...DEFAULTS.favorites], ignoredChecks: {} });

export function loadPrefs(path) {
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return defaults();
  }
}

export function savePrefs(path, prefs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2));
}

// Notifs desktop activées ? Vrai par défaut : seul un `notify: false` explicite
// les désactive (cohérent avec les défauts de loadPrefs).
export function isNotifyEnabled(prefs) {
  return prefs?.notify !== false;
}

// Thème CSS choisi : 'light' | 'dark' | 'auto'. Toute valeur inconnue/absente
// retombe sur 'auto' (suit le système) — robuste face à un fichier trafiqué.
export function themeOf(prefs) {
  const t = prefs?.theme;
  return THEMES.includes(t) ? t : 'auto';
}

// Blocklist des jobs de CI, par repo : { "owner/name": ["nom de check", …] }.
// Défaut {} (aucun repo configuré). Robuste face à un fichier trafiqué : toute
// valeur non-objet retombe sur {}.
export function ignoredChecksOf(prefs) {
  const m = prefs?.ignoredChecks;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// Jobs ignorés pour un repo donné (tableau ; [] si absent ou valeur non-tableau).
export function ignoredChecksFor(prefs, repo) {
  const v = ignoredChecksOf(prefs)[repo];
  return Array.isArray(v) ? v : [];
}

// Bascule un check dans la blocklist d'un repo (toggle, nom trimmé) : présent → on
// le retire (et on **supprime la clé repo** si sa liste devient vide → map propre) ;
// absent → on l'ajoute. Mute `prefs.ignoredChecks` EN PLACE (créé si absent) — cf.
// piège §14 : l'appelant réécrit ensuite `prefs` EN ENTIER via savePrefs. Sert au
// POST /ignore-check (case à cocher de la vue debug web).
export function toggleIgnoredCheck(prefs, repo, name) {
  const n = String(name).trim();
  if (!prefs.ignoredChecks || typeof prefs.ignoredChecks !== 'object' || Array.isArray(prefs.ignoredChecks)) {
    prefs.ignoredChecks = {};
  }
  const list = Array.isArray(prefs.ignoredChecks[repo]) ? prefs.ignoredChecks[repo] : [];
  const next = list.includes(n) ? list.filter((x) => x !== n) : [...list, n];
  if (next.length === 0) delete prefs.ignoredChecks[repo];
  else prefs.ignoredChecks[repo] = next;
  return prefs;
}
