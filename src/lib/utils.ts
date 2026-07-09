import { get } from "svelte/store";
import { _ } from "./i18n";

export function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  const t = get(_);
  const k = t("size_units.k") || "K";
  const m = t("size_units.m") || "M";
  const g = t("size_units.g") || "G";
  const t_unit = t("size_units.t") || "T";
  const units = ["", k, m, g, t_unit];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  const unit = units[i];
  if (i === 0) {
    return `${Math.round(size)}`;
  }
  return `${size.toFixed(1)}${unit}`;
}

/** Format a unix timestamp into a date string. */
export function formatDate(timestamp: number): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/** Format octal permissions such as "755" as a Unix mode string. */
export function formatPermissions(entry: {
  permissions?: string;
  is_dir: boolean;
  is_symlink: boolean;
}): string {
  const raw = entry.permissions?.trim();
  if (!raw) return "";

  const normalized = raw.replace(/^0+/, "").slice(-3).padStart(3, "0");
  if (!/^[0-7]{3}$/.test(normalized)) return raw;

  const type = entry.is_symlink ? "l" : entry.is_dir ? "d" : "-";
  const chars = ["r", "w", "x"] as const;
  const mode = normalized
    .split("")
    .map((digit) => {
      const bits = Number(digit);
      return chars.map((char, bit) => (bits & (4 >> bit)) ? char : "-").join("");
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
