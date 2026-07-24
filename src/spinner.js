// Small spinner during requests. Writes to stderr (by default) so as not to
// pollute stdout (which may be redirected). No-op outside a TTY. Returns a
// stop() function that clears the line and shows the cursor again.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(label, stream = process.stderr) {
  if (!stream || !stream.isTTY) return () => {};
  let i = 0;
  const render = () => stream.write(`\r\x1b[2m${FRAMES[i++ % FRAMES.length]} ${label}\x1b[0m\x1b[K`);
  stream.write('\x1b[?25l'); // hide the cursor
  render();
  const id = setInterval(render, 80);
  if (id.unref) id.unref(); // don't keep the process alive for the timer
  return () => {
    clearInterval(id);
    stream.write('\r\x1b[K\x1b[?25h'); // clear the line + show the cursor again
  };
}
