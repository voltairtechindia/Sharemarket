/* Copy to assets/local-config.js and fill in your own values.
   That path is gitignored, so it stays on your machine.

   journalAuth is optional. Leave it out and the page asks you to set a
   passcode on first use, storing its hash in your browser. Either way the
   gate is a convenience, not security: this is a public static page, so the
   real protection is that trades never leave your browser. */
window.KT_LOCAL = {
  openrouterKey: "sk-or-v1-your-key-here",
  journalAuth: null
};
