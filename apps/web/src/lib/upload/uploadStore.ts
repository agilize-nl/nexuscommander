import { writable, get } from "svelte/store";
import { preflightUpload, uploadOneFile, type PreflightConflict } from "./uploadClient";
import { createDirectory } from "$lib/ipc";
import { appConfigStore } from "$lib/stores";
import { _ } from "$lib/i18n";
import type { ConflictPolicy } from "$lib/types";

export function getUniqueRenamePath(rel: string, existingPaths: Set<string>): string {
  let currentRel = rel;
  let parts = currentRel.split('/');
  let filename = parts.pop() || '';
  let extIndex = filename.lastIndexOf('.');
  let base = filename;
  let ext = '';
  if (extIndex > 0) {
    base = filename.substring(0, extIndex);
    ext = filename.substring(extIndex);
  }

  const match = base.match(/(.+?)\s*\((\d+)\)$/);
  let originalBase = base;
  let counter = 1;
  if (match) {
    originalBase = match[1].trim();
    counter = parseInt(match[2], 10);
  }

  while (existingPaths.has(currentRel)) {
    const suggestedName = `${originalBase} (${counter})${ext}`;
    const suggestedParts = [...parts, suggestedName];
    currentRel = suggestedParts.join('/');
    counter++;
  }
  return currentRel;
}

export function applyConflictPolicy(
  policy: Exclude<ConflictPolicy, 'ask'>,
  conflicts: PreflightConflict[],
  itemsByRel: Map<string, UploadItem>
): Record<string, { action: 'overwrite' | 'skip' | 'rename'; renameTo?: string }> {
  const resolutions: Record<string, { action: 'overwrite' | 'skip' | 'rename'; renameTo?: string }> = {};
  const usedPaths = new Set<string>();
  
  for (const [rel] of itemsByRel) {
    usedPaths.add(rel);
  }
  for (const conf of conflicts) {
    usedPaths.add(conf.rel);
  }

  for (const conf of conflicts) {
    if (conf.is_dir) {
      continue;
    }

    const item = itemsByRel.get(conf.rel);
    if (!item) continue;

    if (policy === 'overwrite') {
      resolutions[conf.rel] = { action: 'overwrite' };
    } else if (policy === 'skip') {
      resolutions[conf.rel] = { action: 'skip' };
    } else if (policy === 'overwrite_newer') {
      if (item.file.lastModified > conf.modified + 2000) {
        resolutions[conf.rel] = { action: 'overwrite' };
      } else {
        resolutions[conf.rel] = { action: 'skip' };
      }
    } else if (policy === 'overwrite_size_differs') {
      if (item.file.size !== conf.size) {
        resolutions[conf.rel] = { action: 'overwrite' };
      } else {
        resolutions[conf.rel] = { action: 'skip' };
      }
    } else if (policy === 'rename_all') {
      const newPath = getUniqueRenamePath(conf.rel, usedPaths);
      resolutions[conf.rel] = { action: 'rename', renameTo: newPath };
      usedPaths.add(newPath);
    }
  }

  return resolutions;
}

export type UploadItemStatus = 'queued' | 'uploading' | 'done' | 'skipped' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  rel: string;
  name: string;
  targetDir: string;
  side: 'left' | 'right';
  size: number;
  sent: number;
  status: UploadItemStatus;
  error?: string;
  policy: 'normal' | 'overwrite' | { renameTo: string };
  file: File;
}

export interface UploadBatchState {
  items: UploadItem[];
  active: boolean;
  totalBytes: number;
  sentBytes: number;
  speedBps: number;
  etaSeconds: number;
}

const initialState: UploadBatchState = {
  items: [],
  active: false,
  totalBytes: 0,
  sentBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
};

export const uploadStore = writable<UploadBatchState>(initialState);

export interface ConflictState {
  visible: boolean;
  conflicts: any[];
  resolve: ((resolutions: Record<string, { action: 'overwrite' | 'skip' | 'rename'; renameTo?: string }>) => void) | null;
  reject: (() => void) | null;
}

