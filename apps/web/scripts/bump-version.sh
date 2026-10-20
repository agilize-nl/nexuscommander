#!/bin/bash
# scripts/bump-version.sh — delegates to the monorepo bump.
#
# This used to bump apps/web alone. The monorepo has one version across both
# shells (`npm run check:static` enforces it), so every web release left the
# repo failing its own version gate: v0.9.16 bumped apps/web while the desktop
# app, packages/ui and the root stayed on 0.9.15.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../../desktop/scripts/bump-version.sh" "$@"
