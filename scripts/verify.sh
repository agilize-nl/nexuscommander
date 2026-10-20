#!/usr/bin/env bash
# QSF plan P0.4 — the full gate set, runnable locally.
#
# The monorepo has no configured git remote, and the two GitHub workflows only
# build. Until a CI substrate is chosen (section 2 of the QSF plan: GitHub with
# Forgejo as a mirror, or Forgejo Actions with self-hosted Windows/macOS
# runners), this script plus the pre-push hook is where the gates actually run.
# When CI does arrive it should invoke this, not restate it.
#
# Every gate runs even if an earlier one fails, so one push tells you
# everything that is wrong rather than only the first thing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$REPO_ROOT/apps/desktop/src-tauri"
cd "$REPO_ROOT"

failed=()
skipped=()

run() { # run <label> <command...>
  # Capture the label before shifting it away, or the failure summary names the
  # first word of the command instead of the gate ("cargo, cargo").
  local label="$1"
  printf '\n\033[1m── %s\033[0m\n' "$label"
  shift
  if "$@"; then
    printf '\033[32m   pass\033[0m\n'
  else
    printf '\033[31m   FAIL\033[0m\n'
    failed+=("$label")
  fi
}

# cargo-audit is a separate binary and is not always installed. Skipping it
# loudly is honest; silently passing would make the gate a lie.
have() { command -v "$1" >/dev/null 2>&1; }

run "typecheck, locales and static checks (npm run check)" \
  npm run --silent check

run "UI action regressions (npm run test:ui)" \
  npm run --silent test:ui

run "build both apps" \
  npm run --silent build

run "web backend characterization suite (npm test -w apps/web)" \
  npm run --silent test -w apps/web

run "rust formatting (cargo fmt --check)" \
  cargo fmt --manifest-path "$TAURI_DIR/Cargo.toml" --check

run "rust lints (cargo clippy -D warnings)" \
  cargo clippy --manifest-path "$TAURI_DIR/Cargo.toml" --all-targets --quiet -- -D warnings

run "rust tests" \
  cargo test --manifest-path "$TAURI_DIR/Cargo.toml" --quiet

run "npm audit" \
  npm audit --audit-level=high

if have cargo-audit || cargo audit --version >/dev/null 2>&1; then
  run "cargo audit" \
    cargo audit --file "$TAURI_DIR/Cargo.lock"
else
  printf '\n\033[1m── cargo audit\033[0m\n\033[33m   SKIPPED (cargo-audit not installed: cargo install cargo-audit)\033[0m\n'
  skipped+=("cargo audit")
fi

# A cross-compile check is a compile gate only — it is not platform
# qualification. Windows path semantics and process launching still need
# Windows-native tests (QSF-018, P4.1).
if have x86_64-w64-mingw32-gcc; then
  run "windows cross-compile check" \
    cargo check --manifest-path "$TAURI_DIR/Cargo.toml" --target x86_64-pc-windows-gnu --quiet
else
  printf '\n\033[1m── windows cross-compile check\033[0m\n\033[33m   SKIPPED (install gcc-mingw-w64-x86-64)\033[0m\n'
  skipped+=("windows cross-compile check")
fi

printf '\n────────────────────────────────────────\n'

if [ ${#skipped[@]} -gt 0 ]; then
  printf '\033[33mSkipped: %s\033[0m\n' "$(printf '%s; ' "${skipped[@]}")"
fi

if [ ${#failed[@]} -gt 0 ]; then
  printf '\033[31mFAILED: %s\033[0m\n' "$(printf '%s; ' "${failed[@]}")"
  exit 1
fi

printf '\033[32mAll gates passed.\033[0m\n'
