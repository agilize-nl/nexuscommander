/// <reference types="vite/client" />
import { writable, derived } from "svelte/store";

/**
 * Shared i18n (@nexus/ui). Merged strategy:
 *  - Desktop's bundled loader (import.meta.glob) is the standard → works offline in
 *    both the Tauri shell and the PWA, no server round-trip (see migration Fase 5).
 *  - Web's robustness is kept: English fallback dictionary, a built-in fallback map,
 *    and legacy language-code normalization.
 *
 * Locales live next to this file at ./locales/*.json (moved from the desktop app).
 */

// Discover all bundled language JSON files eagerly for zero-latency initial rendering.
const localeFiles = import.meta.glob<{ default: Record<string, any> }>("./locales/*.json", { eager: true });

export const availableLocales = Object.keys(localeFiles)
  .map((path) => {
    const match = path.match(/\.\/locales\/(.*)\.json$/);
    return match ? match[1] : null;
  })
  .filter(Boolean) as string[];

function getDictSync(code: string): Record<string, any> {
  const path = `./locales/${code}.json`;
  const fallbackPath = `./locales/en.json`;
  const mod = localeFiles[path] || localeFiles[fallbackPath];
  if (!mod) return {};
  return (mod.default || mod) as Record<string, any>;
}

const initialEnDict = getDictSync("en");

/** The active dictionary and the English fallback dictionary. */
export const dictionary = writable<Record<string, any>>(initialEnDict);
export const fallbackDictionary = writable<Record<string, any>>(initialEnDict);

/** The current active language code (e.g. "en", "de"). */
export const locale = writable<string>("en");

const LEGACY_LANGUAGE_CODES: Record<string, string> = {
  "doublecmd.pot": "en",
  "doublecmd.en.po": "en",
  "doublecmd.nl.po": "nl",
  "doublecmd.de.po": "de",
  "doublecmd.fr.po": "fr",
  "doublecmd.es.po": "es",
  "doublecmd.pt.po": "pt",
};

function normalizeLanguageCode(langCode: string | null | undefined): string {
  const code = (langCode || "en").trim();
  if (LEGACY_LANGUAGE_CODES[code]) return LEGACY_LANGUAGE_CODES[code];
  const short = code.split("-")[0].toLowerCase();
  return ["en", "nl", "de", "fr", "es", "pt"].includes(short) ? short : "en";
}

/** Load a language dictionary by its code (bundled; offline). */
export async function loadLanguage(langCode: string): Promise<void> {
  const normalized = normalizeLanguageCode(langCode);
  try {
    const fallback = getDictSync("en");
    const dict = normalized === "en" ? fallback : getDictSync(normalized);
    fallbackDictionary.set(fallback);
    dictionary.set(dict);
    locale.set(normalized);
    if (typeof document !== "undefined") document.documentElement.lang = normalized;
    console.log(`[i18n] Language loaded: ${normalized}`);
  } catch (err) {
    console.error(`[i18n] Failed to load language ${langCode}:`, err);
  }
}

function lookup(dict: Record<string, any>, key: string) {
  return key.split(".").reduce((value: any, k) => value?.[k], dict);
}

/**
 * The translation store. Usage in Svelte: `$_('menu.files.new_folder')`.
 * Looks up active dictionary → English fallback → built-in fallback → the key itself.
 */
export const _ = derived([dictionary, fallbackDictionary], ([$dict, $fallback]) => {
  return (key: string, replacements?: Record<string, string | number>) => {
    let value = lookup($dict, key);
    if (value === undefined || value === null) value = lookup($fallback, key);
    if (value === undefined || value === null) return key;

    if (typeof value === "string" && replacements) {
      let result = value;
      for (const [k, v] of Object.entries(replacements)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
      return result;
    }
    return value;
  };
});
