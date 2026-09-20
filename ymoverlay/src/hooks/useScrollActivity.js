import { useCallback, useRef } from "react";
import { markScrolling } from "../lib/scrollGate.js";

/**
 * Returns a CALLBACK ref for a scroll container. It only reports "this list
 * is being scrolled" to lib/scrollGate.js - it does NOT touch the DOM, CSS
 * classes, pointer-events or React state (the old useScrollingClass did,
 * and that was the suspected cause of the freezes).
 *
 * A callback ref (instead of useRef + useEffect([])) matters here: both
 * lists render a placeholder paragraph while empty and only later mount the
 * real scroll <div>. An effect with [] deps would run once against a null
 * ref and never attach.
 */
export function useScrollActivity() {
  const elRef = useRef(null);

  return useCallback((el) => {
    const prev = elRef.current;
    if (prev) {
      prev.removeEventListener("scroll", markScrolling);
      prev.removeEventListener("wheel", markScrolling);
    }
    elRef.current = el;
    if (el) {
      el.addEventListener("scroll", markScrolling, { passive: true });
      // `wheel` fires before the first scroll event, so the gate closes
      // as early as possible.
      el.addEventListener("wheel", markScrolling, { passive: true });
    }
  }, []);
}
