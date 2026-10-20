#!/usr/bin/env node
/**
 * P1.1 — IPC command-set parity between the desktop frontend and the Tauri backend.
 *
 * `apps/desktop/CLAUDE.md` has said "Nothing enforces this yet, so a mismatch
 * only fails at runtime" since the repository was created, and QSF-008 is what
 * that costs: six commands were invoked for months with no `generate_handler!`
 * entry, every call failing with "command not found". Fase 0 closed that by
 * editing the contract — a fix, not a gate. This is the gate.
 *
 * Checked in both directions:
 *   1. every `invoke("x")` in apps/desktop/src/lib/ipc.ts has an `x` in
 *      `generate_handler!` (the QSF-008 direction — these fail at runtime);
 *   2. every command in `generate_handler!` is reachable from ipc.ts (dead
 *      backend surface: code that still compiles, still ships, and is no
 *      longer exercised by anything).
 *
 * An `invoke` call whose command name is not a plain string literal is a hard
 * error rather than a skip. A gate that quietly ignores what it cannot parse is
 * the failure mode `check-no-plugin-loader.js` shipped with on its first
 * version: its regex excluded backticks, so a template-literal plugin path
 * never matched and the check passed against a real loader.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_RS = path.join(ROOT, "apps/desktop/src-tauri/src/lib.rs");
const IPC_TS = path.join(ROOT, "apps/desktop/src/lib/ipc.ts");

/**
 * Commands allowed to be registered in the backend without a call from ipc.ts.
 * Each entry needs a reason; an unexplained entry is how a gate rots into a
 * list of things nobody dares delete.
 */
const BACKEND_ONLY = new Map([
  // (none today — kept so the shape is obvious when one is needed)
]);

/**
 * Commands allowed to be invoked from ipc.ts without a backend handler.
 * This must stay empty: an entry here is a call that fails at runtime.
 */
const FRONTEND_ONLY = new Map([
  // (none today — QSF-008's six were removed from the desktop adapter in 245057f)
]);

/** Remove `//` line comments and block comments without touching string bodies. */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Copy string and template literals through verbatim so a `//` inside one
    // does not eat the rest of the line.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Command names registered in `generate_handler![…]`. */
function readRegisteredCommands() {
  const src = fs.readFileSync(LIB_RS, "utf8");
  const start = src.indexOf("generate_handler![");
  if (start === -1) {
    fail(`No generate_handler! found in ${rel(LIB_RS)} — the gate cannot verify anything.`);
  }

  // Walk to the matching bracket rather than regexing to it: the list spans
  // ~60 lines and contains comments.
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("[", start); i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) fail(`Unterminated generate_handler! list in ${rel(LIB_RS)}.`);

  const body = stripComments(src.slice(src.indexOf("[", start) + 1, end));
  const commands = new Map();
  for (const raw of body.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    // `vfs::get_drives` and `get_drives` both register the command `get_drives`.
    const name = entry.split("::").pop().trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      fail(
        `Cannot parse generate_handler! entry ${JSON.stringify(entry)} in ${rel(LIB_RS)}.\n` +
          `The gate refuses to guess: either the entry is malformed or this script needs updating.`
      );
    }
    commands.set(name, entry);
  }
  return commands;
}

/**
 * Command names passed to `invoke(...)` in ipc.ts.
 *
 * Returns `{ names, dynamic }`; `dynamic` collects calls whose first argument
 * is not a string literal, which the caller treats as a hard failure.
 */
function readInvokedCommands() {
  const raw = fs.readFileSync(IPC_TS, "utf8");
  const src = stripComments(raw);
  const names = new Map();
  const dynamic = [];

  // Matches `invoke(`, `invoke<T>(`, `invoke <T> (`. The leading class rejects
  // `someInvoke(` and `client.invoke(` — a member call is a different function.
  const callRe = /(^|[^A-Za-z0-9_$.])invoke\s*(<[^(]*>)?\s*\(/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const argStart = callRe.lastIndex;
    const rest = src.slice(argStart).replace(/^\s*/, "");
    const quote = rest[0];

    if (quote === '"' || quote === "'") {
      const closing = rest.indexOf(quote, 1);
      if (closing === -1) {
        dynamic.push({ line: lineOf(src, argStart), snippet: rest.slice(0, 40) });
        continue;
      }
      const name = rest.slice(1, closing);
      names.set(name, lineOf(src, argStart));
      continue;
    }

    // Backticks land here on purpose. A template literal may be constant today
    // and interpolated tomorrow, and the gate must not be the thing that failed
    // to notice.
    dynamic.push({ line: lineOf(src, argStart), snippet: rest.slice(0, 40).split("\n")[0] });
  }

  if (names.size === 0) {
    fail(
      `No invoke("…") calls found in ${rel(IPC_TS)}.\n` +
        `That is almost certainly a broken matcher rather than an empty adapter.`
    );
  }
  return { names, dynamic };
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function rel(p) {
  return path.relative(ROOT, p);
}

const problems = [];
function fail(message) {
  console.error(`\n❌ check-ipc-parity: ${message}\n`);
  process.exit(1);
}

// ===== run =====

const registered = readRegisteredCommands();
const { names: invoked, dynamic } = readInvokedCommands();

for (const d of dynamic) {
  problems.push(
    `${rel(IPC_TS)}:${d.line} — invoke() called with a non-literal command name: ${d.snippet}…\n` +
      `    The parity gate cannot check a name it cannot read. Use a string literal.`
  );
}

for (const [name, line] of invoked) {
  if (registered.has(name)) continue;
  if (FRONTEND_ONLY.has(name)) continue;
  problems.push(
    `${rel(IPC_TS)}:${line} — invoke("${name}") has no handler in generate_handler!.\n` +
      `    This is QSF-008: it compiles, ships, and fails at runtime with "command not found".\n` +
      `    Implement the command in src-tauri, or remove the call.`
  );
}

for (const [name, entry] of registered) {
  if (invoked.has(name)) continue;
  if (BACKEND_ONLY.has(name)) continue;
  problems.push(
    `${rel(LIB_RS)} — command "${entry}" is registered but never invoked from ${rel(IPC_TS)}.\n` +
      `    Dead backend surface still compiles and still ships. Remove it, or add it to\n` +
      `    BACKEND_ONLY in this script with the reason it stays.`
  );
}

if (problems.length > 0) {
  console.error("\n❌ check-ipc-parity: desktop IPC command sets do not match.\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `✅ Desktop IPC command sets match (${registered.size} commands, both directions) (QSF-008).`
);
