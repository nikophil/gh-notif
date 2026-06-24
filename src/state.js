import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export function statePath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  // v2 : dédup par URL d'évènement (et non plus par thread/updated_at). Nouveau
  // nom de fichier pour qu'une ancienne base ne provoque pas un flot au passage v2.
  return join(base, 'gh-notif', 'seen-v2.json');
}

export function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// Dédup par URL de l'évènement précis (URL du commentaire, ou URL de la PR pour
// une demande de review). Insensible aux bumps d'`updated_at` du thread dus à
// l'activité d'autrui → on ne re-notifie pas pour le même évènement.
export function isNew(state, item) {
  return !(item.url in state);
}

export function markSeen(state, item) {
  state[item.url] = item.updatedAt;
}
