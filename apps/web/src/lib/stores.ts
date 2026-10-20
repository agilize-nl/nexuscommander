// Shared UI-state stores come from @nexus/ui (single instance). The typed
// application-config store and web-only elevated-action store stay here.
export * from "@nexus/ui/stores";

import { writable } from "svelte/store";
import type { AppConfig } from "./types";
import { createSettingsUpdater } from "@nexus/ui/stores";

/** Global application configuration. */
export const appConfigStore = writable<AppConfig | null>(null);

/** Update settings globally and persist immediately via getIpc().saveSettings(). */
export const updateSettings = createSettingsUpdater(appConfigStore);

export interface ElevatedAction {
  type: string;
  value: string;
  paths: string[];
  sourceDir: string;
  owner?: string;
  group?: string;
  permissions?: string;
}

export const pendingElevatedAction = writable<ElevatedAction | null>(null);
