
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

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
