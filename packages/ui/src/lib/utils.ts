// Shared formatting helpers (@nexus/ui). Zero-dependency by design.
// Merged desktop (leading) + web: desktop's formatSize (exactBytes) and
// formatPermissions (symbolic passthrough) win; formatDate is normalized to
// work with BOTH backends (see below).

/** Format bytes into a human-readable string, or exact bytes when requested. */
export function formatSize(bytes: number, exactBytes = false): string {
  if (bytes === 0) return "";
  if (exactBytes) return `${bytes.toLocaleString()} B`;
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

/**
 * Format a timestamp into a date string.
 *
 * The two backends report `modified` in different units: the Tauri/Rust VFS uses
 * whole seconds since epoch (u64), the Express server uses milliseconds (mtimeMs).
 * We normalize here so a single shared component tree works on both transports:
 * values below 1e11 are treated as seconds (×1000), everything else as ms.
 * (Epoch-seconds today ≈ 1.7e9; epoch-ms ≈ 1.7e12 — the threshold separates them cleanly.)
 */
export function formatDate(timestamp: number): string {
  if (!timestamp) return "";
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

/** Format octal permissions such as "755" as a Unix mode string. */
export function formatPermissions(entry: {
  permissions?: string;
  is_dir: boolean;
  is_symlink: boolean;
}): string {
  const raw = entry.permissions?.trim();
  if (!raw) return "";

  // Already a symbolic mode string (e.g. "drwxr-xr-x") — pass through.
  if (/^[dl-][rwx-]{9}$/.test(raw)) return raw;

  const normalized = raw.replace(/^0+/, "").slice(-3).padStart(3, "0");
  if (!/^[0-7]{3}$/.test(normalized)) return raw;

  const type = entry.is_symlink ? "l" : entry.is_dir ? "d" : "-";
  const chars = ["r", "w", "x"] as const;
  const mode = normalized
    .split("")
    .map((digit) => {
      const bits = Number(digit);
      return chars.map((char, bit) => (bits & (4 >> bit) ? char : "-")).join("");
    })
    .join("");

  return `${type}${mode}`;
}

/** Get a CSS color class based on file extension. */
export function getFileColor(entry: {
  is_dir: boolean;
  is_symlink: boolean;
  extension: string;
}): string {
  if (entry.is_symlink) return "text-nc-symlink";
  if (entry.is_dir) return "text-nc-dir";

  const ext = entry.extension.toLowerCase();
  const archives = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"];
  const images = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico"];
  const executables = ["sh", "bash", "exe", "bat", "cmd", "appimage", "run"];

  if (archives.includes(ext)) return "text-nc-archive";
  if (images.includes(ext)) return "text-nc-image";
  if (executables.includes(ext)) return "text-nc-exec";

  return "text-nc-text";
}
