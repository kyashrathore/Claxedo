/**
 * One-time install reporting: the only way to know how many downloads become
 * running apps. A download click on claxedo.com cannot answer that — the
 * binary is served from GitHub Releases, so the site never learns whether the
 * file was opened, let alone installed. This event is that missing half.
 *
 * Exactly one `app_installed` is emitted per profile, ever. The marker file
 * under userData is what makes it once-only, following the same idiom as
 * `cleanupLegacyDevCaches` in index.ts. A reinstall over an existing profile
 * is deliberately NOT a new install; wiping the profile is.
 *
 * Deliberately anonymous: `install_id` is a fresh random UUID with no
 * derivation from anything about the machine — no hostname, no username, no
 * MAC, no disk id. Two installs by the same person are unlinkable, which is
 * the point. Country is NOT collected here; PostHog derives an approximate one
 * server-side from the request IP, so sending anything location-shaped from
 * the client would be strictly worse for privacy and no better for the data.
 *
 * Electron-free by construction (the caller passes `userDataDir` and
 * `appVersion`) so the once-only guarantee is testable without booting Electron.
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { release } from "node:os"
import { join } from "node:path"
import type { PostHog } from "posthog-node"

/** Versioned so a future change to what an "install" means can re-fire once
 *  deliberately, rather than being blocked by a marker from the old scheme. */
const MARKER = ".install-id-v1"

/** Bounds the send so an unreachable PostHog host cannot delay app startup —
 *  the same tradeoff `captureFatal` makes on the crash path. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000

export type InstallEventProperties = {
  install_id: string
  os: string
  arch: string
  os_version: string
  app_version: string
  channel: string
  deployment_mode: "desktop-local"
  unit: "desktop-main"
}

/**
 * Read the existing install id, or mint and persist a new one.
 *
 * The returned `firstRun` is what gates the event, and it is derived from the
 * WRITE, not from the read: the id is written before anything is sent, so a
 * send that fails still consumes the first run rather than re-reporting the
 * same install on every subsequent launch.
 */
export function resolveInstallId(userDataDir: string): { installId: string; firstRun: boolean } {
  const marker = join(userDataDir, MARKER)
  if (existsSync(marker)) {
    const existing = readFileSync(marker, "utf8").trim()
    // A truncated or empty marker (interrupted first write, disk full) still
    // counts as "already seen" — re-reporting is worse than a missing id.
    if (existing) return { installId: existing, firstRun: false }
  }
  const installId = randomUUID()
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(marker, installId, "utf8")
  return { installId, firstRun: true }
}

export function buildInstallProperties(input: {
  installId: string
  appVersion: string
  channel: string
}): InstallEventProperties {
  return {
    install_id: input.installId,
    os: process.platform,
    arch: process.arch,
    os_version: release(),
    app_version: input.appVersion,
    channel: input.channel,
    deployment_mode: "desktop-local",
    unit: "desktop-main",
  }
}

/**
 * Emit `app_installed` if and only if this is the profile's first launch.
 *
 * Every failure mode is swallowed: a read-only userData directory, a throwing
 * client, an unreachable host. Telemetry must never keep the app from starting,
 * and a keyless build (`client` undefined) still writes the marker so that
 * turning telemetry on later does not retroactively report an old install as
 * new.
 */
export async function reportInstall(
  client: PostHog | undefined,
  input: { userDataDir: string; appVersion: string; channel: string },
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  try {
    const { installId, firstRun } = resolveInstallId(input.userDataDir)
    if (!firstRun || !client) return
    const properties = buildInstallProperties({ ...input, installId })
    // distinct_id is the install id: no user is signed in this early, and the
    // renderer identifies separately against its own client.
    client.capture({ distinctId: installId, event: "app_installed", properties })
    await Promise.race([client.flush(), delay(flushTimeoutMs)])
  } catch {
    // Best-effort only — see the doc comment above.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}
