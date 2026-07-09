import { writable, get } from "svelte/store";

// Kept in sync with AUDIO_EXTENSIONS in server/lib/file-preview.js.
export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"
]);

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export type RepeatMode = "off" | "all" | "one";

export interface PlayerState {
  playlist: string[];
  order: number[];
  position: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  currentTime: number;
  duration: number;
  volume: number;
}

const initialState: PlayerState = {
  playlist: [],
  order: [],
  position: -1,
  isPlaying: false,
  shuffle: false,
  repeat: "off",
  currentTime: 0,
  duration: 0,
  volume: 1,
};

export const playerState = writable<PlayerState>(initialState);

export function currentTrackPath(state: PlayerState): string | null {
  if (state.position < 0 || state.position >= state.order.length) return null;
  return state.playlist[state.order[state.position]] ?? null;
}

function buildOrder(length: number, shuffle: boolean, keepFirstIndex?: number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  if (!shuffle) return indices;
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  if (keepFirstIndex !== undefined) {
    const at = indices.indexOf(keepFirstIndex);
    if (at > 0) {
      [indices[0], indices[at]] = [indices[at], indices[0]];
    }
  }
  return indices;
}

/** Start (or replace) the persistent playlist and begin playback at startPath. */
export function playPlaylist(paths: string[], startPath: string) {
  const playlist = paths.filter(isAudioPath);
  const startIndex = playlist.indexOf(startPath);
  const safeStartIndex = startIndex >= 0 ? startIndex : 0;
  if (playlist.length === 0) return;

  playerState.update((s) => {
    const order = buildOrder(playlist.length, s.shuffle, safeStartIndex);
    const position = order.indexOf(safeStartIndex);
    return { ...s, playlist, order, position, isPlaying: true, currentTime: 0, duration: 0 };
  });
}

export function togglePlay() {
  playerState.update((s) => (s.playlist.length === 0 ? s : { ...s, isPlaying: !s.isPlaying }));
}

export function stopPlayer() {
  const s = get(playerState);
  playerState.set({ ...initialState, volume: s.volume, shuffle: s.shuffle, repeat: s.repeat });
}

export function playNext(fromAutoAdvance = false) {
  playerState.update((s) => {
    if (s.playlist.length === 0) return s;
    if (fromAutoAdvance && s.repeat === "one") {
      return { ...s, currentTime: 0, isPlaying: true };
    }
    let nextPos = s.position + 1;
    if (nextPos >= s.order.length) {
      if (s.repeat === "all") {
        nextPos = 0;
      } else {
        return { ...s, isPlaying: false };
      }
    }
    return { ...s, position: nextPos, currentTime: 0, isPlaying: true };
  });
}

export function playPrev() {
  playerState.update((s) => {
    if (s.playlist.length === 0) return s;
    let prevPos = s.position - 1;
    if (prevPos < 0) {
      prevPos = s.repeat === "all" ? s.order.length - 1 : 0;
    }
    return { ...s, position: prevPos, currentTime: 0, isPlaying: true };
  });
}

export function toggleShuffle() {
  playerState.update((s) => {
    const shuffle = !s.shuffle;
    const currentTrackIndex = s.position >= 0 ? s.order[s.position] : undefined;
    const order = buildOrder(s.playlist.length, shuffle, currentTrackIndex);
    const position = currentTrackIndex !== undefined ? order.indexOf(currentTrackIndex) : s.position;
    return { ...s, shuffle, order, position };
  });
}

export function cycleRepeat() {
  playerState.update((s) => {
    const nextRepeat: RepeatMode = s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off";
    return { ...s, repeat: nextRepeat };
  });
}

export function setVolume(volume: number) {
  playerState.update((s) => ({ ...s, volume }));
}

export function reportProgress(currentTime: number, duration: number) {
  playerState.update((s) => ({ ...s, currentTime, duration }));
}
