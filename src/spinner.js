// Petit spinner pendant les requêtes. Écrit sur stderr (par défaut) pour ne pas
// polluer stdout (qui peut être redirigé). No-op hors TTY. Renvoie une fonction
// stop() qui efface la ligne et réaffiche le curseur.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(label, stream = process.stderr) {
  if (!stream || !stream.isTTY) return () => {};
  let i = 0;
  const render = () => stream.write(`\r\x1b[2m${FRAMES[i++ % FRAMES.length]} ${label}\x1b[0m\x1b[K`);
  stream.write('\x1b[?25l'); // masque le curseur
  render();
  const id = setInterval(render, 80);
  if (id.unref) id.unref(); // ne pas maintenir le process en vie pour le timer
  return () => {
    clearInterval(id);
    stream.write('\r\x1b[K\x1b[?25h'); // efface la ligne + réaffiche le curseur
  };
}
