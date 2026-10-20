import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The locales live in @nexus/ui and are loaded from there by the shared
// i18n glob; this used to point at a per-app copy that no longer exists.
const localesDir = path.join(__dirname, '../../../packages/ui/src/lib/locales');
const referenceFile = path.join(localesDir, 'en.json');

if (!fs.existsSync(referenceFile)) {
  console.error("Reference file en.json not found!");
  process.exit(1);
}

const refData = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));

function getAllKeys(obj, prefix = '') {
  let keys = [];
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys = keys.concat(getAllKeys(obj[key], prefix + key + '.'));
    } else {
      keys.push(prefix + key);
    }
  }
  return keys;
}

const refKeys = new Set(getAllKeys(refData));
let hasErrors = false;

const files = fs.readdirSync(localesDir);
for (const file of files) {
  if (file === 'en.json' || !file.endsWith('.json')) continue;

  const filePath = path.join(localesDir, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Error parsing JSON in ${file}: ${e.message}`);
    hasErrors = true;
    continue;
  }

  const keys = getAllKeys(data);
  const fileKeys = new Set(keys);

  const missing = [];
  for (const k of refKeys) {
    if (!fileKeys.has(k)) {
      missing.push(k);
    }
  }

  const extra = [];
  for (const k of keys) {
    if (!refKeys.has(k)) {
      extra.push(k);
    }
  }

  if (missing.length > 0 || extra.length > 0) {
    console.log(`\nLocale file: ${file}`);
    if (missing.length > 0) {
      console.log(`  Missing keys:`);
      missing.forEach(k => console.log(`    - ${k}`));
    }
    if (extra.length > 0) {
      console.log(`  Extra/unwanted keys:`);
      extra.forEach(k => console.log(`    - ${k}`));
    }
    hasErrors = true;
  }
}

if (hasErrors) {
  console.log("\n❌ Locale check failed. There are missing or extra keys in locale files.");
  process.exit(1);
} else {
  console.log("✅ All locale files are in sync with en.json!");
  process.exit(0);
}
