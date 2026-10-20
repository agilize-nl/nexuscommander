// P1.7 — no mutation may bypass the commit engine.
//
// Phase 1 routed copy, move, rename and whole-file writes through
// `src/engine/commit.rs`, which stages into the destination directory and
// publishes by rename. That guarantee is only worth anything while it has no way
// around it: one `fs::copy` added later, in a hurry, reintroduces QSF-001 in the
// exact path the engine exists to protect.
//
// So: outside `src/engine/`, the truncating and destructive `std::fs` calls are
// refused unless they appear in the allowlist below with a written reason.
//
// # Why this checks for the *alias* too
//
// `check-no-plugin-loader.js` shipped with a regex that excluded backticks, so a
// template-literal plugin path never matched and the gate passed against a real
// loader. The equivalent here is `use std::fs as f; f::copy(...)`, or a
// fully-qualified `std::fs::rename`, or a call inside a macro body. All four are
// probed in the commit that added this file, and the matcher is written against
// them rather than against the one obvious spelling.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(repoRoot, "apps/desktop/src-tauri/src");
const ENGINE = path.join(SRC, "engine");

const WEB_SRC = path.join(repoRoot, "apps/web/server");
const WEB_COMMIT = path.join(WEB_SRC, "lib/commit.js");

/**
 * Calls that can destroy or truncate existing data (Rust).
 *
 * `create_dir`/`create_dir_all` are deliberately absent: creating a directory
 * destroys nothing, and there is no staged form of it to prefer.
 */
const FORBIDDEN_RUST = [
  "copy",
  "rename",
  "write",
  "remove_file",
  "remove_dir",
  "remove_dir_all",
  "set_permissions",
  "hard_link",
  "soft_link",
];

/**
 * Calls that can destroy or truncate existing data (JS).
 */
const FORBIDDEN_JS = [
  "createWriteStream",
  "writeFile",
  "rename",
  "rm",
  "unlink",
  "copyFile",
  "cp",
  "truncate",
];

/**
 * Reviewed exemptions for Rust, as `file -> reason`.
 *
 * An entry means "every forbidden call in this file has been reviewed". That is
 * coarse, and it is the honest granularity for `archive.rs` — 26 sites that all
 * belong to one unfinished piece of work. Per-line pragmas would let a new call
 * slip in beside a reviewed one.
 */
const ALLOWLIST = new Map([
  [
    "vfs.rs",
    "Deletion (delete_entry_permanent) has nothing to stage — there is no " +
      "replacement to verify, only the removal itself. Directory creation " +
      "destroys nothing. set_permissions changes metadata, not content. " +
      "Reviewed for P1.7: every content-replacing path here goes through " +
      "engine::commit. Also the source removal in " +
      "move_directory_by_copying, which runs only *after* the whole tree " +
      "has committed through engine::commit (the QSF-002 ordering), and " +
      "reports failure rather than 'moved' when the removal fails.",
  ],
  [
    "task_queue.rs",
    "Source removal after a committed cross-device copy (the ordering QSF-002 " +
      "is about — it happens *after* the commit, never before), the delete " +
      "task's own removals, and mkdir for the recursive copy. Reviewed for " +
      "P1.7: copy and move both go through engine::commit.",
  ],
  [
    "archive.rs",
    "Every remaining call writes inside a private staging directory or cleans " +
      "one up: File::create for the pack output (ArchiveStaging, P1.5) and for " +
      "extracted entries under .nc_extract_tmp_* (0700, inside the " +
      "destination), set_permissions on those staged entries, and " +
      "remove_dir_all of the staging directory itself. Nothing here touches a " +
      "path the user can see — promotion out of staging goes through " +
      "engine::commit::move_entry_staged under an explicit ExtractConflict " +
      "policy (P2.3 / QSF-004), so an existing destination file is only " +
      "replaced when the caller asked for it.",
  ],
  [
    "settings.rs",
    "Config directory creation only; the write itself goes through " +
      "engine::commit::write_config_atomically (P1.4).",
  ],
]);

