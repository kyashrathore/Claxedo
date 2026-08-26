import { codexIconSprite } from "./codex-icons"
import { fileIconSprite } from "./file-icon"
import { providerIconSprite } from "./provider-icon"

/**
 * Warm every lazily loaded icon sprite once the main thread is idle, so the
 * first surface that renders an icon does not pay the sprite asset's network
 * time inside its own interaction window. Idempotent through each sprite's
 * own single-load guard; returns a disposer for an unfired idle callback.
 */
export function warmIconSpritesWhenIdle() {
  if (typeof document === "undefined") return () => {}
  const warm = () => {
    codexIconSprite.preload()
    fileIconSprite.preload()
    providerIconSprite.preload()
  }
  if (typeof requestIdleCallback !== "function") {
    const timer = setTimeout(warm, 200)
    return () => clearTimeout(timer)
  }
  const idle = requestIdleCallback(warm, { timeout: 1_200 })
  return () => {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
  }
}
