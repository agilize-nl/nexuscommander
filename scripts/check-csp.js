// QSF-014 / P0.8 — the desktop CSP must not weaken.
//
// assetProtocol.scope is deliberately ["**"] (see docs/BACKENDS_EN_SECURITY.md):
// audio preview, open-with icons and the image viewer all need arbitrary paths
// through convertFileSrc, and the IPC surface already grants equally broad
// filesystem read access. Narrowing the asset scope would move a boundary that
// is not the real boundary.
//
// That makes the CSP the meaningful control rather than a defence in depth, so
// it needs a gate. This check asserts the directives that carry the weight; it
// deliberately does not pin the whole string, or every legitimate CSP edit
// would fail.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const confPath = "apps/desktop/src-tauri/tauri.conf.json";

const conf = JSON.parse(fs.readFileSync(path.join(repoRoot, confPath), "utf8"));
const csp = conf.app?.security?.csp;

const problems = [];

if (typeof csp !== "string" || csp.trim() === "") {
  problems.push(
    "No CSP is configured. An unrestricted webview is the single largest " +
      "escalation path in this app, because the IPC surface is broad."
  );
} else {
  /** Read one directive's value out of the policy. */
  const directive = (name) => {
    const match = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`));
    return match ? match[1].trim() : null;
  };

  const required = {
    // Script execution is the whole game: with unsafe-inline or unsafe-eval an
    // injected string becomes code with the full native command surface behind it.
    "script-src": {
      value: "'self'",
      reason: "any relaxation makes injected markup executable",
    },
    // {@html} still exists in ContextMenu/HelpDialog (QSF-013), so plugin and
    // object embedding must stay closed until that is removed.
    "object-src": {
      value: "'none'",
      reason: "blocks plugin/object embedding while {@html} is still in use",
    },
    "base-uri": {
      value: "'self'",
      reason: "stops a base tag from re-pointing every relative URL",
    },
    "frame-ancestors": {
      value: "'none'",
      reason: "the app window must never be embedded",
    },
    "default-src": {
      value: "'self'",
      reason: "everything not named explicitly must fall back to same-origin",
    },
  };

  for (const [name, { value, reason }] of Object.entries(required)) {
    const actual = directive(name);
    if (actual === null) {
      problems.push(`${name} is missing — ${reason}`);
    } else if (actual !== value) {
      problems.push(`${name} must be exactly "${value}", found "${actual}" — ${reason}`);
    }
  }

  // Belt and braces: catch these anywhere in the policy, including in a
  // directive this check does not model yet.
  for (const forbidden of ["unsafe-eval", "unsafe-hashes"]) {
    if (csp.includes(forbidden)) {
      problems.push(`'${forbidden}' must not appear anywhere in the CSP`);
    }
  }

  // 'unsafe-inline' is accepted in style-src only — Svelte emits scoped inline
  // styles — and must not spread to any other directive.
  for (const part of csp.split(";")) {
    if (part.includes("unsafe-inline") && !/^\s*style-src\b/.test(part)) {
      problems.push(
        `'unsafe-inline' is only permitted in style-src, found in "${part.trim()}"`
      );
    }
  }
}

// The broad asset scope is an accepted risk, but it must stay a documented one.
const RISK_DOC = "docs/archive/BACKENDS_EN_SECURITY.md";
const scope = conf.app?.security?.assetProtocol?.scope;
if (Array.isArray(scope) && scope.includes("**")) {
  const doc = path.join(repoRoot, RISK_DOC);
  // A *missing* doc and a doc that no longer mentions the risk fail for very
  // different reasons: the first means this constant is stale (it was
  // `docs/BACKENDS_EN_SECURITY.md` for a while after the doc moved into
  // docs/archive/, so the gate was red for a reason that had nothing to do
  // with the CSP). Say which one it is, or the next move costs the same hour.
  if (!fs.existsSync(doc)) {
    problems.push(
      `RISK_DOC points at ${RISK_DOC}, which does not exist. The risk may well ` +
        "be documented — update this path in scripts/check-csp.js."
    );
  } else if (!fs.readFileSync(doc, "utf8").includes("assetProtocol")) {
    problems.push(
      `assetProtocol.scope is ["**"] but ${RISK_DOC} does not record the ` +
        "accepted risk. A broad scope is allowed; an undocumented one is not."
    );
  }
}

if (problems.length > 0) {
  console.error(`❌ CSP regression in ${confPath}:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nSee ${RISK_DOC} for why the CSP is the control here.`);
  process.exit(1);
}

console.log("✅ CSP directives intact; broad asset scope is documented (QSF-014).");
