import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import * as ytm from "../lib/ytmBridge.js";
import { isScrolling, onScrollIdle } from "../lib/scrollGate.js";

const PLACEHOLDER_ART =
  "https://placehold.co/96x96/1a1f2b/8891a5?text=%E2%99%AB";

const EMPTY_TRACK = {
  title: "Nothing playing",
  artist: "Open YouTube Music to begin",
  art: PLACEHOLDER_ART,
};

// Fixed window heights for the collapsed vs. expanded (queue/playlists
// panel open) states. Kept as constants rather than dynamically measured,
// since the panel area itself is a fixed-height scroll region either way
// (see App.jsx) - this keeps the resize logic simple and deterministic.
// Tune these two numbers if you change padding/font sizes in App.jsx.
const WINDOW_WIDTH = 360;
const COLLAPSED_HEIGHT = 380;
const EXPANDED_HEIGHT = 620;
// Must match the CSS transition duration on the collapsing panel in
// App.jsx, so we don't shrink the window out from under an animation
// that's still running.
export const PANEL_TRANSITION_MS = 300;

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

// Volume persistence across app restarts. Deliberately plain localStorage
// on the OVERLAY window's own origin - NOT the same thing as the
// yt-player-volume key ytm-watcher.js reads/writes inside the hidden
// "main" window's localStorage (that one is YTM's own internal storage,
// on a completely different origin/webview; this one is ours, private to
// this app, and is what actually survives between launches).
const VOLUME_STORAGE_KEY = "ymoverlay:volume";

function loadPersistedVolume() {
  try {
    const saved = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (saved === null) return null;
    const parsed = parseInt(saved, 10);
    return isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
  } catch (e) {
    return null; // storage unavailable (rare) - just fall back to page default
  }
}

function persistVolume(percent) {
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(percent));
  } catch (e) {
    /* non-fatal - persistence just won't work this session */
  }
}


// Structural sharing for list payloads (queue / playlists).
// The watcher sends fresh plain objects on every change. Replacing the
// whole array with them re-renders EVERY row (React.memo compares object
// identity) even when only one row differs - and does it while the user
// may be scrolling. This keeps the previous array (and previous row
// objects) whenever the content is unchanged, so an identical payload is a
// complete no-op and a partial change touches only the rows that changed.
function sameRow(a, b) {
  for (const k in b) if (a[k] !== b[k]) return false;
  for (const k in a) if (!(k in b)) return false;
  return true;
}

function mergeList(prev, next) {
  let changed = prev.length !== next.length;
  const merged = next.map((row, i) => {
    const old = prev[i];
    if (old && sameRow(old, row)) return old;
    changed = true;
    return row;
  });
  return changed ? merged : prev;
}

async function resizeWindow(height) {
  try {
    await getCurrentWindow().setSize(new LogicalSize(WINDOW_WIDTH, height));
  } catch (e) {
    // Non-fatal - the window just won't resize (e.g. running outside Tauri
    // during plain `vite dev` in a browser tab). Everything else still works.
  }
}

// Matches "alwaysOnTop": true in tauri.conf.json, i.e. what the window
// actually launches as - kept as the initial React state below so the
// pin button's displayed state always starts in sync with reality rather
// than guessing.
const INITIAL_PINNED = true;

