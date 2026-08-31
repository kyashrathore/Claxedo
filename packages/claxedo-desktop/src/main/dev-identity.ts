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
 */
export function tintIcon(icon: NativeImage, hue: number): NativeImage {
  const size = icon.getSize()
  if (size.width === 0 || size.height === 0) return icon
  const bitmap = tintBitmap(Buffer.from(icon.toBitmap()), hue)
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height })
}
