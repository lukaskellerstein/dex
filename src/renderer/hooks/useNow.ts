import { useEffect, useState } from "react";

/**
 * Returns a `Date.now()` value that ticks at `intervalMs` so components
 * showing relative timestamps (e.g. "4s ago") update without external state.
 * Pauses when `enabled` is false to avoid wasting frames when no live indicator
 * is visible.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

/** Format an ISO timestamp as a short relative string against `now`. */
export function relativeTimeShort(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}