export function usePlaybackState() {
  const [track, setTrack] = useState(EMPTY_TRACK);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Restored once, synchronously, on first render - avoids a flash of
  // "100" before an effect has a chance to run.
  const persistedVolumeOnMount = useRef(loadPersistedVolume());
  const [volume, setVolumeState] = useState(
    () => persistedVolumeOnMount.current ?? 100
  );
  const [queue, setQueue] = useState([]);
  // Mirrors `queue` for reads inside callbacks that must stay
  // referentially stable (see selectTrack below) - without this, giving
  // selectTrack a `[queue]` dependency would mint a brand new function
  // every time the queue list updates, which breaks QueueRow's
  // React.memo for every single row (not just the one that changed) on
  // every queue tick, right as the user is scrolling/clicking it.
  const queueRef = useRef([]);
  const [isPinned, setIsPinned] = useState(INITIAL_PINNED);

  // "closed" | "queue" | "playlists" - mutually exclusive, drives both the
  // collapsible panel content and the native window height. Starts open
  // to match the window's initial height in tauri.conf.json.
  const [panelMode, setPanelMode] = useState("queue");

  const [playlists, setPlaylists] = useState([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  // Mirrors `playlists` so togglePlaylistsPanel can tell "already loaded"
  // without a dependency (keeps that callback stable).
  const playlistsRef = useRef([]);

  // Options offered by the in-progress "add to playlist" flow for a given
  // queue row index; null when no picker is open.
  const [addToPlaylistPrompt, setAddToPlaylistPrompt] = useState(null);

  // While the user is actively dragging the scrub bar, ignore incoming
  // currentTime updates so the thumb doesn't jump under their finger.
  const isScrubbing = useRef(false);

  // The volume the user actually wants, as opposed to whatever the page
  // happens to report. Some players reset <video>.volume to 1 on a track
  // change - we treat our own last explicit setVolume() as truth and
  // re-push it whenever the track changes, rather than trusting every
  // tick's reported value.
  const desiredVolumeRef = useRef(persistedVolumeOnMount.current ?? 100);
  const hasSyncedInitialVolume = useRef(persistedVolumeOnMount.current !== null);

  // The last CONFIRMED elapsed-in-track reading, straight from the watcher
  // - always kept up to date, even while isScrubbing suppresses the visible
  // currentTime state. commitSeek needs this rather than the `currentTime`
  // state: while dragging, `currentTime` has already been overwritten with
  // the user's in-progress preview position (see seek() below), so by the
  // time a tap/release fires it no longer reflects where playback actually
  // is - only this ref still does.
  const lastKnownElapsedRef = useRef(0);

  // Anchor for the local progress-bar interpolator below: the last
  // (elapsed-in-track, wall-clock-when-we-learned-it) pair we actually
  // trust, from either a real ytm://tick or one of our own optimistic
  // updates (skip/seek). Deliberately separate from lastKnownElapsedRef,
  // which only ever holds CONFIRMED values - this one is allowed to hold
  // an optimistic guess too, since the interpolator's job is to look
  // smooth, not to be a second source of truth.
  const tickAnchorRef = useRef({ value: 0, wallClockMs: Date.now() });

  useEffect(() => {
    if (persistedVolumeOnMount.current !== null) {
      // We already know what the user wants - push it immediately rather
      // than waiting for/trusting whatever the page itself currently
      // reports (which is exactly the ytm://tick first-sync branch below,
      // deliberately skipped in this case since hasSyncedInitialVolume
      // already starts true). ytm.setVolume routes through the page's
      // own continuously-enforced target, so this is safe to fire even
      // before the hidden window has fully finished loading.
      ytm.setVolume(persistedVolumeOnMount.current);
    }
  }, []);

  useEffect(() => {
    let pendingQueue = null;
    let pendingPlaylists = null;

    function applyQueue(items) {
      // mergeList returns the SAME array when nothing changed, so both the
      // ref and setState below are no-ops for an identical payload.
      const merged = mergeList(queueRef.current, items);
      queueRef.current = merged;
      setQueue(merged);
    }
    function applyPlaylists(items) {
      const merged = mergeList(playlistsRef.current, items);
      playlistsRef.current = merged;
      setPlaylists(merged);
      setPlaylistsLoading(false);
    }
    const offScrollIdle = onScrollIdle(() => {
      if (pendingQueue) {
        const items = pendingQueue;
        pendingQueue = null;
        applyQueue(items);
      }
      if (pendingPlaylists) {
        const items = pendingPlaylists;
        pendingPlaylists = null;
        applyPlaylists(items);
      }
    });

    const unlisten = [
      listen("ytm://tick", (event) => {
        const s = event.payload;
        setIsPlaying(!!s.isPlaying);
        setDuration(s.duration || 0);
        lastKnownElapsedRef.current = s.currentTime || 0;
        tickAnchorRef.current = { value: s.currentTime || 0, wallClockMs: Date.now() };
        if (!isScrubbing.current) {
          setCurrentTime(s.currentTime || 0);
        }
        // Only adopt the page's reported volume once, to initialize -
        // after that we drive volume ourselves (see setVolume and the
        // ytm://track handler below), so a mid-song or track-change
        // reset on the page's side doesn't fight the user's chosen level.
        if (!hasSyncedInitialVolume.current) {
          const initial = Math.round((s.volume ?? 1) * 100);
          setVolumeState(initial);
          desiredVolumeRef.current = initial;
          hasSyncedInitialVolume.current = true;
          // Seed the page-side enforcement target immediately - YTM's
          // periodic volume reset isn't triggered by user interaction,
          // so without this, playback would be unguarded until the user
          // happened to touch the volume slider themselves.
          ytm.setVolume(initial);
          // First-ever launch (no persisted value yet) - remember this as
          // the baseline so the NEXT launch restores it instead of
          // re-adopting whatever the page happens to report then.
          persistVolume(initial);
        }
      }),
      listen("ytm://track", (event) => {
        const s = event.payload;
        setTrack({
          title: s.title || EMPTY_TRACK.title,
          artist: s.artist || "",
          art: s.art || PLACEHOLDER_ART,
        });
        // Re-apply the user's chosen volume in case the new track's
        // player element reset it to a default.
        if (hasSyncedInitialVolume.current) {
          ytm.setVolume(desiredVolumeRef.current);
        }
      }),
      listen("ytm://queue", (event) => {
        // Queue rows are text-only (title/artist) - no art on this payload
        // at all anymore, see ytm-watcher.js's readQueue().
        const items = Array.isArray(event.payload) ? event.payload : [];
        // Never swap rows under the user's finger: while a list is being
        // scrolled, only remember the newest payload; it is applied by
        // onScrollIdle below the moment scrolling stops.
        if (isScrolling()) {
          pendingQueue = items;
          return;
        }
        applyQueue(items);
      }),
      listen("ytm://playlists", (event) => {
        const items = Array.isArray(event.payload) ? event.payload : [];
        if (isScrolling()) {
          pendingPlaylists = items;
          return;
        }
        applyPlaylists(items);
      }),
      listen("ytm://add-to-playlist-options", (event) => {
        setAddToPlaylistPrompt(event.payload);
      }),
    ];

    return () => {
      offScrollIdle();
      unlisten.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // --- transport -------------------------------------------------------

  // Tells the watcher whether the queue dropdown is open, so it can
  // skip its DOM scan entirely while closed - see the freeze-mitigation
  // notes on queuePanelOpen/tick() in ytm-watcher.js. Runs once on
  // mount too (covering the default "queue" panelMode - see
  // useState above), so the watcher's own default (also true) never
  // has to be trusted alone for longer than the first render.
  useEffect(() => {
    ytm.setQueuePanelOpen(panelMode === "queue");
  }, [panelMode]);

  // Local progress-bar interpolation. ytm://tick normally arrives ~once a
  // second from main's own poll - but it stops arriving entirely for as
  // long as main's thread is busy (confirmed via enableDiagnostics(): YTM's
  // own queue re-render on track change can block it for several hundred
  // ms, sometimes back-to-back). Without this, the bar visibly freezes for
  // exactly that long, even though overlay's own renderer never drops a
  // frame - its motion was being driven by one specific event arriving,
  // not by wall-clock time actually passing.
  // This can't fix the real delay (main is still genuinely busy, and the
  // actual next/prev/seek command still has to wait its turn there - see
  // the long-task investigation), but it decouples what the user SEES from
  // whether that event has arrived yet: the bar keeps moving on its own
  // between ticks, anchored to the last confirmed (or optimistic) reading,
  // and every real tick simply resets the anchor - which both corrects any
  // drift and absorbs whatever gap a freeze left behind in one smooth
  // catch-up instead of a visible stall-then-jump.
  useEffect(() => {
    const id = setInterval(() => {
      if (!isPlaying || isScrubbing.current) return;
      const { value, wallClockMs } = tickAnchorRef.current;
      const predicted = value + (Date.now() - wallClockMs) / 1000;
      setCurrentTime((current) => {
        // Never predict past the track's own end, and never predict
        // BACKWARDS past whatever's already showing (a real tick that
        // just landed always wins - this only ever fills gaps forward).
        const clamped = duration > 0 ? Math.min(predicted, duration) : predicted;
        return clamped > current ? clamped : current;
      });
    }, 200);
    return () => clearInterval(id);
  }, [isPlaying, duration]);

  const togglePlay = useCallback(() => {
    setIsPlaying((p) => !p); // optimistic; next tick confirms/corrects
    ytm.togglePlay();
  }, []);

  const next = useCallback(() => ytm.next(), []);
  const prev = useCallback(() => ytm.prev(), []);

  const skipForward15 = useCallback(() => {
    setCurrentTime((t) => {
      const next = duration ? Math.min(duration, t + 15) : t + 15;
      tickAnchorRef.current = { value: next, wallClockMs: Date.now() };
      return next;
    });
    ytm.skip(15);
  }, [duration]);

  const skipBack15 = useCallback(() => {
    setCurrentTime((t) => {
      const next = Math.max(0, t - 15);
      tickAnchorRef.current = { value: next, wallClockMs: Date.now() };
      return next;
    });
    ytm.skip(-15);
  }, []);

  const seek = useCallback(
    (value) => {
      isScrubbing.current = true;
      setCurrentTime(value * duration);
    },
    [duration]
  );

  // How much short of the track's own end a seek is allowed to land.
  // ytm.seekTo() works by adding the watcher's trackStartOffset (the
  // session-clock reading captured at the moment it POLLED and noticed
  // the title change - see ytm-watcher.js) to a track-relative target.
  // That poll runs once a second, so the offset can be stamped up to
  // ~1s late: the new track's audio may already have been playing for
  // a moment before the watcher catches up and anchors it. That's
  // invisible for a mid-song seek, but a target close enough to "the
  // end" can, once that slop is folded in, cross into the next track's
  // slice of YTM's one continuous session clock - which YTM reads as
  // "this track just finished" and auto-advances immediately, even
  // though the duration we display (read independently from the
  // footer) was correct. Keeping every seek at least this far from the
  // computed end keeps it clear of that slop without giving up any
  // scrubbing range that matters in practice.
  const SEEK_END_SAFETY_MARGIN_SECONDS = 1.2;

  const commitSeek = useCallback(
    (value) => {
      const requested = value * duration;
      const latestSafe = Math.max(0, duration - SEEK_END_SAFETY_MARGIN_SECONDS);
      const target = Math.min(requested, latestSafe);
      tickAnchorRef.current = { value: target, wallClockMs: Date.now() };
      ytm.seekTo(target, lastKnownElapsedRef.current);
      setTimeout(() => {
        isScrubbing.current = false;
      }, 400);
    },
    [duration]
  );

  const setVolume = useCallback((percent) => {
    desiredVolumeRef.current = percent;
    setVolumeState(percent); // optimistic
    ytm.setVolume(percent);
    persistVolume(percent);
  }, []);

  // --- queue -------------------------------------------------------------

  const selectTrack = useCallback((id) => {
    // Reads from the ref, not the `queue` state, so this callback's own
    // identity never changes - see queueRef's comment above. Passed down
    // as QueueRow's onSelect, a stable reference is what lets
    // React.memo actually skip re-rendering the OTHER ~15 rows every
    // time the user picks one.
    const clicked = queueRef.current.find((t) => t.id === id);
    if (!clicked) {
      ytm.selectQueueItem(Number(id));
      return;
    }
    // Optimistic preview: mark it active and show its title/artist
    // immediately, rather than waiting up to 1s for the next watcher
    // tick to confirm the switch. Art isn't part of the queue payload
    // (see ytm-watcher.js's readQueue()), so keep whatever art is
    // currently showing until the real "ytm://track" event - carrying
    // the actual full-res art - lands a moment later.
    setTrack((t) => ({ ...t, title: clicked.title, artist: clicked.artist }));
    // Only touch the two rows whose `active` flag actually changes (the
    // previously active one, and this one) - every other row keeps its
    // exact same object reference, so React.memo bails out on it
    // instead of re-rendering all ~15+ rows for a one-row change.
    setQueue((q) => {
      const next = q.map((t) => {
        if (t.id === id) return t.active ? t : { ...t, active: true };
        return t.active ? { ...t, active: false } : t;
      });
      queueRef.current = next;
      return next;
    });
    ytm.selectQueueItem(Number(id));
  }, []);

  const startAddToPlaylist = useCallback((id) => {
    setAddToPlaylistPrompt({ index: Number(id), options: [], loading: true });
    ytm.addQueueItemToPlaylist(Number(id));
  }, []);

  const confirmAddToPlaylist = useCallback((label) => {
    ytm.confirmAddToPlaylist(label);
    setAddToPlaylistPrompt(null);
  }, []);

  const cancelAddToPlaylist = useCallback(() => {
    setAddToPlaylistPrompt(null);
  }, []);

  // --- panel (queue list / playlists) + window resize --------------------

  const closePanel = useCallback(() => {
    setPanelMode("closed");
    setTimeout(() => resizeWindow(COLLAPSED_HEIGHT), PANEL_TRANSITION_MS);
  }, []);

  const toggleQueuePanel = useCallback(() => {
    setPanelMode((mode) => {
      if (mode === "queue") {
        setTimeout(() => resizeWindow(COLLAPSED_HEIGHT), PANEL_TRANSITION_MS);
        return "closed";
      }
      resizeWindow(EXPANDED_HEIGHT); // grow first so there's room to animate into
      return "queue";
    });
  }, []);

  const togglePlaylistsPanel = useCallback(() => {
    setPanelMode((mode) => {
      if (mode === "playlists") {
        setTimeout(() => resizeWindow(COLLAPSED_HEIGHT), PANEL_TRANSITION_MS);
        return "closed";
      }
      resizeWindow(EXPANDED_HEIGHT);
      if (mode !== "playlists") {
        // Already loaded once? Keep showing it and refresh silently in the
        // background (applyPlaylists merges, so an unchanged list is a
        // no-op). The "Loading..." placeholder only appears the very first
        // time - it used to blank and rebuild the whole list on every open.
        if (playlistsRef.current.length === 0) setPlaylistsLoading(true);
        ytm.fetchPlaylists();
      }
      return "playlists";
    });
  }, []);

  const playPlaylist = useCallback((playlist, opts) => {
    ytm.playPlaylist(playlist, opts);
  }, []);

  // --- pin (always-on-top) -----------------------------------------------

  const togglePin = useCallback(() => {
    setIsPinned((pinned) => {
      const next = !pinned;
      // Optimistic, same pattern as togglePlay/setVolume above - flip the
      // button's own state immediately rather than waiting on a round trip,
      // and let the try/catch below just be a no-op outside Tauri (e.g.
      // plain `vite dev` in a browser tab).
      getCurrentWindow()
        .setAlwaysOnTop(next)
        .catch(() => {
          // Non-fatal - see resizeWindow's comment above for why.
        });
      return next;
    });
  }, []);

  return {
    isPlaying,
    progress: duration > 0 ? currentTime / duration : 0,
    current: {
      ...track,
      elapsed: formatTime(currentTime),
      remaining: `-${formatTime(Math.max(0, duration - currentTime))}`,
    },
    volume,
    setVolume,
    queue,
    togglePlay,
    next,
    prev,
    skipForward15,
    skipBack15,
    seek,
    commitSeek,
    selectTrack,
    startAddToPlaylist,
    confirmAddToPlaylist,
    cancelAddToPlaylist,
    addToPlaylistPrompt,
    panelMode,
    toggleQueuePanel,
    togglePlaylistsPanel,
    closePanel,
    playlists,
    playlistsLoading,
    playPlaylist,
    isPinned,
    togglePin,
  };
}
