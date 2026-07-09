import { writable, derived } from "svelte/store";
import { loadLanguageFile } from "./ipc";

// The raw dictionary loaded from Rust
export const dictionary = writable<Record<string, any>>({});
export const fallbackDictionary = writable<Record<string, any>>({});

// The current active language code (e.g., "en", "de")
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

const BUILTIN_FALLBACK: Record<string, string> = {
  "menu.files": "Files",
  "menu.mark": "Mark",
  "menu.commands": "Commands",
  "menu.network": "Network",
  "menu.show": "Show",
  "menu.configuration": "Options",
  "menu.help": "Help",
  "menu.toggle_menu_bar": "Toggle Menu Bar",
  "menu.view": "View",
  "menu.edit": "Edit",
  "menu.copy": "Copy",
  "menu.move": "Move / Rename",
  "menu.single_view": "Single View",
  "menu.mkdir": "New Folder",
  "menu.delete": "Delete",
  "menu.hotlist": "Directory Hotlist",
  "menu.options": "Options...",
  "menu.exit": "Exit",
  "panel.name": "Name",
  "panel.ext": "Ext",
  "panel.size": "Size",
  "panel.date": "Date",
  "panel.attr": "Attr",
  "panel.up": "Go up",
  "common.coming_soon": "This feature is coming soon!",
  "fkeys.f2": "Rename",
  "fkeys.f3": "View",
  "fkeys.f4": "Edit",
  "fkeys.f5": "Copy",
  "fkeys.f6": "Move",
  "fkeys.f7": "MkDir",
  "fkeys.f8": "Delete",
  "fkeys.f9": "Tasks",
  "fkeys.f10": "Actions",
  "actions.search_placeholder": "Search actions...",
  "actions.no_results": "No actions found",
};

function normalizeLanguageCode(langCode: string | null | undefined) {
  const code = (langCode || "en").trim();
  return LEGACY_LANGUAGE_CODES[code] || (["en", "nl", "de", "fr", "es", "pt"].includes(code) ? code : "en");
}

// Function to fetch the dictionary from Rust
export async function loadLanguage(langCode: string) {
  const normalized = normalizeLanguageCode(langCode);
  try {
    const fallback = await loadLanguageFile("en");
    const dict = normalized === "en" ? fallback : await loadLanguageFile(normalized);
    fallbackDictionary.set(fallback);
    dictionary.set(dict);
    locale.set(normalized);
    console.log(`Language loaded: ${normalized}`);
  } catch (err) {
    console.error(`Failed to load language ${normalized}:`, err);
    try {
      const fallback = await loadLanguageFile("en");
      fallbackDictionary.set(fallback);
      dictionary.set(fallback);
      locale.set("en");
    } catch (fallbackErr) {
      console.error("Failed to load English fallback language:", fallbackErr);
    }
  }
}

function lookup(dict: Record<string, any>, key: string) {
  return key.split('.').reduce((value: any, k) => value?.[k], dict);
}

// The magical translation store. 
// It listens to the dictionary and returns a function to look up keys.
export const _ = derived([dictionary, fallbackDictionary], ([$dict, $fallback]) => {
  return (key: string, replacements?: Record<string, string | number>) => {
    let value = lookup($dict, key);
    if (value === undefined || value === null) value = lookup($fallback, key);
    if (value === undefined || value === null) value = BUILTIN_FALLBACK[key];
    
    // Fallback to the key itself only when both active language and English miss it.
    if (value === undefined || value === null) return key;

    // Handle string replacements (e.g. {n})
    if (typeof value === "string" && replacements) {
        let result = value;
        for (const [k, v] of Object.entries(replacements)) {
            result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v.toString());
        }
        return result;
    }
    
    return value; 
  };
});
