#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve("src/app.css");
const themePath = resolve("src/lib/theme.ts");

const css = readFileSync(cssPath, "utf8");
const themeSource = readFileSync(themePath, "utf8");

const themeArrayMatch = themeSource.match(/export const themes:[\s\S]*?=\s*\[([\s\S]*?)\];/);
if (!themeArrayMatch) {
  throw new Error("Could not find the exported themes array in src/lib/theme.ts");
}

const themeOrder = [...themeArrayMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

function toTokenName(cssVariableName) {
  return cssVariableName
    .replace(/^--/, "")
    .split("-")
    .join(".");
}

function parseThemeBlocks(source) {
  const blocks = new Map();
  const rootMatch = source.match(/:root,\s*\n\[data-theme="midnight"\]\s*\{([\s\S]*?)\n\}/);
  if (rootMatch) {
    blocks.set("midnight", rootMatch[1]);
  }

  for (const match of source.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    blocks.set(match[1], match[2]);
  }

  return blocks;
}

function parseColors(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--color-nc-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6,8})\s*;/g)].map(
      ([, name, value]) => [toTokenName(name), value.toUpperCase()],
    ),
  );
}

function resolveTokenNameConflicts(tokens) {
  const names = Object.keys(tokens);
  const remap = new Map();
  for (const name of names) {
    if (names.some((other) => other !== name && other.startsWith(`${name}.`))) {
      remap.set(name, `${name}.base`);
    }
  }
  if (remap.size === 0) {
    return tokens;
  }
  return Object.fromEntries(
    Object.entries(tokens).map(([name, value]) => [remap.get(name) ?? name, value]),
  );
}

const blocks = parseThemeBlocks(css);
const themes = themeOrder.map((name) => {
  const block = blocks.get(name);
  if (!block) {
    throw new Error(`Theme '${name}' is listed in src/lib/theme.ts but not found in src/app.css`);
  }

  const tokens = resolveTokenNameConflicts(parseColors(block));
  if (Object.keys(tokens).length === 0) {
    throw new Error(`Theme '${name}' has no color tokens`);
  }

  return {
    name,
    setName: `NexusCommander/${name}`,
    tokens,
  };
});

const tokenNames = new Set(Object.keys(themes[0].tokens));
for (const theme of themes) {
  const names = Object.keys(theme.tokens);
  const missing = [...tokenNames].filter((name) => !names.includes(name));
  const extra = names.filter((name) => !tokenNames.has(name));

  if (missing.length || extra.length) {
    throw new Error(
      `Theme '${theme.name}' token mismatch. Missing: ${missing.join(", ") || "-"}; extra: ${
        extra.join(", ") || "-"
      }`,
    );
  }
}

const payload = {
  source: {
    appCss: "src/app.css",
    themeList: "src/lib/theme.ts",
  },
  penpot: {
    tokenGroup: "NexusCommander",
    setPrefix: "NexusCommander",
  },
  tokenCountPerTheme: tokenNames.size,
  themes,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
