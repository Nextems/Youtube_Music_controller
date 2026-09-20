// OPT-IN diagnostics for the OVERLAY window (the counterpart of
// window.__ymoverlay.enableDiagnostics(), which lives in - and only sees -
// the YTM window). Zero cost until enabled.
//
// Use: right-click the overlay -> Inspect -> Console:
//     window.__ovDiag.enable()
// then scroll the list until it freezes. It prints, in this window's console:
//
//   scroll response Xms   time from a wheel tick to the first scroll event.
//                         THIS is the freeze as the user feels it.
//   wheel latency Xms     how late the wheel event reached the page after the
//                         OS produced it (performance.now() - event.timeStamp).
//   long task Xms         overlay's own main thread was busy.
//   frame gap Xms         overlay's own frames stopped (rAF gap).
//
// and, after a slow wheel/scroll, the last few things that happened just
// before it: Tauri events received from YTM (ytm://tick/queue/...) and
// ytm_eval commands sent to it, each with its age.
//
// How to read it:
//   * scroll response / wheel latency high, NO long task, NO frame gap
//       -> the overlay's own JS/render is healthy; the input was held up
//          BEFORE reaching this page (host window thread, browser process,
//          GPU shared with the YTM window). Look at the "recent" list for
//          a repeating culprit (e.g. always right after ytm://track).
//   * long task / frame gap present
//       -> the overlay itself is blocked; record the Performance tab here.

import { listen } from "@tauri-apps/api/event";

const EVENTS = [
  "ytm://tick",
  "ytm://track",
  "ytm://queue",
  "ytm://playlists",
  "ytm://add-to-playlist-options",
];

let enabled = false;
const recent = [];

/** Cheap breadcrumb; a no-op until diagnostics are enabled. */
export function note(name) {
  if (!enabled) return;
  recent.push({ name, t: performance.now() });
  if (recent.length > 14) recent.shift();
}

function recentSummary(now) {
  return recent.map((r) => `${r.name} -${Math.round(now - r.t)}ms`).join(", ") || "(nothing)";
}

function enable() {
  if (enabled) return;
  enabled = true;

  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((e) =>
        console.warn(`[ov] long task ${Math.round(e.duration)}ms`)
      );
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}

  let lastFrame = performance.now();
  (function frame(t) {
    const gap = t - lastFrame;
    lastFrame = t;
    if (gap > 100) console.warn(`[ov] frame gap ${Math.round(gap)}ms`);
    requestAnimationFrame(frame);
  })(lastFrame);

  let wheelPending = 0; // performance.now() of the first unanswered wheel tick
  document.addEventListener(
    "wheel",
    (e) => {
      const now = performance.now();
      const latency = now - e.timeStamp;
      if (latency > 80) {
        console.warn(
          `[ov] wheel latency ${Math.round(latency)}ms; recent: ${recentSummary(now)}`
        );
      }
      // A stale pending wheel (e.g. list already at its end, so no scroll
      // ever followed) must not poison the next measurement.
      if (!wheelPending || now - wheelPending > 1500) wheelPending = now;
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    "scroll",
    () => {
      if (!wheelPending) return;
      const now = performance.now();
      const delay = now - wheelPending;
      wheelPending = 0;
      if (delay > 150) {
        console.warn(
          `[ov] scroll response ${Math.round(delay)}ms; recent: ${recentSummary(now)}`
        );
      }
    },
    { capture: true, passive: true }
  );

  EVENTS.forEach((name) => listen(name, () => note(name)));
  console.log("[ov] diagnostics on - scroll the list until it freezes");
}

window.__ovDiag = { enable };
