// Shared UI-state stores come from @nexus/ui (single instance). The typed
// application-config store stays here (desktop AppConfig schema).
export * from "@nexus/ui/stores";

import { writable } from "svelte/store";
import type { AppConfig } from "./ipc";
import { createSettingsUpdater } from "@nexus/ui/stores";

/** Global application configuration store. */
export const appConfigStore = writable<AppConfig | null>(null);

/**
 * Update settings globally and trigger a debounced (500ms) save to disk.
 * This prevents race conditions when multiple components try to save simultaneously.
 */
export const updateSettings = createSettingsUpdater(appConfigStore, 500);
