import { statSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Per-worktree identity for UNPACKAGED dev builds — the pure policy half,
 * kept free of electron imports so it is unit-testable. `dev-identity.ts`
 * next door owns the nativeImage glue.
 *
 * Running the desktop app from several git worktrees at once is
 * indistinguishable today: every instance is "Claxedo Dev" with the same icon,
 * and they share one userData dir — whose single-instance lock means the second
 * worktree's launch just focuses the first. A LINKED worktree therefore gets a
 * derived label (the worktree directory name, `CLAXEDO_DEV_LABEL` to override):
 * the app name gains a suffix, the icon is tinted a hue hashed from the label,
 * and userData gets a matching suffix so instances run side by side.
 *
 * The MAIN checkout stays unlabeled on purpose — its name, icon, and existing
 * dev profile are exactly what they were before this file existed.
 */
export type DevIdentity = {
  /** Worktree label, or null for the main checkout / packaged builds. */
  label: string | null
  /** `Claxedo Dev (label)` or plain `Claxedo Dev`. */
  name: string
  /** Filesystem-safe suffix for the userData dir ("" when unlabeled). */
  userDataSuffix: string
  /** Stable tint hue for the icon (null when unlabeled). */
  hue: number | null
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
}

function labelHue(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 360
}

/** A linked worktree has a `.git` FILE (pointer); the main checkout has a directory. */
export function linkedWorktreeLabel(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CLAXEDO_DEV_LABEL?.trim()
  if (explicit) return explicit
  try {
    return statSync(join(repoRoot, ".git")).isFile() ? basename(repoRoot) : null
  } catch {
    return null
  }
}

/** Pure derivation from an already-resolved label. */
export function deriveDevIdentity(label: string | null): DevIdentity {
  if (!label) return { label: null, name: "Claxedo Dev", userDataSuffix: "", hue: null }
  return {
    label,
    name: `Claxedo Dev (${label})`,
    userDataSuffix: `.${slugify(label)}`,
    hue: labelHue(label),
  }
}

/** BGRA in, BGRA out — toBitmap()'s layout on every platform Electron supports. */
export function tintBitmap(bitmap: Buffer, hue: number): Buffer {
  const [tr, tg, tb] = hueToRgb(hue)
  for (let i = 0; i < bitmap.length; i += 4) {
    const luminance = (bitmap[i + 2]! * 0.299 + bitmap[i + 1]! * 0.587 + bitmap[i]! * 0.114) / 255
    bitmap[i + 2] = Math.round(tr * luminance)
    bitmap[i + 1] = Math.round(tg * luminance)
    bitmap[i] = Math.round(tb * luminance)
  }
  return bitmap
}

function hueToRgb(hue: number): [number, number, number] {
  // Fixed high saturation/value: distinct hues, consistent brightness.
  const c = 0.9 * 255
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = 255 - c
  const [r, g, b] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x]
  return [r + m, g + m, b + m]
}
