#!/bin/bash
# apps/desktop/scripts/bump-version.sh
#
# Bump the release version for the whole NexusCommander monorepo. Keeping this
# in the desktop shell preserves the established release command, but every
# shared/UI/web declaration is updated too: the two shells ship together.

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./scripts/bump-version.sh <new_version>" >&2
  exit 1
fi

NEW_VERSION=$1

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "❌ '$NEW_VERSION' is not a semver version." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

echo "Bumping monorepo version to $NEW_VERSION..."

node - "$REPO_ROOT" "$NEW_VERSION" <<'NODE'
const fs = require("fs");
const path = require("path");

const [repoRoot, version] = process.argv.slice(2);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function write(relativePath, value) {
  fs.writeFileSync(path.join(repoRoot, relativePath), value);
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function writeJson(relativePath, value) {
  write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceOne(relativePath, pattern, replacement) {
  const before = read(relativePath);
  // Test for the declaration, not for a change: a site that already carries
  // the target version (a re-run, or a partial earlier bump) is fine.
  if (!pattern.test(before)) {
    throw new Error(`Expected version declaration not found in ${relativePath}`);
  }
  write(relativePath, before.replace(pattern, replacement));
}

for (const relativePath of [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/ui/package.json",
]) {
  const manifest = readJson(relativePath);
  manifest.version = version;
  writeJson(relativePath, manifest);
}

const rootLock = readJson("package-lock.json");
rootLock.version = version;
for (const packagePath of ["", "apps/desktop", "apps/web", "packages/ui"]) {
  if (!rootLock.packages?.[packagePath]) {
    throw new Error(`Missing ${packagePath || "root"} workspace entry in package-lock.json`);
  }
  rootLock.packages[packagePath].version = version;
}
writeJson("package-lock.json", rootLock);

const tauri = readJson("apps/desktop/src-tauri/tauri.conf.json");
if (!tauri.app?.windows?.[0]) {
  throw new Error("Missing primary window in apps/desktop/src-tauri/tauri.conf.json");
}
tauri.version = version;
tauri.app.windows[0].title = `Nexus Commander - v${version}`;
writeJson("apps/desktop/src-tauri/tauri.conf.json", tauri);

replaceOne(
  "apps/desktop/src-tauri/Cargo.toml",
  /^version = "[^"]+"/m,
  `version = "${version}"`,
);
replaceOne(
  "apps/desktop/src-tauri/Cargo.lock",
  /^(name = "nexuscommander"\nversion = ")[^"]+(")/m,
  `$1${version}$2`,
);
replaceOne(
  "apps/web/static/sw.js",
  /const CACHE_VERSION = '[^']+';/,
  `const CACHE_VERSION = 'v${version}';`,
);

const webAgent = readJson("apps/web/.agent/app_description.json");
webAgent.status = `v${version}-PWA - Full feature parity with former desktop version achieved in a web-native environment.`;
writeJson("apps/web/.agent/app_description.json", webAgent);

for (const relativePath of [
  "docs/LINUX_INSTALL.md",
  "apps/desktop/docs/LINUX_INSTALL.md",
]) {
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    replaceOne(relativePath, /- Projectversie: `[^`]*`/, `- Projectversie: \`${version}\``);
  }
}
NODE

node - "$REPO_ROOT" "$NEW_VERSION" <<'NODE'
const fs = require("fs");
const path = require("path");

const [repoRoot, version] = process.argv.slice(2);
const problems = [];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function expect(label, actual, expected = version) {
  if (actual !== expected) problems.push(`${label}: expected '${expected}', found '${actual}'`);
}

for (const relativePath of [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/ui/package.json",
]) {
  expect(relativePath, json(relativePath).version);
}

const rootLock = json("package-lock.json");
expect("package-lock.json root", rootLock.version);
for (const packagePath of ["", "apps/desktop", "apps/web", "packages/ui"]) {
  expect(`package-lock.json ${packagePath || "root"}`, rootLock.packages?.[packagePath]?.version);
}

const tauri = json("apps/desktop/src-tauri/tauri.conf.json");
expect("tauri.conf.json version", tauri.version);
expect("tauri.conf.json window title", tauri.app?.windows?.[0]?.title, `Nexus Commander - v${version}`);

expect(
  "Cargo.toml",
  read("apps/desktop/src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1],
);
expect(
  "Cargo.lock",
  read("apps/desktop/src-tauri/Cargo.lock").match(/name = "nexuscommander"\nversion = "([^"]+)"/)?.[1],
);
expect(
  "service worker cache",
  read("apps/web/static/sw.js").match(/const CACHE_VERSION = '([^']+)'/)?.[1],
  `v${version}`,
);
expect(
  "web agent status",
  json("apps/web/.agent/app_description.json").status,
  `v${version}-PWA - Full feature parity with former desktop version achieved in a web-native environment.`,
);

for (const relativePath of [
  "docs/LINUX_INSTALL.md",
  "apps/desktop/docs/LINUX_INSTALL.md",
]) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (fs.existsSync(absolutePath)) {
    expect(
      relativePath,
      read(relativePath).match(/- Projectversie: `([^`]*)`/)?.[1],
    );
  }
}

if (/<title>[^<]*v[0-9]+\.[0-9]+/.test(read("apps/desktop/src/app.html"))) {
  problems.push("apps/desktop/src/app.html reintroduced a hardcoded version");
}

if (problems.length > 0) {
  console.error("❌ Version bump incomplete:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✅ Version ${version} applied and verified across the monorepo.`);
NODE