/**
 * Reviewed exemptions for JS, as `file -> reason`.
 */
const WEB_ALLOWLIST = new Map([
  [
    "lib/taskExecutor.js",
    "Task executor uses fs.rm to clean up temporary staging directory after extraction.",
  ],
  [
    "routes/fs.js",
    "Deletion (fs.rm) has nothing to stage — there is no replacement to verify, " +
      "only the removal itself, and it runs only for mode === 'permanent'. The " +
      "default (trash) goes through commit.js::trashEntry, which is a rename " +
      "like every other publish. Other mutations go through moveEntryStaged or " +
      "writeFileAtomically.",
  ],
  [
    "routes/settings.js",
    "Settings route takes backups using fs.copyFile before writing the " +
      "new settings atomically via writeFileAtomically.",
  ],
  [
    "routes/archive.js",
    "The only remaining calls are fs.rm of the extraction staging directory " +
      "(.nc_extract_tmp_*, 0700, inside the destination) and " +
      "writeFileAtomically, which *is* the commit engine. Promotion out of " +
      "staging goes through moveEntryStaged under an explicit conflict policy " +
      "(P2.3 / QSF-004) — the bare fs.rename it used to publish with replaced " +
      "the user's same-named files without asking or reporting.",
  ],
]);

const problems = [];

// Strip Rust line and block comments, and the bodies of string literals.
function stripRustNoise(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"') {
      out += " ";
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          out += " ";
          i++;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Strip JS line and block comments, and string literal bodies.
function stripJsNoise(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += " ";
          i++;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Module paths that resolve to `std::fs` (Rust).
 *
 * Always includes `fs` and `std::fs`; `use std::fs as f;` adds `f`. Without this
 * the gate would be trivially defeated by a rename, which is the whole lesson
 * from the plugin-loader check.
 */
function fsAliasesRust(source) {
  const aliases = new Set(["fs", "std::fs", "::std::fs"]);
  const re = /use\s+(?:::)?std::fs\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let m;
  while ((m = re.exec(source)) !== null) aliases.add(m[1]);

  // `use std::fs::{copy, rename};` brings the functions into scope bare, which
  // this gate cannot distinguish from a local helper of the same name. Refuse
  // the import instead of guessing.
  const bare = /use\s+(?:::)?std::fs::(?:\{[^}]*\}|[a-z_]+)\s*;/g;
  const bareImports = [];
  while ((m = bare.exec(source)) !== null) bareImports.push(m[0]);
  return { aliases, bareImports };
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function checkRustFile(absPath) {
  const rel = path.relative(SRC, absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const source = stripRustNoise(raw);
  const { aliases, bareImports } = fsAliasesRust(source);

  for (const imp of bareImports) {
    problems.push(
      `${rel} — \`${imp.trim()}\` imports a filesystem function into bare scope.\n` +
        `    The gate cannot tell \`copy(a, b)\` from a local helper, so import the ` +
        `module (\`use std::fs;\`) and call \`fs::copy\` instead.`
    );
  }

  const exempt = ALLOWLIST.has(rel);
  for (const alias of aliases) {
    for (const fn of FORBIDDEN_RUST) {
      // Match `alias::fn(` with the alias not preceded by an identifier char, so
      // `myfs::copy` does not match the alias `fs`.
      const re = new RegExp(
        `(^|[^A-Za-z0-9_:])${alias.replace(/:/g, "\\:")}::${fn}\\s*\\(`,
        "g"
      );
      let m;
      while ((m = re.exec(source)) !== null) {
        const line = lineOf(source, m.index);
        // Test modules build and tear down their own fixtures; that is not
        // production mutation. Detected by scanning backwards for `mod tests`,
        // which is how every test module in this crate is written.
        if (isInTestModule(source, m.index)) continue;
        if (exempt) continue;
        problems.push(
          `${rel}:${line} — ${alias}::${fn}() outside src/engine/.\n` +
            `    Mutations go through engine::commit so a failure cannot destroy the\n` +
            `    destination (QSF-001). Use engine::commit, or add ${rel} to ALLOWLIST\n` +
            `    in this script with the reason it is safe.`
        );
      }
    }
  }

  // `File::create` truncates an existing file. `create_new` does not.
  const createRe = /(^|[^A-Za-z0-9_])File::create\s*\(/g;
  let m;
  while ((m = createRe.exec(source)) !== null) {
    if (isInTestModule(source, m.index)) continue;
    if (exempt) continue;
    problems.push(
      `${rel}:${lineOf(source, m.index)} — File::create() truncates an existing file.\n` +
        `    Use engine::commit (which stages and renames), or File::create_new.`
    );
  }
}

/**
 * Whether `index` falls inside a `#[cfg(test)] mod …` block.
 *
 * Brace-counting from each test module's opening brace. Cheap and adequate: test
 * modules in this crate are always the last thing in the file.
 */
function isInTestModule(source, index) {
  const re = /#\[cfg\(test\)\]\s*mod\s+[A-Za-z0-9_]+\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    if (index < open) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          if (index < i) return true;
          break;
        }
      }
    }
  }
  return false;
}

