/**
 * IPC injection point for the shared UI.
 *
 * Each app shell builds its adapter (Tauri invoke / HTTP fetch) implementing
 * `NexusIpc` and calls `setIpc(adapter)` once at startup. Shared components in
 * `@nexus/ui` call `getIpc()` instead of importing transport code directly, so
 * the same component tree runs on desktop and web.
 *
 * A module singleton is used (not Svelte context) so non-component modules
 * (stores, utils) can reach the adapter too.
 */
import type { NexusIpc } from "./ipc-contract";

let current: NexusIpc | null = null;

/** Register the active transport adapter. Call once per app at startup. */
export function setIpc(impl: NexusIpc): void {
  current = impl;
}

/** Whether an adapter has been registered yet. */
export function hasIpc(): boolean {
  return current !== null;
}

/**
 * Get the active adapter. Throws if none is registered — that means an app
 * shell forgot to `setIpc(...)` before rendering shared UI.
 */
export function getIpc(): NexusIpc {
  if (!current) {
    throw new Error(
      "[@nexus/ui] No IPC adapter registered. Call setIpc(adapter) at app startup before rendering shared components."
    );
  }
  return current;
}
