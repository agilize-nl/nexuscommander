// Browser-download plan §4.1 — state for the download panel. Only the
// zip-bundle path appears here; single-file downloads have nothing useful
// to show (§2.3) and never enter this store.

import { writable } from "svelte/store";
import { prepareDownload, startBundleDownload, type BundleDownloadHandle } from "./downloadClient";

export type DownloadItemStatus = "preparing" | "streaming" | "server_complete" | "error" | "dismissed";

export interface DownloadBatchState {
  id: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  readBytes: number;
  status: DownloadItemStatus;
  speedBps: number;
  etaSeconds: number;
  error?: string;
  skipped: string[];
}

export const downloadBatches = writable<DownloadBatchState[]>([]);

// One speed/ETA smoothing interval per in-flight batch, keyed by id — same
// rolling-window shape as uploadStore's, but the underlying data source is
// SSE push rather than an XHR poll; the interval only smooths what has
// already arrived.
const speedTimers = new Map<string, ReturnType<typeof setInterval>>();
const speedHistories = new Map<string, number[]>();
const lastReadBytes = new Map<string, number>();
const handles = new Map<string, BundleDownloadHandle>();

function updateBatch(id: string, patch: Partial<DownloadBatchState>) {
  downloadBatches.update((batches) => batches.map((b) => (b.id === id ? { ...b, ...patch } : b)));
}

function startSpeedInterval(id: string) {
  lastReadBytes.set(id, 0);
  speedHistories.set(id, []);
  const timer = setInterval(() => {
    downloadBatches.update((batches) => {
      const batch = batches.find((b) => b.id === id);
      if (!batch) return batches;
      const prev = lastReadBytes.get(id) ?? 0;
      const delta = batch.readBytes - prev;
      lastReadBytes.set(id, batch.readBytes);

      const speed = delta * 2; // bytes/sec at a 500ms tick
      const history = speedHistories.get(id) ?? [];
      history.push(speed);
      if (history.length > 5) history.shift();
      speedHistories.set(id, history);

      const avgSpeed = history.reduce((sum, s) => sum + s, 0) / history.length;
      const remaining = Math.max(0, batch.totalBytes - batch.readBytes);
      const eta = avgSpeed > 0 ? Math.ceil(remaining / avgSpeed) : 0;

      return batches.map((b) => (b.id === id ? { ...b, speedBps: avgSpeed, etaSeconds: eta } : b));
    });
  }, 500);
  speedTimers.set(id, timer);
}

function stopSpeedInterval(id: string) {
  const timer = speedTimers.get(id);
  if (timer) clearInterval(timer);
  speedTimers.delete(id);
  speedHistories.delete(id);
  lastReadBytes.delete(id);
}

/** Starts a zip-bundle download for `items` (relative to `dir`) and tracks it in the panel. */
export async function startZipDownload(dir: string, items: string[], displayName: string): Promise<void> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const batch: DownloadBatchState = {
    id,
    name: displayName,
    fileCount: 0,
    totalBytes: 0,
    readBytes: 0,
    status: "preparing",
    speedBps: 0,
    etaSeconds: 0,
    skipped: [],
  };
  downloadBatches.update((batches) => [...batches, batch]);

  try {
    const prepared = await prepareDownload(dir, items);
    updateBatch(id, {
      fileCount: prepared.fileCount,
      totalBytes: prepared.totalBytes,
      skipped: prepared.skipped,
      status: "streaming",
    });
    startSpeedInterval(id);

    const handle = startBundleDownload(prepared.bundleId, {
      onProgress: ({ bytesRead, totalBytes }) => {
        updateBatch(id, { readBytes: bytesRead, totalBytes });
      },
      onComplete: ({ bytesRead, skipped }) => {
        stopSpeedInterval(id);
        updateBatch(id, {
          status: "server_complete",
          readBytes: bytesRead ?? batch.totalBytes,
          skipped: skipped ?? [],
        });
      },
      onError: ({ message }) => {
        stopSpeedInterval(id);
        updateBatch(id, { status: "error", error: message });
      },
      onAborted: () => {
        stopSpeedInterval(id);
        updateBatch(id, { status: "error", error: undefined });
      },
    });
    handles.set(id, handle);
  } catch (err: any) {
    stopSpeedInterval(id);
    updateBatch(id, { status: "error", error: err?.message ?? String(err) });
  }
}

/** Dismisses a batch from the panel. Never cancels the underlying native download (§2.5). */
export function dismissDownload(id: string): void {
  handles.get(id)?.dismiss();
  handles.delete(id);
  stopSpeedInterval(id);
  downloadBatches.update((batches) => batches.filter((b) => b.id !== id));
}
