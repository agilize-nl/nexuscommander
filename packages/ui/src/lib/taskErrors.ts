import type { TaskErrorKind, TaskInfo } from "./ipc-contract";

type Translate = (key: string, replacements?: Record<string, string | number>) => string;

const KNOWN_KINDS: readonly TaskErrorKind[] = [
  "permission_denied",
  "not_found",
  "no_space",
  "read_only",
  "busy",
  "source_retained",
  "other",
];

export interface TaskErrorDescription {
  kind: TaskErrorKind;
  /** One sentence naming what went wrong and where. */
  message: string;
  /** What the user can do about it. */
  hint: string;
  /** The backend's raw message, for the "technical details" disclosure. */
  detail: string | null;
}

export function taskErrorKind(task: TaskInfo): TaskErrorKind {
  const kind = task.error_kind;
  return kind && KNOWN_KINDS.includes(kind) ? kind : "other";
}

/**
 * Turn a failed task into something a user can read.
 *
 * The raw `error` used to be the whole message — "Failed to delete … (trash:
 * false): Permission denied (os error 13)" — untranslated and leaking
 * internals. It is kept, but only as the detail under the explanation.
 */
export function describeTaskError(task: TaskInfo, t: Translate): TaskErrorDescription {
  const kind = taskErrorKind(task);
  const path = task.error_path || task.sources?.[0] || task.target || "";
  return {
    kind,
    message: t(`tasks.errors.${kind}`, { path }),
    hint: t(`tasks.error_hints.${kind}`),
    detail: task.error,
  };
}
