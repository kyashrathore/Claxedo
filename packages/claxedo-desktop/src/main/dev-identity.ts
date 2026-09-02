import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { NativeImage } from "electron"
import { nativeImage } from "electron"
import { deriveDevIdentity, probeDevLabel, tintBitmap, type DevIdentity } from "./dev-identity-policy"

export type { DevIdentity } from "./dev-identity-policy"

function repoRoot(): string {
  // out/main/<chunk>.mjs → packages/claxedo-desktop → repo root.
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..", "..", "..")
}

export function resolveDevIdentity(packaged: boolean): DevIdentity {
  if (packaged) return deriveDevIdentity({ label: null, isolateProfile: false })
  return deriveDevIdentity(probeDevLabel(repoRoot()))
}

/**
 * Colorize an icon toward the identity hue, keeping alpha and luminance so the
 * mark stays recognizable — the point is telling two dock icons apart at a
 * glance, not designing a new logo per worktree.
 *
 * Scale-aware on purpose: `getSize()` reports DIP dimensions while
 * `toBitmap()` returns the image's actual pixel buffer — for a Retina asset
 * (`128x128@2x.png`, which is exactly what the macOS dock icon loads) those
 * differ by the scale factor, and `createFromBitmap` throws
 * "invalid buffer size" when the declared dimensions don't match the buffer.
 * That throw escaped as an unhandled rejection out of `app.whenReady()` and
 * took the whole main process down at startup on macOS.
 */
export function tintIcon(icon: NativeImage, hue: number): NativeImage {
  const size = icon.getSize()
  if (size.width === 0 || size.height === 0) return icon
  const bitmap = tintBitmap(Buffer.from(icon.toBitmap()), hue)
  const scale = Math.round(Math.sqrt(bitmap.length / (size.width * size.height * 4)))
  const width = size.width * scale
  const height = size.height * scale
  // A representation this math cannot explain (non-integral scale, or a
  // buffer that is not width*height*4) keeps the untinted icon rather than
  // crashing startup over a cosmetic hue.
  if (scale < 1 || bitmap.length !== width * height * 4) return icon
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: scale })
}
