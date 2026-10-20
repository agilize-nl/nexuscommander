// Browser-download plan §4.1 — transport layer, analogous to
// `$lib/upload/uploadClient.ts`. Deliberately web-local (not `$lib/ipc.ts`):
// `convertFileSrc` describes a preview/asset URL with no download intent or
// headers, and this feature is offered only via the web-only `showDownload`
// seam, never through the shared `NexusIpc` capability contract.

import { get } from "svelte/store";
import { _ } from "../i18n";

const API = "/api";

export interface PrepareDownloadResult {
  bundleId: string;
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  skipped: string[];
}

export async function prepareDownload(dir: string, items: string[]): Promise<PrepareDownloadResult> {
  const response = await fetch(`${API}/download/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir, items }),
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(get(_)("download.error_prepare", { error: message }));
  }
  return response.json();
}

export interface BundleProgressEvent {
  bytesRead: number;
  totalBytes: number;
}

export interface BundleTerminalEvent {
  bytesRead?: number;
  totalBytes?: number;
  skipped?: string[];
  message?: string;
}

export interface BundleDownloadHandlers {
  onProgress?: (event: BundleProgressEvent) => void;
  onComplete?: (event: BundleTerminalEvent) => void;
  onError?: (event: BundleTerminalEvent) => void;
  onAborted?: () => void;
}

export interface BundleDownloadHandle {
  /** Closes the progress EventSource. Cannot abort the native browser download (§2.5/§4.1). */
  dismiss: () => void;
}

/**
 * Opens the SSE progress channel for `bundleId`, then triggers the actual
 * zip download via a hidden `<a download>` click — never `fetch`+`Blob`,
 * which would buffer the whole zip in memory before anything reaches disk
 * (§2.2). Returns a handle that can only close the progress view, not cancel
 * the native download (§2.5).
 */
export function startBundleDownload(bundleId: string, handlers: BundleDownloadHandlers = {}): BundleDownloadHandle {
  const source = new EventSource(`${API}/download/${bundleId}/progress`);
  let closed = false;
  let started = false;

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  const triggerDownload = () => {
    if (started) return;
    started = true;
    const link = document.createElement("a");
    link.href = `${API}/download/bundle?bundleId=${encodeURIComponent(bundleId)}`;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  source.addEventListener("status", () => {
    triggerDownload();
  });
  // Fallback: don't wait forever on a missed/late "status" event before
  // starting the actual download (§4.1.2's "connection timeout" safety net).
  const startTimeout = setTimeout(triggerDownload, 1500);

  source.addEventListener("progress", (event: MessageEvent) => {
    handlers.onProgress?.(JSON.parse(event.data));
  });
  source.addEventListener("complete", (event: MessageEvent) => {
    clearTimeout(startTimeout);
    handlers.onComplete?.(JSON.parse(event.data));
    close();
  });
  source.addEventListener("error", (event: MessageEvent) => {
    clearTimeout(startTimeout);
    // A plain EventSource transport error also fires "error" with no `data`.
    const data = (event as MessageEvent).data ? JSON.parse((event as MessageEvent).data) : { message: get(_)("download.error_connection_lost") };
    handlers.onError?.(data);
    close();
  });
  source.addEventListener("aborted", () => {
    clearTimeout(startTimeout);
    handlers.onAborted?.();
    close();
  });

  return {
    dismiss: () => {
      clearTimeout(startTimeout);
      close();
    },
  };
}

/** Single-file download: reuses `GET /api/fs/raw?download=1`. No progress (§2.3). */
export function downloadSingleFile(path: string): void {
  const url = `${API}/fs/raw?path=${encodeURIComponent(path)}&download=1`;
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
