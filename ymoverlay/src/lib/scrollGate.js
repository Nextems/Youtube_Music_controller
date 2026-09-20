// Tiny shared "is a list being scrolled right now?" flag.
//
// Why it exists: the queue / playlists payloads arrive from the YTM window
// at arbitrary moments (track change, 5s safety scan, ...). If one lands
// while the user is mid-scroll, React swaps the rows under their finger.
// usePlaybackState.js therefore holds such payloads back while this gate
// is closed and applies the newest one the moment scrolling stops - so
// from the user's point of view the list is "loaded once" and simply
// doesn't change while they scroll it.
//
// Plain module state on purpose (no React state): flipping it must never
// cause a re-render.

const IDLE_MS = 250;

let scrolling = false;
let timer = null;
const idleListeners = new Set();

export function markScrolling() {
  scrolling = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    scrolling = false;
    idleListeners.forEach((fn) => fn());
  }, IDLE_MS);
}

export function isScrolling() {
  return scrolling;
}

/** Calls fn every time scrolling settles. Returns an unsubscribe function. */
export function onScrollIdle(fn) {
  idleListeners.add(fn);
  return () => idleListeners.delete(fn);
}
