export function isCoarsePointer(e?: PointerEvent | MouseEvent) {
  if (typeof window === "undefined") return false;
  if ("pointerType" in (e ?? {}) && (e as PointerEvent).pointerType === "mouse") return false;
  return navigator.maxTouchPoints > 0 || window.matchMedia("(hover: none), (pointer: coarse)").matches;
}
