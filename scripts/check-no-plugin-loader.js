// QSF-025 / P0.9 — the plugin API must stay definition-only.
//
// packages/ui/src/lib/plugin-api.ts describes runtime plugins with broad
// permissions (fs:write, fs:execute, net:http), but there is no loader, no
// isolation boundary, no permission enforcement, no signing and no revocation
// model. Loading third-party code into the privileged webview under those
// conditions is a Critical finding, so the safe state is "no loader exists".
//
// Nothing enforced that today: the API is inert only because nobody has
// written the loader yet. This check turns that accident into a gate — it
// fails if any source file gains a way to fetch, import or evaluate plugin
// code. Lifting it requires the Phase 5 security model first.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SEARCH_ROOTS = [
  "packages/ui/src",
  "apps/desktop/src",
  "apps/web/src",
  "apps/web/server",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".svelte-kit",
  "build",
  "dist",
  "target",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".svelte"]);

// A dynamic import/eval is only a finding when it is reachable from something
// plugin-shaped; `import()` for code splitting is normal and must stay allowed.
const DANGEROUS = [
  {
    // import(<anything mentioning "plugin">) — a plugin entry point. The
    // character class must NOT exclude quotes or backticks: the first version
    // of this check did, so a template-literal plugin path slipped straight
    // through and the gate reported success against a real loader.
    pattern: /\bimport\s*\([^)]*plugin/gi,
    what: "dynamic import of a plugin path",
  },
  {
    pattern: /\bnew\s+Function\s*\(/g,
    what: "new Function() — arbitrary code evaluation",
  },
  {
    pattern: /(^|[^.\w])eval\s*\(/g,
    what: "eval() — arbitrary code evaluation",
  },
  {
    // Reading a plugin manifest off disk is the first half of a loader.
    pattern: /readFile[^\n]*plugins?[/\\]/gi,
    what: "reading from a plugins directory",
  },
];

/** Collect every source file under a root, skipping build output. */
function collectFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(path.join(dir, entry.name), found);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

const findings = [];

for (const root of SEARCH_ROOTS) {
  for (const file of collectFiles(path.join(repoRoot, root))) {
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split("\n");

    for (const { pattern, what } of DANGEROUS) {
      lines.forEach((line, index) => {
        // Comments describing why a loader is absent must not trip the check.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        pattern.lastIndex = 0;
        if (pattern.test(code)) {
          findings.push({
            file: path.relative(repoRoot, file),
            line: index + 1,
            what,
            text: line.trim(),
          });
        }
      });
    }
  }
}

if (findings.length > 0) {
  console.error("❌ Plugin loading is not permitted (QSF-025).\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} — ${f.what}`);
    console.error(`    ${f.text}\n`);
  }
  console.error(
    "The plugin API is documentation-only and has no sandbox, permission\n" +
      "enforcement or revocation model. Loading plugin code requires the\n" +
      "Phase 5 security model in\n" +
      "docs/COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md first."
  );
  process.exit(1);
}

console.log("✅ No plugin loading path found (QSF-025).");
