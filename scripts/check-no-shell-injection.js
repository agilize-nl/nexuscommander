// QSF-006 / P0.2 — no user-derived string may reach a command processor.
//
// Spawning a shell with an argument array does NOT make it safe. Rust's
// Command applies MSVCRT quoting when it builds the command line, but the
// process being started is cmd.exe, which then re-tokenises that line using
// its own grammar (`&`, `|`, `^`, `<`, `>`, `%VAR%`). The same applies to
// `sh -c` on Unix. Safety comes from not spawning a shell at all, so this
// check flags any non-literal argument handed to one.
//
// Literal arguments are fine: `cmd /C start cmd` carries no user data.
// The Windows-native integration test this finding also asks for cannot run
// here (no Windows runner is configured); this static gate is the part that
// can be enforced today, and P4.1 owns the rest.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOT = "apps/desktop/src-tauri/src";

const SHELLS = new Set([
  "cmd",
  "cmd.exe",
  "sh",
  "bash",
  "zsh",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

/** Every .rs file under a directory. */
function rustFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(full, found);
    else if (entry.name.endsWith(".rs")) found.push(full);
  }
  return found;
}

/** A Rust string literal, possibly raw: "x" or r"x" or r#"x"#. */
const STRING_LITERAL = /^\s*(?:r#*)?"(?:[^"\\]|\\.)*"#*\s*$/;

const findings = [];

for (const file of rustFiles(path.join(repoRoot, SEARCH_ROOT))) {
  const source = fs.readFileSync(file, "utf8");

  // Locate each shell spawn, then inspect the builder chain that follows it up
  // to the statement terminator.
  const spawnPattern = /Command::new\(\s*"([^"]+)"\s*\)/g;
  let spawn;
  while ((spawn = spawnPattern.exec(source)) !== null) {
    const program = spawn[1];
    if (!SHELLS.has(program)) continue;

    const chainEnd = source.indexOf(";", spawn.index);
    const chain = source.slice(spawn.index, chainEnd === -1 ? source.length : chainEnd);
    const line = source.slice(0, spawn.index).split("\n").length;

    // .arg(x) / .raw_arg(x) — one argument each.
    const argPattern = /\.(?:raw_)?arg\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let arg;
    while ((arg = argPattern.exec(chain)) !== null) {
      if (!STRING_LITERAL.test(arg[1])) {
        findings.push({
          file: path.relative(repoRoot, file),
          line: line + chain.slice(0, arg.index).split("\n").length - 1,
          program,
          expr: arg[1].trim(),
        });
      }
    }

    // .args([...]) — every element must be a literal.
    const argsPattern = /\.args\(\s*\[([^\]]*)\]\s*\)/g;
    let args;
    while ((args = argsPattern.exec(chain)) !== null) {
      for (const element of args[1].split(",")) {
        if (element.trim() === "") continue;
        if (!STRING_LITERAL.test(element)) {
          findings.push({
            file: path.relative(repoRoot, file),
            line: line + chain.slice(0, args.index).split("\n").length - 1,
            program,
            expr: element.trim(),
          });
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error("❌ A non-literal argument reaches a command shell (QSF-006).\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} — Command::new("${f.program}") receives ${f.expr}`);
  }
  console.error(
    "\nAn argument array does not neutralise this: the spawned process is the\n" +
      "shell, and it re-parses the reconstructed command line itself. Use\n" +
      "tauri_plugin_opener::open_path (ShellExecuteExW on Windows) or spawn the\n" +
      "target executable directly."
  );
  process.exit(1);
}

console.log("✅ No user-derived string reaches a command shell (QSF-006).");
