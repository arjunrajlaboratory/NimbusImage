import fs from "fs";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { visualizer } from "rollup-plugin-visualizer";
import path from "node:path";
import yaml from "@rollup/plugin-yaml";
import vuetify from "vite-plugin-vuetify";
import { sentryVitePlugin } from "@sentry/vite-plugin";

function joinAndNormalizePath(...paths) {
  return normalizePath(path.join(...paths));
}

// Analyze node_modules to see if we can find some names nimbus_plugin_XXX
// Those modules will override components in the alias config step
const nodeModulesPath = path.join(__dirname, "node_modules");
const nimbusPlugins = fs.readdirSync(nodeModulesPath).filter((file) => {
  return (
    fs.statSync(path.join(nodeModulesPath, file)).isDirectory() &&
    file.startsWith("nimbus_plugin_")
  );
});
const overriddenComponentsToNodeModules = Object.fromEntries(
  nimbusPlugins.map((pluginPath) => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(nodeModulesPath, pluginPath, "package.json")),
    );
    if (!packageJson.nimbusPluginOverrides) {
      throw `${pluginPath} is missing the field "nimbusPluginOverrides" in its package.json file.`;
    }
    return [packageJson.nimbusPluginOverrides, pluginPath];
  }),
);

// https://vitejs.dev/config/
export default defineConfig(({ _, mode }) => {
  const isProduction = mode === "production";

  // Source-map upload to Sentry is gated on SENTRY_AUTH_TOKEN being set at
  // build time. When enabled, we generate hidden sourcemaps so the plugin
  // can read them, then delete them after upload so they aren't shipped.
  const uploadSourcemapsToSentry =
    isProduction && !!process.env.SENTRY_AUTH_TOKEN;

  return {
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
    yaml(),
    !isProduction && visualizer({
      filename: "./dist/stats.html",
      open: false,
      gzipSize: true,
    }),
    uploadSourcemapsToSentry &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: { name: process.env.SENTRY_RELEASE },
        sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
        telemetry: false,
      }),
    viteStaticCopy({
      silent: true,
      targets: [
        {
          src: joinAndNormalizePath(
            __dirname,
            "itk",
            "emscripten-build",
            "**",
            "*.{js,wasm.zst}",
          ),
          dest: joinAndNormalizePath("pipelines"),
        },
        {
          src: joinAndNormalizePath(
            __dirname,
            "node_modules",
            "onnxruntime-web",
            "dist",
            "*.wasm",
          ),
          dest: joinAndNormalizePath("onnx-wasm"),
        },
      ],
      watch: {
        reloadPageOnChange: !isProduction,
      },
    }),
  ],
  resolve: {
    // Implement a plugin feature
    // For each Vue component, we try to see if a plugin (a node_module named nimbus_plugin_XXX)
    //does not override it. If yes, we replace the component path to the node_module, otherwise, we
    // leave it as is.
    alias: [
      {
        // Match all imports ending with ".vue"
        find: /@\/(\w+\/)+(\w+.vue)/,
        replacement: (arg) => {
          const componentName = arg.split("/").pop();
          if (
            Object.keys(overriddenComponentsToNodeModules).includes(
              componentName,
            )
          ) {
            console.log(
              `Vue component ${componentName} will be overridden with node_module: ${overriddenComponentsToNodeModules[componentName]}`,
            );
            return overriddenComponentsToNodeModules[componentName];
          }
          return `${fileURLToPath(new URL("./src", import.meta.url))}${arg.slice(1)}`;
        },
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  optimizeDeps: {
    exclude: ["itk-wasm"],
  },
  build: {
      // Production specific settings
      minify: isProduction ? "esbuild" : false,
      // Useful for debugging in dev. In prod, "hidden" generates .map files
      // (so Sentry can upload them) without adding sourceMappingURL comments
      // to the bundles. Plain prod builds get no sourcemaps.
      sourcemap: uploadSourcemapsToSentry ? "hidden" : !isProduction,
      rollupOptions: {
        output: {
          // Helps with browser caching by adding hashes to filenames
          chunkFileNames: "assets/js/[name]-[hash].js",
          entryFileNames: "assets/js/[name]-[hash].js",
          assetFileNames: "assets/[ext]/[name]-[hash].[ext]",
        },
      },
      // Clear the output directory before building
      emptyOutDir: true,
      // Adjust chunk size warning limit (standard is 500kb)
      chunkSizeWarningLimit: 1000,
  }}
});