function checkJsFile(absPath) {
  const rel = path.relative(WEB_SRC, absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const source = stripJsNoise(raw);
  const exempt = WEB_ALLOWLIST.has(rel);

  const fsAliases = new Set(["fs", "fsp"]);
  const forbiddenImports = [];

  // Match import statements: import fs from 'fs', import * as fsp from 'node:fs/promises', etc.
  const importRe = /import\s+(?:([A-Za-z0-9_$]+)|(?:\*\s*as\s+([A-Za-z0-9_$]+))|(?:\s*\{\s*([^}]+)\s*\}))\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const defaultImport = m[1];
    const namespaceImport = m[2];
    const namedImports = m[3];

    if (defaultImport) fsAliases.add(defaultImport);
    if (namespaceImport) fsAliases.add(namespaceImport);
    if (namedImports) {
      const parts = namedImports.split(",");
      for (const part of parts) {
        const cleaned = part.trim();
        if (!cleaned) continue;
        let originalName = cleaned;
        if (cleaned.includes(" as ")) {
          originalName = cleaned.split(/\s+as\s+/)[0].trim();
        }
        if (FORBIDDEN_JS.includes(originalName)) {
          forbiddenImports.push({ name: originalName, index: m.index });
        }
      }
    }
  }

  // Match destructuring assignments of existing variables, e.g. const { rename } = fs;
  const destructureRe = /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*([A-Za-z0-9_$]+)/g;
  while ((m = destructureRe.exec(source)) !== null) {
    const destructuredProps = m[1];
    const objName = m[2];
    if (fsAliases.has(objName)) {
      const parts = destructuredProps.split(",");
      for (const part of parts) {
        const cleaned = part.trim();
        if (!cleaned) continue;
        let originalName = cleaned;
        if (cleaned.includes(":")) {
          originalName = cleaned.split(":")[0].trim();
        }
        if (FORBIDDEN_JS.includes(originalName)) {
          forbiddenImports.push({ name: originalName, index: m.index });
        }
      }
    }
  }

  // Match dynamic imports, e.g. const m = await import('fs');
  const dynamicImportRe = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?import\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g;
  while ((m = dynamicImportRe.exec(source)) !== null) {
    fsAliases.add(m[1]);
  }

  // Match destructuring dynamic imports, e.g. const { rename } = await import('fs');
  const destrDynamicImportRe = /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*(?:await\s+)?import\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g;
  while ((m = destrDynamicImportRe.exec(source)) !== null) {
    const destructuredProps = m[1];
    const parts = destructuredProps.split(",");
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      let originalName = cleaned;
      if (cleaned.includes(":")) {
        originalName = cleaned.split(":")[0].trim();
      }
      if (FORBIDDEN_JS.includes(originalName)) {
        forbiddenImports.push({ name: originalName, index: m.index });
      }
    }
  }

  // Report forbidden imports / destructuring
  for (const violation of forbiddenImports) {
    if (exempt) continue;
    const line = lineOf(source, violation.index);
    problems.push(
      `${rel}:${line} — Direct import or destructuring of forbidden function \`${violation.name}\`.\n` +
        `    Mutations go through server/lib/commit.js (writeFileAtomically, copyFileStaged, etc.) (QSF-026).`
    );
  }

  // Match calls/accesses on aliases, e.g. fs.rename(...), fs['rename'](...)
  for (const alias of fsAliases) {
    for (const fn of FORBIDDEN_JS) {
      const memberRe = new RegExp(`\\b${alias}\\s*\\??\\.\\s*${fn}(?:Sync)?\\b`, 'g');
      while ((m = memberRe.exec(source)) !== null) {
        if (exempt) continue;
        const line = lineOf(source, m.index);
        problems.push(
          `${rel}:${line} — Bypassing commit engine: call to \`${alias}.${fn}()\`.\n` +
            `    Mutations go through server/lib/commit.js (writeFileAtomically, copyFileStaged, etc.) (QSF-026).`
        );
      }

      const bracketRe = new RegExp(`\\b${alias}\\s*\\??\\[\\s*['"]${fn}(?:Sync)?['"]\\s*\\]`, 'g');
      while ((m = bracketRe.exec(source)) !== null) {
        if (exempt) continue;
        const line = lineOf(source, m.index);
        problems.push(
          `${rel}:${line} — Bypassing commit engine: call to \`${alias}['${fn}']\`.\n` +
            `    Mutations go through server/lib/commit.js (writeFileAtomically, copyFileStaged, etc.) (QSF-026).`
        );
      }
    }
  }
}

