import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Préférences UI persistées (mode --serve). Aujourd'hui une seule clé : `notify`
// (notifications desktop). Calqué sur state.js / hidden.js : fonctions pures +
// persistance JSON, testables sur fixtures. Défauts appliqués à la lecture pour
// qu'un fichier ancien/partiel reste valide (les notifs sont activées par défaut).

const DEFAULTS = { notify: true };

export function prefsPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'prefs-v1.json');
}

export function loadPrefs(path) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
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
