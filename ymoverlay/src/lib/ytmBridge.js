import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { note } from "./overlayDiag.js";

/**
 * Runs a JS string inside the hidden "main" window via the `ytm_eval`
 * Tauri command (see src-tauri/src/main.rs). Every function below just
 * builds a small, self-contained script and fires it off - nothing here
 * executes in this window, it all runs on music.youtube.com.
 *
 * FRAGILITY NOTE: functions below are grouped by confidence. The
 * transport/volume/track-select ones target stable, easy-to-verify
 * selectors (the <video> element, the queue item list) and should hold
 * up well. The sidebar playlist ones (fetchPlaylists, playPlaylist) run
 * on markup verified in devtools (see ytm-watcher.js). The
 * Playlist saving uses the native picker and DOM helpers in ytm-watcher.js.
 */
function evalInMain(script) {
  note("ytm_eval");
  return invoke("ytm_eval", { script }).catch((error) => {
    return emit("ytm://error", String(error)).catch(console.error);
  });
}

// ---------------------------------------------------------------------
// Transport - high confidence
// ---------------------------------------------------------------------

export function togglePlay() {
  return evalInMain(`
    (function () {
      const btn =
        document.querySelector("#play-pause-button") ||
        document.querySelector("tp-yt-paper-icon-button#play-pause-button");
      if (btn) btn.click();
    })();
  `);
}

export function next() {
  return evalInMain(`
    (function () {
      const btn =
        document.querySelector(".next-button") ||
        document.querySelector("#next-button");
      if (btn) btn.click();
    })();
  `);
}

export function prev() {
  return evalInMain(`
    (function () {
      const btn =
        document.querySelector(".previous-button") ||
        document.querySelector("#previous-button");
      if (btn) btn.click();
    })();
  `);
}

/** Relative skip, e.g. skip(15) or skip(-15). */
export function skip(deltaSeconds) {
  return evalInMain(`
    (function () {
      const video = document.querySelector("video");
      if (!video || !isFinite(video.duration)) return;
      const target = Math.max(0, Math.min(video.duration, video.currentTime + (${deltaSeconds})));
      video.currentTime = target;
    })();
  `);
}

/** Seek using a fresh page-side reading, rather than a stale overlay tick. */
export function seekTo(targetSeconds) {
  return evalInMain(`window.__ymoverlay.seekTo(${JSON.stringify(targetSeconds)})`);
}

/** percent: 0-100. Routes through window.__ymoverlay.setTargetVolume,
 *  which is the enforced target the watcher's own interval + volumechange
 *  listener continuously re-applies (see ytm-watcher.js) - a plain
 *  one-shot video.volume assignment doesn't hold, since YTM's internal
 *  player object re-syncs the element from its own state roughly every
 *  60s and on every track change, silently overwriting a bare assignment
 *  within moments. Falls back to a direct assignment only in the
 *  unlikely case the watcher script hasn't installed yet. */
export function setVolume(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  return evalInMain(`
    (function () {
      if (window.__ymoverlay && window.__ymoverlay.setTargetVolume) {
        window.__ymoverlay.setTargetVolume(${clamped});
        return;
      }
      const video = document.querySelector("video");
      if (!video) return;
      video.volume = ${clamped} / 100;
      if (video.muted && ${clamped} > 0) video.muted = false;
    })();
  `);
}

/** Tells the watcher whether the overlay's own queue dropdown is
 *  currently open, so it can skip its (comparatively expensive) queue
 *  DOM scan entirely while nobody's looking at the list - see the big
 *  comment on queuePanelOpen/tick() in ytm-watcher.js. */
export function setQueuePanelOpen(open) {
  return evalInMain(`
    (function () {
      if (window.__ymoverlay && window.__ymoverlay.setQueuePanelOpen) {
        window.__ymoverlay.setQueuePanelOpen(${open ? "true" : "false"});
      }
    })();
  `);
}

export function setPlaylistsPanelOpen(open) {
  return evalInMain(`if (window.__ymoverlay) window.__ymoverlay.playlistsPanelOpen = ${!!open};`);
}

// ---------------------------------------------------------------------
// Queue references are stable IDs assigned by the watcher.
// ---------------------------------------------------------------------

export function selectQueueItem(index) {
  return evalInMain(`
    (function () {
      const el = window.__ymoverlay.getQueueItem(${JSON.stringify(index)});
      if (!el) return;

      const candidates = [
        el.querySelector(".song-info"),
        el.querySelector(".thumbnail-and-text"),
        el.querySelector("[role='button']"),
        el.shadowRoot && el.shadowRoot.querySelector("#thumbnail, .song-info, [role='button']"),
      ].filter(Boolean);

      // One bubbling click reaches both the inner control and its host.
      (candidates[0] || el).click();
    })();
  `);
}

// ---------------------------------------------------------------------
// Playlist picker: the watcher owns DOM discovery, choice identity and errors.
// ---------------------------------------------------------------------

export function addQueueItemToPlaylist(index) {
  return evalInMain(`window.__ymoverlay.openPlaylistPicker(${JSON.stringify(index)})`);
}

export function confirmAddToPlaylist(id) {
  return evalInMain(`window.__ymoverlay.confirmPlaylistChoice(${JSON.stringify(id)})`);
}

export function cancelAddToPlaylist() {
  return evalInMain('window.__ymoverlay.cancelPlaylistChoice()');
}

// ---------------------------------------------------------------------
// Playlists panel - sidebar only, no navigation. All DOM logic lives in
// ytm-watcher.js (window.__ymoverlay.getSidebarPlaylistEntries /
// emitPlaylists / playSidebarPlaylist) so discovery and playback share
// one source of truth; these two functions only trigger it.
// ---------------------------------------------------------------------

/** Reads the playlists out of YTM's persistent left sidebar and emits
 *  "ytm://playlists" with [{ id, index, href, title, author }]. */
export function fetchPlaylists() {
  return evalInMain(`
    (function () {
      if (window.__ymoverlay) window.__ymoverlay.emitPlaylists();
    })();
  `);
}

/** Starts a playlist by driving its own sidebar row: finds the
 *  <ytmusic-guide-entry-renderer> again by { id, index }, simulates the
 *  hover, then clicks its <ytmusic-play-button-renderer>. `playlist` is
 *  an item from the "ytm://playlists" payload. (Shuffle path: no page
 *  navigation.) If the row disappeared, the watcher re-emits a fresh list.
 *  `opts.shuffle === false` ("Play sequentially") can't use the row's Play
 *  button (it always shuffles): the watcher opens the playlist page through
 *  YTM's own navigation and clicks that page's in-order Play instead - see
 *  playEntrySequentially() in ytm-watcher.js. Anything else uses the row's
 *  Play button, as before. */
export function playPlaylist(playlist, opts) {
  const ref = {
    id: playlist.id,
    index: playlist.index,
    title: playlist.title,
  };
  const o = opts && typeof opts.shuffle === "boolean" ? { shuffle: opts.shuffle } : null;
  return evalInMain(`
    (function () {
      if (window.__ymoverlay) window.__ymoverlay.playSidebarPlaylist(${JSON.stringify(ref)}, ${JSON.stringify(o)});
    })();
  `);
}
