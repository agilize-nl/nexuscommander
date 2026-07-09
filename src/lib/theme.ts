import { writable } from "svelte/store";

export type ThemeName = 
  | "midnight" | "ocean" | "dracula" | "solarized-dark" | "gruvbox" | "nortonly"
  | "github-light" | "solarized-light" | "gruvbox-light" | "catppuccin-latte" | "arctic-light";

export const themes: ThemeName[] = [
  "midnight", "ocean", "dracula", "solarized-dark", "gruvbox", "nortonly",
  "github-light", "solarized-light", "gruvbox-light", "catppuccin-latte", "arctic-light"
];

export const currentTheme = writable<ThemeName>("midnight");

export function initTheme() {
  if (typeof window !== "undefined") {
    // Theme is now driven entirely by AppConfig loaded from the backend
    // applyTheme will be called directly after settings load
    currentTheme.subscribe((theme) => {
      applyTheme(theme);
    });
  }
}

export function applyTheme(theme: ThemeName) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nc-theme", theme);
    const isDark = !["github-light", "solarized-light", "gruvbox-light", "catppuccin-latte", "arctic-light"].includes(theme);
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }
}
