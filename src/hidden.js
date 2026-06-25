import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TRIGGER_FOR } from './filter.js';

// Persistance + logique pure du masquage des PR des autres. L'interaction clavier
// (touche `h`, numéro + Entrée) vit dans l'entrypoint ; ici, tout est testable.

export function hiddenPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'gh-notif', 'hidden-v1.json');
}

export function loadHidden(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function saveHidden(path, map) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
}

export function keyOf(x) {
  return `${x.repo}#${x.number}`;
}

// URLs des items de notification qui portent un trigger (mention/reply/comment)
// pour cette PR. review_request est exclu (absent de TRIGGER_FOR) : sa signature
// est donc vide — une review demandée masquée reste cachée jusqu'à une vraie
// interaction (cf. ARCHITECTURE §10).
export function signatureOf(key, items) {
  const urls = [];
  for (const it of items || []) {
    if (keyOf(it) === key && TRIGGER_FOR[it.category] && it.url) urls.push(it.url);
  }
  return [...new Set(urls)];
}

export function isHidden(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Masque (instantané de la signature courante) ou restaure. Mute `map` ; renvoie
// true si la PR est désormais masquée.
export function toggleHidden(map, key, items, nowIso = new Date().toISOString()) {
  if (isHidden(map, key)) { delete map[key]; return false; }
  map[key] = { at: nowIso, seen: signatureOf(key, items) };
  return true;
}

// Dé-masque une PR dès qu'un nouvel évènement (URL absente de l'instantané)
// apparaît, et élague les clés absentes des entrées courantes. Mute `map` ;
// renvoie true si elle a changé.
export function reconcile(map, entries, items) {
  const present = new Set((entries || []).map(keyOf));
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!present.has(key)) { delete map[key]; changed = true; continue; }
    const seen = new Set(map[key].seen || []);
    const hasNew = signatureOf(key, items).some((u) => !seen.has(u));
    if (hasNew) { delete map[key]; changed = true; }
  }
  return changed;
}

// Label de sélection d'une ligne = le numéro de la PR (ex. '7004'), tel qu'affiché
// dans la colonne « PR ». L'utilisateur tape ce numéro (buffer + Entrée) dans
// l'entrypoint. En cas de doublon de numéro entre dépôts, la 1re ligne l'emporte.
export function assignLabels(rows) {
  return rows.map((r) => String(r.number));
}
