/**
 * Wait for the terminal's own font to load before re-fitting xterm.
 *
 * xterm measures cell width once, at `open()` time, using whatever font the
 * browser has resolved so far. If the configured face finishes loading after
 * that measurement, the cached glyph metrics no longer match what is drawn:
 * text renders mangled — overlapping or clipped — and only repairs on the next
 * resize.
 *
 * `document.fonts.ready` is the wrong signal for this. It resolves when the
 * font loads *currently pending* have settled, which can be immediately — before
 * a face that only xterm's canvas measurement will request has even started
 * loading. `fonts.load(spec)` is the right one: it asks for that specific face
 * at that specific size and resolves when it is actually usable.
 *
 * Our font stack makes this more likely, not less: TERMINAL_FONT_FAMILY is a
 * ten-entry Nerd Font fallback list, so the face that wins is often a
 * user-installed font the browser has never loaded before.
 */

const DEFAULT_FONT_LOAD_TIMEOUT_MS = 2000

export type FontReadyTarget = {
  fontFamily: string
  fontSize: number
  timeoutMs?: number
}

/**
 * Resolve once the face is loaded, the timeout elapses, or the load fails.
 *
 * Never rejects: a refit that is merely late is far better than one that never
 * happens, so a bad font spec must not permanently block rendering recovery.
 */
export async function waitForFontReady(
  { fontFamily, fontSize, timeoutMs = DEFAULT_FONT_LOAD_TIMEOUT_MS }: FontReadyTarget,
  doc: Pick<Document, "fonts"> | undefined = typeof document === "undefined" ? undefined : document,
): Promise<void> {
  const fonts = doc?.fonts as FontFaceSet | undefined
  if (!fonts || typeof fonts.load !== "function") return

  const spec = `${fontSize}px ${fontFamily}`

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([Promise.resolve(fonts.load(spec)).then(() => undefined), timeout])
  } catch {
    // Swallow: the caller refits regardless.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

/**
 * Wait for the configured font, then refit — but only if the terminal is still
 * alive and mounted by then. `isAlive` is re-checked after the await because a
 * 2s timeout easily outlives a pane.
 */
export function scheduleFontSettleRefit(input: {
  fontFamily: string
  fontSize: number
  timeoutMs?: number
  isAlive: () => boolean
  refit: () => void
}): void {
  const fontFamily = input.fontFamily.trim()
  if (!fontFamily) return

  void waitForFontReady({
    fontFamily,
    fontSize: input.fontSize,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  }).then(() => {
    if (!input.isAlive()) return
    input.refit()
  })
}
