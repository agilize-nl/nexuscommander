#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const payload = JSON.parse(
  execFileSync(process.execPath, ["scripts/export-penpot-theme-tokens.js"], {
    encoding: "utf8",
  }),
);

const importCode = `const payload = ${JSON.stringify(payload, null, 2)};

function getOrCreateSet(catalog, name) {
  return catalog.sets.find((set) => set.name === name) || catalog.addSet({ name });
}

function getOrCreateTheme(catalog, group, name) {
  return (
    catalog.themes.find((theme) => theme.group === group && theme.name === name) ||
    catalog.addTheme({ group, name })
  );
}

function getOrCreateColorToken(set, name, value) {
  const token = set.tokens.find((item) => item.type === "color" && item.name === name);
  if (token) {
    token.value = value;
    return { token, created: false };
  }

  return {
    token: set.addToken({ type: "color", name, value }),
    created: true,
  };
}

const catalog = penpot.library.local.tokens;
const summary = {
  tokenGroup: payload.penpot.tokenGroup,
  updatedSets: [],
  createdTokens: 0,
  updatedTokens: 0,
  themes: [],
  manualThemeLinks: [],
};

for (const themePayload of payload.themes) {
  const set = getOrCreateSet(catalog, themePayload.setName);
  let createdInSet = 0;
  let updatedInSet = 0;

  for (const [name, value] of Object.entries(themePayload.tokens)) {
    const result = getOrCreateColorToken(set, name, value);
    if (result.created) {
      createdInSet += 1;
      summary.createdTokens += 1;
    } else {
      updatedInSet += 1;
      summary.updatedTokens += 1;
    }
  }

  const tokenTheme = getOrCreateTheme(catalog, payload.penpot.tokenGroup, themePayload.name);
  if (!tokenTheme.activeSets.some((activeSet) => activeSet.name === themePayload.setName)) {
    tokenTheme.addSet(set);
  }
  const activeSetNames = tokenTheme.activeSets.map((activeSet) => activeSet.name);
  if (!activeSetNames.includes(themePayload.setName)) {
    summary.manualThemeLinks.push({
      themeGroup: tokenTheme.group,
      themeName: tokenTheme.name,
      requiredSet: themePayload.setName,
    });
  }

  summary.updatedSets.push({
    name: set.name,
    tokenCount: set.tokens.filter((token) => token.type === "color").length,
    createdTokens: createdInSet,
    updatedTokens: updatedInSet,
  });
  summary.themes.push({
    group: tokenTheme.group,
    name: tokenTheme.name,
    activeSets: activeSetNames,
  });
}

return summary;`;

process.stdout.write(`${importCode}\n`);