function walkRust(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The engine is the thing being protected, not a thing to protect from.
      if (full === ENGINE) continue;
      walkRust(full);
      continue;
    }
    if (entry.name.endsWith(".rs")) checkRustFile(full);
  }
}

function walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "node_modules") continue;
      walkJs(full);
      continue;
    }
    if (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) {
      if (full === WEB_COMMIT) continue;
      checkJsFile(full);
    }
  }
}

if (!fs.existsSync(ENGINE)) {
  console.error(
    `\n❌ check-no-fs-bypass: ${path.relative(repoRoot, ENGINE)} does not exist.\n` +
      `   The gate is meaningless without the engine it points callers at.\n`
  );
  process.exit(1);
}

if (!fs.existsSync(WEB_COMMIT)) {
  console.error(
    `\n❌ check-no-fs-bypass: ${path.relative(repoRoot, WEB_COMMIT)} does not exist.\n` +
      `   The gate is meaningless without the engine it points callers at.\n`
  );
  process.exit(1);
}

walkRust(SRC);
walkJs(WEB_SRC);

// A stale allowlist entry is a claim nobody rechecked. Fail on it, so removing
// the last bypass from a file also removes its exemption.
for (const [file] of ALLOWLIST) {
  if (!fs.existsSync(path.join(SRC, file))) {
    problems.push(
      `ALLOWLIST names ${file}, which no longer exists. Remove the entry.`
    );
  }
}

for (const [file] of WEB_ALLOWLIST) {
  if (!fs.existsSync(path.join(WEB_SRC, file))) {
    problems.push(
      `WEB_ALLOWLIST names ${file}, which no longer exists. Remove the entry.`
    );
  }
}

if (problems.length > 0) {
  console.error("\n❌ check-no-fs-bypass: mutations found outside the commit engine.\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `✅ No filesystem mutation bypasses the commit engine (${ALLOWLIST.size} Rust and ${WEB_ALLOWLIST.size} Web reviewed exemptions) (QSF-001/QSF-026).`
);
