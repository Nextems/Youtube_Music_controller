import { invoke } from "@tauri-apps/api/core";
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
 * addQueueItemToPlaylist/confirmAddToPlaylist menu flow depends on
 * transient popup menus whose exact markup can't be inspected live -
 * treat it as a first draft to test against the real DOM.
 */
function evalInMain(script) {
  note("ytm_eval");
  return invoke("ytm_eval", { script });
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

/** Seek to `targetSeconds` INTO THE CURRENT TRACK (the same track-relative
 *  timebase the overlay's UI shows - 0 is the start of the current song),
 *  given `knownElapsedSeconds` - the caller's last CONFIRMED elapsed-in-
 *  track reading (i.e. from the most recent ytm://tick, not an optimistic
 *  drag preview - see commitSeek in usePlaybackState.js).
 *
 *  video.currentTime itself is not track-relative: YTM runs one continuous,
 *  non-resetting clock across the whole queued session (see the TIMER NOTE
 *  in ytm-watcher.js). An earlier version of this function tried to
 *  compensate by reconstructing an absolute session-time target (adding
 *  back a cached per-track start offset maintained by the watcher's
 *  1-second poll) - but that offset can be stale relative to the exact
 *  instant of the seek, and a stale anchor sends the seek to the wrong
 *  place in the session regardless of how far the target is from the
 *  track's edges.
 *
 *  This version sidesteps that cache entirely: it takes the DIFFERENCE
 *  between where we want to be and where we last confirmed we actually
 *  are (both in the same track-relative timebase, so the difference is
 *  offset-independent - the per-track anchor cancels out), then applies
 *  that as a relative adjustment to a video.currentTime read FRESH in
 *  this same call - exactly how skip() already does it reliably above,
 *  just with a computed delta instead of a fixed +/-15. */
export function seekTo(targetSeconds, knownElapsedSeconds) {
  return evalInMain(`
    (function () {
      const video = document.querySelector("video");
      if (!video || !isFinite(${targetSeconds}) || !isFinite(${knownElapsedSeconds})) return;
      const delta = (${targetSeconds}) - (${knownElapsedSeconds});
      video.currentTime = Math.max(0, video.currentTime + delta);
    })();
  `);
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

// ---------------------------------------------------------------------
// Queue - high confidence for selection, since it indexes through the
// exact same window.__ymoverlay.getQueueItems() filtered list the
// watcher's readQueue() uses to build the indices the UI shows.
// ---------------------------------------------------------------------

/** Clicks a specific row in the currently rendered queue panel by index
 *  (matches the index the watcher reported in its ytm://queue payload).
 *  Tries several inner elements before the row itself, since a synthetic
 *  .click() on a custom element only reaches listeners on that element
 *  or its ancestors - if YTM's real "play this" handler lives on an
 *  inner child (a common pattern), clicking only the outer host would
 *  silently do nothing. */
export function selectQueueItem(index) {
  return evalInMain(`
    (function () {
      // Must use the SAME filtered list the watcher's readQueue() reports
      // indices against (window.__ymoverlay.getQueueItems), not a raw
      // querySelectorAll - YTM renders hidden/duplicate queue-item nodes
      // that throw off raw DOM indices vs. the visible list the UI shows.
      const items = window.__ymoverlay.getQueueItems();
      const el = items[${index}];
      if (!el) return;

      const candidates = [
        el.querySelector(".song-info"),
        el.querySelector(".thumbnail-and-text"),
        el.querySelector("[role='button']"),
        el.shadowRoot && el.shadowRoot.querySelector("#thumbnail, .song-info, [role='button']"),
      ].filter(Boolean);

      candidates.forEach((c) => c.click());
      // Always also click the row itself, in case the real handler is on
      // the host element (or uses event delegation from a parent).
      el.click();
    })();
  `);
}

// ---------------------------------------------------------------------
// Track overflow menu ("Add to playlist") - EXPERIMENTAL.
// Simulates the exact path a real user takes in YTM's own UI: opens
// that queue row's own "..." button, then clicks its "Add to playlist"
// (aka "Save to playlist") item. Both lookups are LANGUAGE-INDEPENDENT
// (see findRowMenuButton/findAddToPlaylistMenuItem in ytm-watcher.js) -
// neither depends on a hardcoded English string, so this holds up
// regardless of which language YTM's UI is currently displaying.
// ---------------------------------------------------------------------

function openAddToPlaylistMenuScript(index) {
  return `
    (function () {
      try {
        const items = window.__ymoverlay.getQueueItems();
        const el = items[${index}];
        if (!el) return;
        const menuBtn = window.__ymoverlay.findRowMenuButton(el);
        if (menuBtn) menuBtn.click();
      } catch (e) {}
    })();
  `;
}

/** Opens the row's own "..." menu (in the real YTM UI), clicks its "add
 *  to playlist" item, then scrapes whatever picker/dialog appears and
 *  emits its options back as "ytm://add-to-playlist-options"
 *  ({ index, options: [{ label }] }). Call confirmAddToPlaylist(label)
 *  next, while that picker is still open. */
export async function addQueueItemToPlaylist(index) {
  await evalInMain(openAddToPlaylistMenuScript(index));
  return evalInMain(`
    (async function () {
      await window.__ymoverlay.wait(300);
      const menuRoot = window.__ymoverlay.findDialogRoot();
      const target = window.__ymoverlay.findAddToPlaylistMenuItem(menuRoot);
      if (target) target.click();

      // The add-to-playlist dialog often fetches the user's playlists
      // before rendering, so give it a couple of chances rather than one
      // fixed wait.
      let options = [];
      for (let attempt = 0; attempt < 3 && options.length === 0; attempt++) {
        await window.__ymoverlay.wait(400);
        try {
          const root = window.__ymoverlay.findDialogRoot();
          const optionEls = Array.from(
            root.querySelectorAll(
              "ytmusic-playlist-add-to-option-renderer, tp-yt-paper-item, ytmusic-menu-navigation-item-renderer"
            )
          ).filter((el) => el.offsetParent !== null);
          options = optionEls
            .map((el) => ({ label: el.textContent.trim() }))
            .filter((o) => o.label);
        } catch (e) {
          options = [];
        }
      }

      window.__TAURI__.event.emit("ytm://add-to-playlist-options", {
        index: ${index},
        options: options.slice(0, 20),
      });
    })();
  `);
}

/** Clicks the option matching `label` in the currently-open add-to-playlist
 *  picker (call right after addQueueItemToPlaylist resolves). Scoped to
 *  the actual dialog root rather than the whole document, so it can't
 *  accidentally match similar text elsewhere on the page (e.g. the
 *  sidebar) instead of the real checkbox/option. Matching against
 *  `label` here is NOT a locale concern - it's the exact playlist NAME
 *  the user themselves picked from our own scraped list, not translated
 *  YTM UI chrome. */
export function confirmAddToPlaylist(label) {
  return evalInMain(`
    (function () {
      const root = window.__ymoverlay.findDialogRoot();
      window.__ymoverlay.clickByTextIn(
        root,
        ["ytmusic-playlist-add-to-option-renderer", "tp-yt-paper-item", "ytmusic-menu-navigation-item-renderer"],
        ${JSON.stringify(label)}
      );
    })();
  `);
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
