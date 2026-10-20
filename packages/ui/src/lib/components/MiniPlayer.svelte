<script lang="ts">
  import { get } from "svelte/store";
  import {
    playerState,
    currentTrackPath,
    peekNextTrackPath,
    togglePlay,
    playNext,
    playPrev,
    toggleShuffle,
    cycleRepeat,
    setVolume,
    stopPlayer,
    pausePlayback,
    reportProgress
  } from "../playerStore";
  import { convertFileSrc } from "../ipc";
  import { _ } from "../i18n";
  import { Repeat, Repeat1, Shuffle, SkipBack, Play, Pause, SkipForward } from "lucide-svelte";

  // Dual audio elements for seamless ping-pong buffering, 3-second crossfading,
  // and zero-gap auto-advance on lock screen.
  let audioElA: HTMLAudioElement | undefined = $state(undefined);
  let audioElB: HTMLAudioElement | undefined = $state(undefined);
  let activeSlot = $state<"A" | "B">("A");

  function getActiveEl(): HTMLAudioElement | undefined {
    return activeSlot === "A" ? audioElA : audioElB;
  }

  function getIdleEl(): HTMLAudioElement | undefined {
    return activeSlot === "A" ? audioElB : audioElA;
  }

  const currentPath = $derived(currentTrackPath($playerState));
  const trackName = $derived(currentPath ? (currentPath.split("/").pop() ?? currentPath) : "");
  const isPlaying = $derived($playerState.isPlaying);

  // 3-second fade duration for outro fade-out / crossfade (next track starts without fade-in)
  const FADE_DURATION = 3.0;

  function calculateFadeFactor(currentTime: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 1.0;
    const effectiveFade = Math.min(FADE_DURATION, duration / 2);
    if (effectiveFade <= 0) return 1.0;

    // Fade out during last 3 seconds
    const remaining = duration - currentTime;
    if (remaining < effectiveFade) {
      return Math.max(0, Math.min(1, remaining / effectiveFade));
    }

    return 1.0;
  }

  function applyVolume(el: HTMLAudioElement | undefined) {
    if (!el) return;
    const masterVolume = $playerState.volume;
    if (el.paused) return;
    const factor = calculateFadeFactor(el.currentTime, el.duration);
    el.volume = Math.max(0, Math.min(1, masterVolume * factor));
  }

  function updateVolumes() {
    applyVolume(audioElA);
    applyVolume(audioElB);
  }

  let fadeAnimationId: number | null = null;
  function startVolumeLoop() {
    if (fadeAnimationId != null) return;
    function tick() {
      updateVolumes();
      fadeAnimationId = requestAnimationFrame(tick);
    }
    fadeAnimationId = requestAnimationFrame(tick);
  }

  function stopVolumeLoop() {
    if (fadeAnimationId != null) {
      cancelAnimationFrame(fadeAnimationId);
      fadeAnimationId = null;
    }
  }

  // Web Audio keep-alive: keeps the mobile OS audio subsystem continuously active
  let keepAliveCtx: AudioContext | null = null;
  let keepAliveOsc: OscillatorNode | null = null;
  let keepAliveGain: GainNode | null = null;

  function ensureAudioKeepAlive() {
    try {
      if (typeof window === "undefined") return;
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      if (!keepAliveCtx) {
        keepAliveCtx = new AudioContextClass();
        keepAliveGain = keepAliveCtx.createGain();
        keepAliveGain.gain.value = 0.0001; // Inaudible sub-threshold keep-alive signal
        keepAliveOsc = keepAliveCtx.createOscillator();
        keepAliveOsc.frequency.value = 20; // 20 Hz
        keepAliveOsc.connect(keepAliveGain);
        keepAliveGain.connect(keepAliveCtx.destination);
        keepAliveOsc.start();
      }
      if (keepAliveCtx.state === "suspended") {
        void keepAliveCtx.resume().catch(() => {});
      }
    } catch {
      // Silently ignore if Web Audio is restricted
    }
  }

  function suspendAudioKeepAlive() {
    try {
      if (keepAliveCtx && keepAliveCtx.state === "running") {
        void keepAliveCtx.suspend().catch(() => {});
      }
    } catch {}
  }

  function preloadNextTrack(state: ReturnType<typeof get<typeof playerState>>) {
    const idleEl = getIdleEl();
    if (!idleEl) return;
    const nextPath = peekNextTrackPath(state);
    if (!nextPath) {
      if (idleEl.src) {
        idleEl.removeAttribute("src");
        idleEl.load();
      }
      return;
    }
    const nextSrc = convertFileSrc(nextPath);
    if (idleEl.getAttribute("src") !== nextSrc) {
      idleEl.src = nextSrc;
      idleEl.preload = "auto";
      idleEl.load();
    }
  }

  function updateMediaSessionSync(path: string | null, isPlay: boolean) {
    if (!("mediaSession" in navigator)) return;
    if (!path) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      return;
    }
    const name = path.split("/").pop() ?? path;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: name,
      artist: "NexusCommander",
      artwork: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
      ]
    });
    navigator.mediaSession.playbackState = isPlay ? "playing" : "paused";
  }

  function updateMediaSessionPosition(currentTime: number, duration: number) {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime) && currentTime >= 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: 1,
          position: Math.min(Math.max(0, currentTime), duration),
        });
      } catch {
        // Silently catch invalid state transitions
      }
    }
  }

  // Crossfade trigger tracking
  let crossfadeTriggered = false;

  function checkCrossfade(activeEl: HTMLAudioElement) {
    if (crossfadeTriggered || !isPlaying) return;
    const duration = activeEl.duration;
    const currentTime = activeEl.currentTime;

    if (!Number.isFinite(duration) || duration <= 6) return;

    const remaining = duration - currentTime;
    if (remaining <= FADE_DURATION) {
      const s = get(playerState);
      const nextPath = peekNextTrackPath(s);
      if (nextPath) {
        crossfadeTriggered = true;
        startCrossfadeToNext(nextPath);
      }
    }
  }

  function startCrossfadeToNext(nextPath: string) {
    const outgoingEl = getActiveEl();
    const incomingEl = getIdleEl();
    if (!outgoingEl || !incomingEl) return;

    playNext(true);

    const nextSrc = convertFileSrc(nextPath);
    if (incomingEl.getAttribute("src") !== nextSrc) {
      incomingEl.src = nextSrc;
    }
    incomingEl.currentTime = 0;
    incomingEl.volume = $playerState.volume;

    activeSlot = activeSlot === "A" ? "B" : "A";

    void incomingEl.play().catch(() => {});
    ensureAudioKeepAlive();
    startVolumeLoop();
    updateMediaSessionSync(nextPath, true);
  }

  function startTrackSync(targetPath: string) {
    crossfadeTriggered = false;
    const activeEl = getActiveEl();
    const idleEl = getIdleEl();
    if (!activeEl || !idleEl) return;

    const targetSrc = convertFileSrc(targetPath);

    if (idleEl.getAttribute("src") === targetSrc) {
      activeEl.pause();
      activeSlot = activeSlot === "A" ? "B" : "A";
      const newActiveEl = idleEl;
      newActiveEl.currentTime = 0;
      newActiveEl.volume = $playerState.volume;
      void newActiveEl.play().catch(() => {});
    } else {
      if (activeEl.getAttribute("src") !== targetSrc) {
        activeEl.src = targetSrc;
      }
      activeEl.currentTime = 0;
      activeEl.volume = $playerState.volume;
      void activeEl.play().catch(() => {});
    }

    ensureAudioKeepAlive();
    startVolumeLoop();
    updateMediaSessionSync(targetPath, true);

    const s = get(playerState);
    preloadNextTrack(s);
  }

  function handleEnded(e: Event) {
    const finishedEl = e.currentTarget as HTMLAudioElement;
    const activeEl = getActiveEl();

    if (finishedEl !== activeEl) {
      // Outgoing element from crossfade finished
      finishedEl.pause();
      finishedEl.removeAttribute("src");
      finishedEl.load();

      const s = get(playerState);
      preloadNextTrack(s);
      return;
    }

    if ($playerState.repeat === "one") {
      activeEl.currentTime = 0;
      activeEl.volume = $playerState.volume;
      crossfadeTriggered = false;
      void activeEl.play().catch(() => {});
      ensureAudioKeepAlive();
      startVolumeLoop();
      return;
    }

    playNext(true);
    const s = get(playerState);
    if (!s.isPlaying) {
      activeEl.pause();
      stopVolumeLoop();
      suspendAudioKeepAlive();
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
      return;
    }

    const nextPath = currentTrackPath(s);
    if (nextPath) {
      startTrackSync(nextPath);
    }
  }

  let consecutiveErrors = 0;
  const playlist = $derived($playerState.playlist);
  $effect(() => {
    void playlist;
    consecutiveErrors = 0;
  });

  function handleError(e: Event) {
    const activeEl = getActiveEl();
    if (!activeEl || e.currentTarget !== activeEl) return;

    const s = get(playerState);
    if (!s.isPlaying || s.order.length === 0) return;

    consecutiveErrors += 1;
    if (consecutiveErrors >= s.order.length) {
      consecutiveErrors = 0;
      pausePlayback();
      activeEl.pause();
      stopVolumeLoop();
      suspendAudioKeepAlive();
      return;
    }

    playNext(false);
    const nextState = get(playerState);
    const nextPath = currentTrackPath(nextState);
    if (nextPath) {
      startTrackSync(nextPath);
    }
  }

  function handleNext() {
    const idleEl = getIdleEl();
    if (idleEl && !idleEl.paused) {
      idleEl.pause();
    }
    playNext(false);
    const s = get(playerState);
    const nextPath = currentTrackPath(s);
    if (nextPath && s.isPlaying) {
      startTrackSync(nextPath);
    }
  }

  function handlePrev() {
    const idleEl = getIdleEl();
    if (idleEl && !idleEl.paused) {
      idleEl.pause();
    }
    playPrev();
    const s = get(playerState);
    const prevPath = currentTrackPath(s);
    if (prevPath && s.isPlaying) {
      startTrackSync(prevPath);
    }
  }

  function handleTogglePlay() {
    togglePlay();
    const s = get(playerState);
    const activeEl = getActiveEl();
    const idleEl = getIdleEl();
    if (!activeEl) return;

    if (s.isPlaying) {
      const cur = currentTrackPath(s);
      if (cur) {
        const curSrc = convertFileSrc(cur);
        if (activeEl.getAttribute("src") !== curSrc) {
          activeEl.src = curSrc;
        }
        void activeEl.play().catch(() => {});
        ensureAudioKeepAlive();
        startVolumeLoop();
        preloadNextTrack(s);
      }
    } else {
      activeEl.pause();
      if (idleEl) idleEl.pause();
      suspendAudioKeepAlive();
      stopVolumeLoop();
    }
    updateMediaSessionSync(currentPath, s.isPlaying);
  }

  function handleStopPlayer() {
    stopPlayer();
    stopVolumeLoop();
    crossfadeTriggered = false;
    if (audioElA) {
      audioElA.pause();
      audioElA.removeAttribute("src");
      audioElA.load();
    }
    if (audioElB) {
      audioElB.pause();
      audioElB.removeAttribute("src");
      audioElB.load();
    }
    suspendAudioKeepAlive();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  }

  function handleTimeUpdate(e: Event) {
    updateVolumes();
    const activeEl = getActiveEl();
    if (!activeEl || e.currentTarget !== activeEl) return;
    reportProgress(activeEl.currentTime, activeEl.duration || 0);
    updateMediaSessionPosition(activeEl.currentTime, activeEl.duration || 0);
    checkCrossfade(activeEl);
  }

  function handleLoadedMetadata(e: Event) {
    updateVolumes();
    const activeEl = getActiveEl();
    if (!activeEl || e.currentTarget !== activeEl) return;
    reportProgress(activeEl.currentTime, activeEl.duration || 0);
    updateMediaSessionPosition(activeEl.currentTime, activeEl.duration || 0);
  }

  function handlePlaying(e: Event) {
    const activeEl = getActiveEl();
    if (e.currentTarget === activeEl) {
      consecutiveErrors = 0;
      ensureAudioKeepAlive();
      startVolumeLoop();
    }
  }

  function handleSeek(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    const activeEl = getActiveEl();
    if (activeEl) {
      activeEl.currentTime = value;
      updateVolumes();
      reportProgress(value, $playerState.duration);
      updateMediaSessionPosition(value, $playerState.duration);
    }
  }

  function handleVolume(e: Event) {
    const newVol = Number((e.target as HTMLInputElement).value);
    setVolume(newVol);
    updateVolumes();
  }

  function formatTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  // Volume synchronization across both audio elements
  $effect(() => {
    void $playerState.volume;
    updateVolumes();
  });

  // Track state changes initiated outside MiniPlayer (e.g., clicking a song in FileList)
  let lastHandledPath: string | null = null;
  let lastHandledPlaying = false;

  $effect(() => {
    const path = currentPath;
    const playing = isPlaying;
    const activeEl = getActiveEl();

    if (path !== lastHandledPath || playing !== lastHandledPlaying) {
      lastHandledPath = path;
      lastHandledPlaying = playing;

      if (path && activeEl) {
        const targetSrc = convertFileSrc(path);
        if (activeEl.getAttribute("src") !== targetSrc) {
          activeEl.src = targetSrc;
          activeEl.currentTime = 0;
          activeEl.volume = $playerState.volume;
        }
        if (playing) {
          void activeEl.play().catch(() => {});
          ensureAudioKeepAlive();
          startVolumeLoop();
        } else {
          activeEl.pause();
          suspendAudioKeepAlive();
          stopVolumeLoop();
        }
        preloadNextTrack($playerState);
        updateMediaSessionSync(path, playing);
      }
    }
  });

  // Update preload buffer when shuffle, repeat, or playlist order changes
  $effect(() => {
    void $playerState.shuffle;
    void $playerState.repeat;
    void $playerState.order;
    preloadNextTrack($playerState);
  });

  // Cleanup volume animation on unmount
  $effect(() => {
    return () => {
      stopVolumeLoop();
      suspendAudioKeepAlive();
    };
  });

  // Media Session action handler registration
  $effect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", () => handleTogglePlay());
    navigator.mediaSession.setActionHandler("pause", () => handleTogglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => handlePrev());
    navigator.mediaSession.setActionHandler("nexttrack", () => handleNext());
    navigator.mediaSession.setActionHandler("stop", () => handleStopPlayer());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      const activeEl = getActiveEl();
      if (activeEl && details.seekTime != null) {
        activeEl.currentTime = details.seekTime;
        updateVolumes();
        reportProgress(details.seekTime, $playerState.duration);
        updateMediaSessionPosition(details.seekTime, $playerState.duration);
      }
    });
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const activeEl = getActiveEl();
      if (activeEl) {
        const skipTime = details.seekOffset || 10;
        const newTime = Math.max(activeEl.currentTime - skipTime, 0);
        activeEl.currentTime = newTime;
        updateVolumes();
        reportProgress(newTime, $playerState.duration);
        updateMediaSessionPosition(newTime, $playerState.duration);
      }
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const activeEl = getActiveEl();
      if (activeEl) {
        const skipTime = details.seekOffset || 10;
        const newTime = Math.min(activeEl.currentTime + skipTime, activeEl.duration || 0);
        activeEl.currentTime = newTime;
        updateVolumes();
        reportProgress(newTime, $playerState.duration);
        updateMediaSessionPosition(newTime, $playerState.duration);
      }
    });

    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("stop", null);
      navigator.mediaSession.setActionHandler("seekto", null);
      navigator.mediaSession.setActionHandler("seekbackward", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
    };
  });
