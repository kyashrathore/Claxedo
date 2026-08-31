import { readFileSync, statSync } from "node:fs"
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
 * The MAIN checkout is labeled by its CURRENT BRANCH instead — name and tint
 * follow the branch so it is also tellable at a glance — but its userData stays
 * the unsuffixed dev profile: branches change too often to fragment state and
 * locks over, and the main checkout has no side-by-side twin of itself.
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

export type DevLabelProbe = {
  label: string | null
  /** Only worktree labels isolate userData; a branch label rides the shared profile. */
  isolateProfile: boolean
}

/**
 * A linked worktree has a `.git` FILE (pointer) and is labeled by its directory
 * name; the main checkout has a `.git` directory and is labeled by its branch.
 */
export function probeDevLabel(repoRoot: string, env: NodeJS.ProcessEnv = process.env): DevLabelProbe {
  const explicit = env.CLAXEDO_DEV_LABEL?.trim()
  if (explicit) return { label: explicit, isolateProfile: true }
  try {
    if (statSync(join(repoRoot, ".git")).isFile()) {
      return { label: basename(repoRoot), isolateProfile: true }
    }
    return { label: gitHeadLabel(join(repoRoot, ".git", "HEAD")), isolateProfile: false }
  } catch {
    return { label: null, isolateProfile: false }
  }
}

/** "ref: refs/heads/dev" → "dev"; a detached HEAD shows its short commit. */
export function gitHeadLabel(headFile: string): string | null {
  try {
    const head = readFileSync(headFile, "utf8").trim()
    if (head.startsWith("ref: ")) return head.slice("ref: ".length).replace(/^refs\/heads\//, "")
    return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 8) : null
  } catch {
    return null
  }
}

/** Pure derivation from an already-resolved probe. */
export function deriveDevIdentity(probe: DevLabelProbe): DevIdentity {
  const { label } = probe
  if (!label) return { label: null, name: "Claxedo Dev", userDataSuffix: "", hue: null }
  return {
    label,
    name: `Claxedo Dev (${label})`,
    userDataSuffix: probe.isolateProfile ? `.${slugify(label)}` : "",
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
