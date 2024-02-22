import { fileURLToPath, URL } from "node:url";

import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue2";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "node:path";

// Shouldn't be needed after moving to Vue 3
import { VuetifyResolver } from "unplugin-vue-components/resolvers";
import Components from "unplugin-vue-components/vite";

function joinAndNormalizePath(...paths) {
  return normalizePath(path.join(...paths));
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    Components({
      resolvers: [VuetifyResolver()],
      // Don't exclude grider web components
      exclude: [
        /[\\/]node_modules[\\/](?!@girder[\\/]components[\\/])/,
        /[\\/]\.git[\\/]/,
        /[\\/]\.nuxt[\\/]/,
      ],
    }),
    viteStaticCopy({
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
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ["itk-wasm"],
  },
});
