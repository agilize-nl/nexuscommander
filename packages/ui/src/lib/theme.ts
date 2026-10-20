import { writable } from "svelte/store";

export type ThemeName =
  | "midnight" | "ocean" | "dracula" | "solarized-dark" | "gruvbox" | "nortonly"
  | "github-light" | "solarized-light" | "gruvbox-light" | "catppuccin-latte" | "arctic-light";

export const themes: ThemeName[] = [
  "midnight", "ocean", "dracula", "solarized-dark", "gruvbox", "nortonly",
  "github-light", "solarized-light", "gruvbox-light", "catppuccin-latte", "arctic-light"
];

const LIGHT_THEMES: ThemeName[] = [
  "github-light", "solarized-light", "gruvbox-light", "catppuccin-latte", "arctic-light"
];

// Initialize currentTheme from localStorage if available to avoid theme flashing (desktop, leading).
const getInitialTheme = (): ThemeName => {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem("nc-theme") as ThemeName;
      if (saved && themes.includes(saved)) {
        return saved;
      }
    } catch {
      // Storage access can throw SecurityError under storage-blocking / private-browsing policies.
    }
  }
  return "midnight";
};

export const currentTheme = writable<ThemeName>(getInitialTheme());

export function initTheme() {
  if (typeof window !== "undefined") {
    // Theme is driven by AppConfig loaded from the backend; applyTheme is also
    // called directly after settings load.
    currentTheme.subscribe((theme) => {
      applyTheme(theme);
    });
  }
}

export function applyTheme(theme: ThemeName) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.backgroundColor = "";
    // Persist so getInitialTheme() can restore without a flash on next load (from web).
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("nc-theme", theme);
      } catch {
        // Storage access can throw SecurityError under storage-blocking / private-browsing policies.
      }
    }
    // Toggle Tailwind's `dark` class so `dark:` variants track the active theme (from web).
    if (LIGHT_THEMES.includes(theme)) {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }
  }
}
