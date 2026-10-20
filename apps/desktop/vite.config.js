import { defineConfig, normalizePath, searchForWorkspaceRoot } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compile } from "svelte/compiler";

const host = (
  // @ts-ignore
  process.env.TAURI_DEV_HOST
);

let viteRoot = process.cwd();

/**
 * Reproduces @sveltejs/vite-plugin-svelte's dev-mode scope hash so the CSS this
 * plugin emits carries the same `s-xxxxxxxx` class the component's JS was
 * compiled against. Must stay in sync with its utils/hash.js (md5 -> base64,
 * +/= made URL-safe, first 12 chars) and utils/id.js (`stripRoot`).
 *
 * Note this is NOT `path.relative`: vite-plugin-svelte only strips the root when
 * the file actually lives under it, and otherwise hashes the full absolute path.
 * `packages/ui` resolves outside apps/desktop, so `path.relative` would produce
 * `/../../packages/...` and silently scope every shared component's styles to a
 * class its markup never gets.
 *
 * @param {string} filename
 */
function svelteScopeHash(filename) {
  const normalizedRoot = normalizePath(viteRoot);
  const normalized = normalizePath(filename);
  const stripped = normalized.startsWith(normalizedRoot + "/")
    ? normalized.slice(normalizedRoot.length)
    : normalized;

  return (
    "s-" +
    createHash("md5")
      .update(stripped)
      .digest("base64")
      .replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""))
      .slice(0, 12)
  );
}

/**
 * On a cold dev start a `?svelte&type=style` request can arrive before
 * vite-plugin-svelte has the compiled CSS in its cache, and it answers with
 * nothing — the app then paints unstyled until the next edit. Recompile the
 * component here as a fallback. `enforce: "post"` means this only runs when
 * vite-plugin-svelte itself returned null, so the warm path is untouched.
 *
 * @type {import("vite").Plugin}
 */
const coldSvelteStyleFallback = {
  name: "nexus-cold-svelte-style-fallback",
  enforce: "post",
  configResolved(config) {
    viteRoot = config.root;
  },
  async load(id) {
    const [filename, rawQuery = ""] = id.split("?", 2);
    const query = new URLSearchParams(rawQuery);
    if (!query.has("svelte") || query.get("type") !== "style") {
      return;
    }

    try {
      const source = await readFile(filename, "utf8");
      const compiled = compile(source, {
        filename,
        generate: "client",
        css: "external",
        dev: true,
        hmr: true,
        cssHash: () => svelteScopeHash(filename),
      });
      return compiled.css?.code ?? "";
    } catch (e) {
      // Never take the dev server down over a fallback. Returning undefined
      // leaves the request as it was without this plugin.
      console.warn(`[nexus-cold-svelte-style-fallback] ${filename}:`, e);
      return;
    }
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [coldSvelteStyleFallback, sveltekit()],
  resolve: {
    preserveSymlinks: true,
  },
  // @nexus/ui is a symlinked workspace package under active development, not a
  // real external dependency. Vite's dep optimizer pre-bundles and caches it
  // like any node_modules package and does not reliably invalidate that cache
  // when its source changes, so edits (e.g. to i18n/locales) can silently keep
  // serving a stale snapshot. Excluding it forces Vite to always serve its
  // live source.
  optimizeDeps: {
    exclude: ["@nexus/ui"],
  },
  build: {
    rollupOptions: {
      output: {
        /** @param {string} id */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          // Shared UI source is symlinked through node_modules in the desktop
          // app. Let Rollup keep those components in their natural static or
          // lazy graph, otherwise FileEditor would be pulled back into the
          // eagerly loaded vendor chunk.
          if (id.includes("/node_modules/@nexus/ui/")) return;

          // Language parsers are dynamic imports. Keeping both their wrapper
          // and Lezer grammar dependencies out of a manual vendor chunk means
          // opening one file type downloads only the parser it needs.
          if (id.includes("/@codemirror/lang-") || id.includes("/@lezer/")) return;

          if (id.includes("/@codemirror/") || id.includes("/codemirror/")) {
            return "vendor-codemirror";
          }
          if (id.includes("/lucide-svelte/")) return "vendor-icons";
          if (id.includes("/@sveltejs/") || id.includes("/svelte/")) {
            return "vendor-svelte";
          }
          return "vendor";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())],
    },
  },
}));