</script>

{#if currentPath}
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio
    bind:this={audioElA}
    preload="auto"
    onended={handleEnded}
    onerror={handleError}
    onplaying={handlePlaying}
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={handleLoadedMetadata}
  ></audio>
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio
    bind:this={audioElB}
    preload="auto"
    onended={handleEnded}
    onerror={handleError}
    onplaying={handlePlaying}
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={handleLoadedMetadata}
  ></audio>
  <div class="mini-player">
    <div class="track-info" title={currentPath}>
      <span class="track-name">{trackName}</span>
      <span class="track-position">{$playerState.position + 1}/{$playerState.playlist.length}</span>
    </div>

    <div class="controls">
      <button class="tool-btn" class:active={$playerState.shuffle} onclick={toggleShuffle} title={$_("audio.shuffle")}>
        <Shuffle size={16} strokeWidth={2.4} />
      </button>
      <button class="tool-btn" onclick={handlePrev} title={$_("audio.previous")}>
        <SkipBack size={16} strokeWidth={2.4} fill="currentColor" />
      </button>
      <button class="tool-btn play-btn" onclick={handleTogglePlay} title={$playerState.isPlaying ? "Pause" : "Play"}>
        {#if $playerState.isPlaying}
          <Pause size={16} strokeWidth={2.4} fill="currentColor" />
        {:else}
          <Play size={16} strokeWidth={2.4} fill="currentColor" />
        {/if}
      </button>
      <button class="tool-btn" onclick={handleNext} title={$_("audio.next")}>
        <SkipForward size={16} strokeWidth={2.4} fill="currentColor" />
      </button>
      <button class="tool-btn" class:active={$playerState.repeat !== "off"} onclick={cycleRepeat} title={$_("audio.repeat")}>
        {#if $playerState.repeat === "one"}
          <Repeat1 size={16} strokeWidth={2.4} />
        {:else}
          <Repeat size={16} strokeWidth={2.4} />
        {/if}
      </button>
    </div>

    <div class="seek-row">
      <span class="time">{formatTime($playerState.currentTime)}</span>
      <input
        class="seek"
        type="range"
        min="0"
        max={$playerState.duration || 0}
        step="0.1"
        value={$playerState.currentTime}
        oninput={handleSeek}
      />
      <span class="time">{formatTime($playerState.duration)}</span>
    </div>

    <input class="volume" type="range" min="0" max="1" step="0.01" value={$playerState.volume} oninput={handleVolume} title={$_("audio.volume")} />

    <button class="tool-btn close-btn" onclick={handleStopPlayer} title={$_("audio.stop")}>✕</button>
  </div>
{/if}

<style>
  .mini-player {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 14px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-size: 12px;
  }

  .track-info {
    display: flex;
    flex-direction: column;
    min-width: 140px;
    max-width: 220px;
    overflow: hidden;
  }

  .track-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--color-nc-text-bright);
  }

  .track-position {
    color: var(--color-nc-text-dim);
    font-size: 10px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .tool-btn {
    appearance: none;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .tool-btn :global(svg) {
    display: block;
  }

  .tool-btn.active {
    color: var(--color-nc-accent);
    border-color: var(--color-nc-accent);
  }

  .play-btn {
    min-width: 32px;
  }

  .seek-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .time {
    color: var(--color-nc-text-dim);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    flex-shrink: 0;
  }

  .seek {
    flex: 1;
    min-width: 60px;
  }

  .volume {
    width: 80px;
    flex-shrink: 0;
  }

  .close-btn {
    flex-shrink: 0;
  }
</style>
