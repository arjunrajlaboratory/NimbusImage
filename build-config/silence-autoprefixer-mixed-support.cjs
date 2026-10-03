// Drops autoprefixer's cosmetic "… value has mixed support" advisories.
// They fire unconditionally on third-party CSS we don't control (Vuetify's
// `align-items: start` etc.) and are harmless for our supported browsers
// (see build.target in vite.config.js). Runs after autoprefixer and strips
// just those warnings so the dev/build console stays clean.
module.exports = () => ({
  postcssPlugin: "silence-autoprefixer-mixed-support",
  OnceExit(_root, { result }) {
    result.messages = result.messages.filter(
      (m) => !(m.type === "warning" && /mixed support/.test(m.text || "")),
    );
  },
});
module.exports.postcss = true;
