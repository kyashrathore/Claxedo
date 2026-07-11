/**
 * Reduced-motion helpers.
 *
 * The app already honors `prefers-reduced-motion` for CSS transitions
 * (`claxedo-ui/app-shell.css`), but JS-driven motion — auto-playing media,
 * imperative animations — has to check the preference itself. This module is
 * the single source of truth for that read so callers don't each reinvent the
 * `matchMedia` guard (and its SSR/jsdom fallback).
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Whether the user has asked the OS to reduce motion. Returns `false` when
 * `matchMedia` is unavailable (SSR / jsdom without a shim) so motion-by-default
 * behavior is preserved in non-browser environments.
 */
export function prefersReducedMotion(
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): boolean {
  if (!win || typeof win.matchMedia !== "function") return false
  try {
    return win.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}
