// QSF-020 / P0.5 — every version and licence declaration must agree.
//
// Two separate defects motivated this gate:
//
//   * The app title sat on v0.8.29 for five releases because the bump script
//     did not know about that site. apps/web/static/sw.js was likewise stuck on
//     v0.8.28. A version site nobody validates silently drifts.
//   * package.json declared MIT while apps/desktop/LICENSE was the GPL-3.0
//     text. Shipping a package whose metadata contradicts its bundled licence
//     text is a real distribution defect, not hygiene.
//
// Adding a new site to a bump script is easy to forget; failing the build is
// not. Every declaration below is read back and compared against the root
// package.json version and the declared licence.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const rootPkg = readJson("package.json");
const EXPECTED_VERSION = rootPkg.version;
const EXPECTED_LICENSE = rootPkg.license;

const problems = [];

/** Compare one declaration against the expected value. */
function expect(label, actual, expected) {
  if (actual !== expected) {
    problems.push(`${label}: expected '${expected}', found '${actual}'`);
  }
}

// --- Versions -------------------------------------------------------------
for (const pkg of [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/ui/package.json",
]) {
  expect(`${pkg} version`, readJson(pkg).version, EXPECTED_VERSION);
}

const tauriConf = readJson("apps/desktop/src-tauri/tauri.conf.json");
expect("tauri.conf.json version", tauriConf.version, EXPECTED_VERSION);
expect(
  "tauri.conf.json window title",
  tauriConf.app.windows[0].title,
  `Nexus Commander - v${EXPECTED_VERSION}`
);

const cargoVersion = read("apps/desktop/src-tauri/Cargo.toml").match(
  /^version = "([^"]+)"/m
);
expect("Cargo.toml version", cargoVersion?.[1], EXPECTED_VERSION);

// The service worker's cache key doubles as a user-visible version: a stale one
// serves the previous build's assets after an upgrade.
const swVersion = read("apps/web/static/sw.js").match(
  /const CACHE_VERSION = '([^']+)'/
);
expect("apps/web/static/sw.js CACHE_VERSION", swVersion?.[1], `v${EXPECTED_VERSION}`);

// app.html must carry no version at all — the window title is the only source.
if (/<title>[^<]*v[0-9]+\.[0-9]+/.test(read("apps/desktop/src/app.html"))) {
  problems.push(
    "apps/desktop/src/app.html reintroduced a hardcoded version in <title>; " +
      "the tauri.conf.json window title is the only source."
  );
}

// --- Licences -------------------------------------------------------------
for (const pkg of [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
]) {
  expect(`${pkg} license`, readJson(pkg).license, EXPECTED_LICENSE);
}

const cargoLicense = read("apps/desktop/src-tauri/Cargo.toml").match(
  /^license = "([^"]+)"/m
);
expect("Cargo.toml license", cargoLicense?.[1], EXPECTED_LICENSE);

// A LICENSE file must exist everywhere a package is published from, and its
// text must actually be the licence the metadata claims.
const LICENSE_MARKERS = {
  MIT: "MIT License",
  "GPL-3.0": "GNU GENERAL PUBLIC LICENSE",
  "GPL-3.0-only": "GNU GENERAL PUBLIC LICENSE",
};

for (const rel of ["LICENSE", "apps/desktop/LICENSE", "apps/web/LICENSE"]) {
  if (!fs.existsSync(path.join(repoRoot, rel))) {
    problems.push(`${rel} is missing`);
    continue;
  }
  const marker = LICENSE_MARKERS[EXPECTED_LICENSE];
  if (!marker) {
    problems.push(
      `No licence-text marker known for '${EXPECTED_LICENSE}'; add one to check-versions.js.`
    );
    break;
  }
  if (!read(rel).includes(marker)) {
    problems.push(
      `${rel} does not contain '${marker}', but package metadata declares ${EXPECTED_LICENSE}`
    );
  }
}

// --- Report ---------------------------------------------------------------
if (problems.length > 0) {
  console.error(
    `❌ Version/licence declarations disagree (expected v${EXPECTED_VERSION}, ${EXPECTED_LICENSE}):\n`
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `✅ All version and licence declarations agree (v${EXPECTED_VERSION}, ${EXPECTED_LICENSE}).`
);
