#!/bin/bash
# scripts/bump-version.sh
set -euo pipefail

if [ -z "$1" ]; then
  echo "Usage: ./scripts/bump-version.sh <new_version>"
  exit 1
fi

NEW_VERSION=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Bumping version to $NEW_VERSION..."

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Version must look like 1.2.3, optionally with a prerelease/build suffix."
  exit 1
fi

# 1. Update npm metadata without creating a git commit or tag.
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null

# 2. Update app-facing version strings and optional agent metadata.
node - "$ROOT_DIR" "$NEW_VERSION" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.argv[2];
const newVersion = process.argv[3];

function updateText(relativePath, replacements) {
  const filePath = path.join(rootDir, relativePath);
  let text = fs.readFileSync(filePath, 'utf8');

  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(text)) {
      throw new Error(`Pattern ${pattern} not found in ${relativePath}`);
    }
    text = text.replace(pattern, replacement);
  }

  fs.writeFileSync(filePath, text);
}

updateText('src/lib/components/AboutDialog.svelte', [
  [/let version = \$state\("[^"]+"\);/, `let version = $state("${newVersion}");`]
]);

const serverIndexPath = path.join(rootDir, 'server/index.js');
const serverIndex = fs.readFileSync(serverIndexPath, 'utf8');
if (/version: '[^']+-pwa'/.test(serverIndex)) {
  updateText('server/index.js', [
    [/version: '[^']+-pwa'/, `version: '${newVersion}-pwa'`]
  ]);
} else if (!/const\s+\{\s*version\s*\}\s*=\s*JSON\.parse/.test(serverIndex)) {
  throw new Error('No supported version pattern found in server/index.js');
}

updateText('static/sw.js', [
  [/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = 'v${newVersion}';`]
]);

const agentPath = path.join(rootDir, '.agent/app_description.json');
if (fs.existsSync(agentPath)) {
  const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
  agent.status = `v${newVersion}-PWA - Full feature parity with former desktop version achieved in a web-native environment.`;
  fs.writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`);
}
NODE

echo "Version successfully bumped to $NEW_VERSION in mandatory files."
echo "Note: The web app will reflect this version upon the next build/refresh."
