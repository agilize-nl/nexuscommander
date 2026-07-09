/**
 * smartPoller — battery-friendly on-demand polling.
 *
 * Contract (do not weaken when reusing this file elsewhere):
 * 1. Starts only on kick() — never automatically on creation.
 * 2. setTimeout chain, not setInterval — the next tick is scheduled only
 *    after the previous poll() has resolved. Prevents pile-up on slow links.
 * 3. Self-extinguishing — after idleGraceTicks consecutive `false` results
 *    the loop stops completely (no dormant interval left behind).
 * 4. Visibility-aware — on `visibilitychange` to hidden, the pending timer
 *    is cancelled; on return to visible (only if the loop was active) it
 *    fires immediately and resumes the chain. The "was active" flag
 *    survives a hide/show cycle.
 * 5. destroy() cancels the timer and removes the visibilitychange listener;
 *    call it from the consuming component's effect cleanup.
 */

export interface SmartPollerOptions {
  /** One poll tick. Return true = still active, keep polling;
   *  false = idle. Exceptions count as an idle tick (no retry storm). */
  poll: () => Promise<boolean>;
  /** Base interval in ms (default 1000). */
  intervalMs?: number;
  /** Consecutive idle ticks before the loop actually stops (default 3). */
  idleGraceTicks?: number;
}

export interface SmartPoller {
  /** Starts the loop (no-op if already running) and fires an immediate first tick. */
  kick(): void;
  /** Stops the loop and removes the visibility listener. */
  destroy(): void;
}

export function createSmartPoller(opts: SmartPollerOptions): SmartPoller {
  const intervalMs = opts.intervalMs ?? 1000;
  const idleGraceTicks = opts.idleGraceTicks ?? 3;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleStreak = 0;
  let hiddenPause = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function tick() {
    timer = null;

    let active: boolean;
    try {
      active = await opts.poll();
    } catch {
      active = false;
    }

    if (!running) return;

    if (active) {
      idleStreak = 0;
    } else {
      idleStreak += 1;
      if (idleStreak >= idleGraceTicks) {
        running = false;
        return;
      }
    }

    if (document.hidden) {
      hiddenPause = true;
      return;
    }

    timer = setTimeout(tick, intervalMs);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      hiddenPause = true;
      clearTimer();
      return;
    }
    if (hiddenPause && running) {
      hiddenPause = false;
      clearTimer();
      tick();
    }
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  function kick() {
    if (running) return;
    running = true;
    idleStreak = 0;
    hiddenPause = false;
    clearTimer();
    tick();
  }

  function destroy() {
    running = false;
    clearTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }

  return { kick, destroy };
}
