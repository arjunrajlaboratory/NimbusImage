import { fileURLToPath } from "node:url";
import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

const viteConfigObject = viteConfig({})

// We have to put the "@/test" alias BEFORE the "@" alias from viteConfig
// Otherwise, "@/test" is resolved to the folder "test" in the alias "@", instead of the alias "@/test"
viteConfigObject.resolve.alias.unshift({
  find: "@/test",
  replacement: fileURLToPath(new URL("./test", import.meta.url)),
});

// Resolve onnxruntime-web/webgpu for test environment.
// The package exports "node": null for ./webgpu, so Vite can't resolve it in node/jsdom.
// We alias it to the browser entry so vi.mock can intercept it.
viteConfigObject.resolve.alias.push({
  find: "onnxruntime-web/webgpu",
  replacement: fileURLToPath(
    new URL(
      "./node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
      import.meta.url,
    ),
  ),
});

export default mergeConfig(
  viteConfigObject,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      // Keep Vitest from globbing generated or duplicate test trees. Girder's
      // .tox environments contain bundled *.spec.ts files, while Codex/Claude
      // worktrees contain complete copies of this repository's tests. Both are
      // absent in CI but cause spurious failures and duplicate memory use when
      // running `pnpm test` locally.
      exclude: [
        ...configDefaults.exclude,
        "e2e/*",
        "db/**",
        "**/.tox/**",
        "**/.claude/worktrees/**",
      ],
      root: fileURLToPath(new URL("./", import.meta.url)),
      setupFiles: [
        fileURLToPath(new URL("./test/setup.ts", import.meta.url)),
      ],
      // Vitest 3 exits with code 1 on unhandled async errors even when all tests pass.
      // Our tests produce harmless async lifecycle errors (e.g., ImageViewer tile URL
      // generation after teardown). These aren't real failures.
      dangerouslyIgnoreUnhandledErrors: true,
      server: {
        deps: {
          inline: ["vuetify"],
        },
      },
    },
  }),
);