export const conflictState = writable<ConflictState>({
  visible: false,
  conflicts: [],
  resolve: null,
  reject: null,
});

// For passing drag & drop Files that can't go through JSON dropMenuState
export const pendingExternalDrop = writable<{ files: { file: File; rel: string }[]; emptyDirs: string[] } | null>(null);

// Callback to refresh the panels when the batch finishes
let onRefreshPanels: ((sides: ('left' | 'right')[]) => void) | null = null;

export function registerRefreshCallback(callback: typeof onRefreshPanels) {
  onRefreshPanels = callback;
}

let activeUploadHandle: { abort: () => void } | null = null;
let speedTimer: any = null;

export async function startUpload(
  side: 'left' | 'right',
  targetDir: string,
  entries: { file: File; rel: string }[],
  emptyDirs: string[] = []
) {
  if (entries.length === 0 && emptyDirs.length === 0) return;

  // Reset store to new batch
  const items: UploadItem[] = entries.map((entry, idx) => ({
    id: `${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 9)}`,
    rel: entry.rel,
    name: entry.rel.split('/').pop() || entry.rel,
    targetDir,
    side,
    size: entry.file.size,
    sent: 0,
    status: 'queued',
    policy: 'normal',
    file: entry.file,
  }));

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);

  uploadStore.set({
    items,
    active: true,
    totalBytes,
    sentBytes: 0,
    speedBps: 0,
    etaSeconds: 0,
  });

  // Start Speed/ETA computation loop
  startSpeedInterval();

  try {
    // 1. Run Preflight
    const preflightFiles = entries.map(e => ({ rel: e.rel, size: e.file.size }));
    const preflight = await preflightUpload(targetDir, preflightFiles, emptyDirs);

    // Filter out invalid items
    if (preflight.invalid && preflight.invalid.length > 0) {
      const invalidSet = new Set(preflight.invalid);
      uploadStore.update(state => {
        state.items = state.items.map(item => {
          if (invalidSet.has(item.rel)) {
            return { ...item, status: 'error', error: get(_)("upload.error_invalid_path") };
          }
          return item;
        });
        return state;
      });
    }

    // 2. Resolve Conflicts
    let resolutions: Record<string, { action: 'overwrite' | 'skip' | 'rename'; renameTo?: string }> = {};
    if (preflight.conflicts && preflight.conflicts.length > 0) {
      const config = get(appConfigStore);
      const defaultPolicy = config?.upload_on_conflict || 'ask';

      if (defaultPolicy !== 'ask') {
        const itemsByRel = new Map<string, UploadItem>();
        for (const item of items) {
          itemsByRel.set(item.rel, item);
        }
        resolutions = applyConflictPolicy(defaultPolicy, preflight.conflicts, itemsByRel);
      } else {
        try {
          resolutions = await new Promise((resolve, reject) => {
            conflictState.set({
              visible: true,
              conflicts: preflight.conflicts,
              resolve,
              reject,
            });
          });
        } catch (err) {
          // User cancelled the entire modal/upload
          cancelAll();
          return;
        } finally {
          conflictState.set({
            visible: false,
            conflicts: [],
            resolve: null,
            reject: null,
          });
        }
      }
    }

    // Apply resolutions to items
    uploadStore.update(state => {
      state.items = state.items.map(item => {
        const res = resolutions[item.rel];
        if (res) {
          if (res.action === 'skip') {
            return { ...item, status: 'skipped', sent: item.size };
          } else if (res.action === 'overwrite') {
            return { ...item, policy: 'overwrite' };
          } else if (res.action === 'rename' && res.renameTo) {
            return { ...item, policy: { renameTo: res.renameTo } };
          }
        }
        return item;
      });
      return state;
    });

    // 3. Create empty directories
    for (const d of emptyDirs) {
      // If the directory conflicted and was skipped, don't create it
      const res = resolutions[d];
      if (res && res.action === 'skip') continue;
      
      try {
        await createDirectory(targetDir + '/' + d);
      } catch (err) {
        console.error(`Failed to create empty directory ${d}:`, err);
      }
    }

    // 4. Sequential Upload Loop
    const currentItems = get(uploadStore).items;
    for (const item of currentItems) {
      // Re-read status to handle cancellations/skips
      const freshItem = get(uploadStore).items.find(i => i.id === item.id);
      if (!freshItem || freshItem.status !== 'queued') continue;

      const relToUpload = typeof freshItem.policy === 'object' ? freshItem.policy.renameTo : freshItem.rel;
      
      uploadStore.update(state => {
        state.items = state.items.map(i => i.id === item.id ? { ...i, status: 'uploading' } : i);
        return state;
      });

      try {
        const handle = uploadOneFile(targetDir, relToUpload, freshItem.file, {
          overwrite: freshItem.policy === 'overwrite',
          onProgress: (sent) => {
            uploadStore.update(state => {
              state.items = state.items.map(i => i.id === item.id ? { ...i, sent } : i);
              return state;
            });
          }
        });

        activeUploadHandle = handle;
        await handle.promise;

        uploadStore.update(state => {
          state.items = state.items.map(i => i.id === item.id ? { ...i, status: 'done', sent: i.size } : i);
          return state;
        });
      } catch (err: any) {
        uploadStore.update(state => {
          state.items = state.items.map(i => {
            if (i.id === item.id) {
              const status: UploadItemStatus = err.name === 'AbortError' ? 'cancelled' : 'error';
              return { ...i, status, error: err.message };
            }
            return i;
          });
          return state;
        });
      } finally {
        activeUploadHandle = null;
      }
    }
  } catch (err: any) {
    console.error('Upload batch failed:', err);
    uploadStore.update(state => {
      state.items = state.items.map(i => i.status === 'queued' ? { ...i, status: 'error', error: err.message } : i);
      return state;
    });
  } finally {
    uploadStore.update(state => {
      state.active = false;
      return state;
    });
    stopSpeedInterval();
    
    // Trigger panel refresh
    if (onRefreshPanels) {
      onRefreshPanels([side]);
    }
  }
}

