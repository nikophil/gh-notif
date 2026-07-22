import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Préférences UI persistées : `notify` (notifications desktop), `theme` (skin
// CSS), `favorites` (scopes épinglés) et `activeFav` (favori affiché). Calqué sur
// state.js / hidden.js : fonctions pures + persistance JSON, testables sur
// fixtures. Défauts appliqués à la lecture pour qu'un fichier ancien/partiel reste
// valide (notifs activées, thème auto, aucun favori) — donc aucune migration à
// prévoir en ajoutant une clé.
//
// ⚠️ Écriture : muter l'objet prefs en mémoire puis le ré-écrire EN ENTIER
// (`prefs.favorites = …; savePrefs(path, prefs)`). Surtout pas
// `savePrefs(path, { favorites })` : ça effacerait notify/theme.

const DEFAULTS = { notify: true, theme: 'auto', favorites: [], activeFav: null };
const THEMES = ['light', 'dark', 'auto'];

export function prefsPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'prefs-v1.json');
}

// ⚠️ `favorites` est un tableau : un simple `{ ...DEFAULTS }` en partagerait la
// référence entre tous les appels (une mutation polluerait DEFAULTS). On en
// recopie donc toujours une instance fraîche.
const defaults = () => ({ ...DEFAULTS, favorites: [...DEFAULTS.favorites] });

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
