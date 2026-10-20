// Every translation key the UI asks for must exist.
//
// `$_("some.key")` with a key that is not in the locale files does not fail:
// the i18n store returns the key itself, so the user sees "tasks.errors.busy"
// on screen and every type check stays green. check-locales.js only proves the
// six locale files agree with *each other* — not that they contain what the
// code uses. This closes that gap for every literal key, and for the dynamic
// families built from a fixed set of values (task type, task status, error
// kind, menu descriptions), which are enumerated below.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOTS = ["packages/ui/src", "apps/desktop/src", "apps/web/src"];
const SKIP_DIRS = new Set(["node_modules", ".svelte-kit", "build"]);
const EXTENSIONS = new Set([".svelte", ".ts", ".js"]);

const en = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/ui/src/lib/locales/en.json"), "utf8"));
const lookup = (key) => key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), en);

// Keys assembled at runtime from a closed set of values.
const DYNAMIC = [
  ...["copy", "move", "delete"].map((t) => `tasks.type.${t}`),
  ...["queued", "running", "paused", "waitingforinput", "extracting", "completed", "failed", "cancelled"].map(
    (s) => `tasks.status.${s}`
  ),
  // shortcuts.ts displayShortcut()
  ...["ctrl", "alt", "shift", "space", "insert", "enter", "num", "pgup", "pgdn", "esc"].map((k) => `keys.${k}`),
  ...["permission_denied", "not_found", "no_space", "read_only", "busy", "source_retained", "other"].flatMap(
    (k) => [`tasks.errors.${k}`, `tasks.error_hints.${k}`]
  ),
];

// A literal first argument of the translation function: $_("a.b"), $_('a.b'),
// get(_)("a.b"). Template-literal keys are covered by DYNAMIC above.
const CALL = /(?:\$_|get\(_\))\(\s*(["'])([a-z0-9_]+(?:\.[a-z0-9_]+)+)\1/g;
// Keys stored in data and translated later (`label: "media_viewer.scale_small"`,
// `info: "dialog.pack_info_zip"`).
const STORED = /\b(?:label|info|labelKey|detail)\s*:\s*(["'])([a-z0-9_]+\.[a-z0-9_.]+)\1/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const missing = [];
let checked = 0;
for (const root of SEARCH_ROOTS) {
  for (const file of walk(path.join(repoRoot, root), [])) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of [CALL, STORED]) {
      for (const m of text.matchAll(re)) {
        checked++;
        if (typeof lookup(m[2]) !== "string") {
          const line = text.slice(0, m.index).split("\n").length;
          missing.push(`${path.relative(repoRoot, file)}:${line}  ${m[2]}`);
        }
      }
    }
  }
}
for (const key of DYNAMIC) {
  checked++;
  if (typeof lookup(key) !== "string") missing.push(`(dynamic)  ${key}`);
}

if (missing.length > 0) {
  console.error(`❌ ${missing.length} translation key(s) used by the UI do not exist in en.json:\n`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}
console.log(`✅ All ${checked} translation keys used by the UI exist in en.json.`);