export function cancelItem(id: string) {
  uploadStore.update(state => {
    state.items = state.items.map(item => {
      if (item.id === id) {
        if (item.status === 'uploading' && activeUploadHandle) {
          activeUploadHandle.abort();
        }
        return { ...item, status: 'cancelled' };
      }
      return item;
    });
    return state;
  });
}

export function cancelAll() {
  uploadStore.update(state => {
    state.items = state.items.map(item => {
      if (item.status === 'uploading' && activeUploadHandle) {
        activeUploadHandle.abort();
      }
      if (item.status === 'queued' || item.status === 'uploading') {
        return { ...item, status: 'cancelled' };
      }
      return item;
    });
    state.active = false;
    return state;
  });
  stopSpeedInterval();
}

export function clearFinished() {
  uploadStore.update(state => {
    if (state.active) return state; // Don't clear while active
    return initialState;
  });
}

// Speed/ETA Calculation
let lastSentBytes = 0;
const speedHistory: number[] = [];

function startSpeedInterval() {
  stopSpeedInterval();
  lastSentBytes = 0;
  speedHistory.length = 0;
  
  speedTimer = setInterval(() => {
    uploadStore.update(state => {
      const currentSent = state.items.reduce((sum, item) => sum + item.sent, 0);
      const delta = currentSent - lastSentBytes;
      lastSentBytes = currentSent;

      // Speed in bytes per second (delta / 0.5)
      const speed = delta * 2;
      speedHistory.push(speed);
      if (speedHistory.length > 5) {
        speedHistory.shift();
      }

      const avgSpeed = speedHistory.reduce((sum, s) => sum + s, 0) / speedHistory.length;
      const remainingBytes = Math.max(0, state.totalBytes - currentSent);
      const eta = avgSpeed > 0 ? Math.ceil(remainingBytes / avgSpeed) : 0;

      return {
        ...state,
        sentBytes: currentSent,
        speedBps: avgSpeed,
        etaSeconds: eta,
      };
    });
  }, 500);
}

function stopSpeedInterval() {
  if (speedTimer) {
    clearInterval(speedTimer);
    speedTimer = null;
  }
}
