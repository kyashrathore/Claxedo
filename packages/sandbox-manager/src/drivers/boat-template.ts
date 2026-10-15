import { generateKeyPairSync } from "node:crypto"
import type { SandboxDriverEnsureInput, SandboxTarget } from "../contract"
import { sandboxLease } from "../stores/memory"
import { boatTemplateResetCommand, createBoatSandboxDriver, type BoatRuntimeTemplate, type BoatSandboxDriverOptions } from "./boat"
import { createBoatClient, type BoatClientOptions } from "./boat-client"
import { createBoatNamedSnapshotClient } from "./boat-named-snapshots"

export type BoatRuntimeTemplateOptions = BoatClientOptions & {
  image: string
  /** Template names start with it, and pruning removes only names that do. */
  prefix?: string
  /** How many templates of the prefix pruning keeps, the image's own and the newest others. */
  keep?: number
  log?: (line: string) => void
  pollIntervalMs?: number
  hydrationTimeoutMs?: number
  stopTimeoutMs?: number
  saveTimeoutMs?: number
  driver?: Pick<BoatSandboxDriverOptions, "provisionIntervalMs" | "provisionTimeoutMs" | "healthIntervalMs" | "healthTimeoutMs">
}

const DEFAULT_PREFIX = "claxedo-rt-"
const DEFAULT_KEEP = 3
const NAME_HASH_CHARS = 12
const DEFAULT_POLL_INTERVAL_MS = 2_000
// The builder of a 4.46 GB template hydrated in 7 s, archived in 13–25 s and saved in 8 s (Boat, 2026-10-15).
const DEFAULT_HYDRATION_TIMEOUT_MS = 10 * 60_000
const DEFAULT_STOP_TIMEOUT_MS = 10 * 60_000
const DEFAULT_SAVE_TIMEOUT_MS = 10 * 60_000
// The new code, and the one the Worker deployed before it carries until the deploy replaces it.
const KEPT_SHARE_CODES = 2

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The image reference is content-addressed (its tag names the build), and the seeded trees are named by it, so it keys the template. */
export async function boatRuntimeTemplateName(image: string, prefix = DEFAULT_PREFIX) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image)))
  const name = `${prefix}${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, NAME_HASH_CHARS)}`
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`Boat refuses the named snapshot name ${name}`)
  return name
}

function clients(options: BoatRuntimeTemplateOptions) {
  const connection: BoatClientOptions = {
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }
  return { connection, sandboxes: createBoatClient(connection), snapshots: createBoatNamedSnapshotClient(connection) }
}

async function pollBoat<T>(label: string, timeoutMs: number, intervalMs: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`${label} did not happen within ${Math.round(timeoutMs / 1000)} s`)
    await sleep(intervalMs)
  }
}

/**
 * Saves the template once per image: a ready template is reused, one still
 * saving is waited for, and a missing or failed one is built on a builder
 * sandbox that is deleted whatever the outcome.
 */
export async function ensureBoatRuntimeTemplate(options: BoatRuntimeTemplateOptions): Promise<{ name: string; built: boolean }> {
  const { snapshots } = clients(options)
  const name = await boatRuntimeTemplateName(options.image, options.prefix)
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const existing = await pollBoat(`Boat template ${name} settling`, options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS, interval, async () => {
    const snapshot = await snapshots.get(name)
    return snapshot?.status === "saving" ? undefined : snapshot ?? null
  })
  if (existing?.status === "ready") {
    options.log?.(`template ${name} for ${options.image} exists`)
    return { name, built: false }
  }
  await buildTemplate(options, name)
  return { name, built: true }
}

/**
 * The builder boots the image with the Boat driver itself (pull, seed, stub,
 * runtime), stops, and wakes it, since Boat records the files a sandbox
 * opens first only while it starts from a snapshot and writes the record
 * (~/.ascii/playbook.json) once the download ends. The image and Boat's
 * archive of it are gone by then: the driver's start removes them once the
 * runtime runs from the stub. The reset leaves no container, so no machine
 * started from the template creates the builder's.
 */
async function buildTemplate(options: BoatRuntimeTemplateOptions, name: string) {
  const { connection, sandboxes, snapshots } = clients(options)
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const log = options.log ?? (() => {})
  const started = Date.now()
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`
  const driver = createBoatSandboxDriver({
    ...connection,
    image: options.image,
    controlEnv: { relayVerifyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() },
    ...options.driver,
  })
  // A builder's own workspace id, so a rebuild never meets an earlier builder's create key.
  const workspaceId = `${name}-${started.toString(36)}`
  let sandboxId: string | undefined
  const ensure = (epoch: number): SandboxDriverEnsureInput => ({
    workspaceId,
    homeRegion: "auto",
    epoch,
    labels: {},
    source: { kind: "empty" },
    onResource: async (resource) => {
      sandboxId = resource.sandboxId
    },
  })
  const boot = async (epoch: number): Promise<SandboxTarget> => {
    for (;;) {
      const lease = sandboxLease({ workspaceId, homeRegion: "auto", driver: "boat", epoch, sandboxId })
      const result = sandboxId ? await driver.resumeHost!({ lease, ensure: ensure(epoch) }) : await driver.ensureHost(ensure(epoch))
      if (!("provisioning" in result)) return result
      await sleep(result.retryAfterMs)
    }
  }
  const archived = (id: string) => pollBoat(`Boat ${id} stop`, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, interval, async () =>
    (await sandboxes.get(id)).state === "archived" ? true : undefined)
  try {
    log(`building template ${name} for ${options.image}`)
    const target = await boot(1)
    log(`builder ${target.sandboxId} seeded and healthy at ${elapsed()}`)
    await driver.stop!(target)
    await archived(target.sandboxId)
    log(`builder stopped at ${elapsed()}`)
    await boot(2)
    log(`builder woke at ${elapsed()}`)
    await pollBoat(`Boat ${target.sandboxId} hydration`, options.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS, interval, async () =>
      (await sandboxes.get(target.sandboxId)).hydrated ? true : undefined)
    log(`builder hydrated at ${elapsed()}`)
    const reset = await sandboxes.command(target.sandboxId, { command: boatTemplateResetCommand(), timeoutSeconds: 120 })
    if (reset.exitCode !== 0) throw new Error(`Boat ${target.sandboxId} template reset failed (exit ${reset.exitCode ?? "signal"})`)
    await sandboxes.stop(target.sandboxId)
    await archived(target.sandboxId)
    log(`builder reset and stopped at ${elapsed()}`)
    await snapshots.save({ sandboxId: target.sandboxId, name })
    const saved = await pollBoat(`Boat template ${name} save`, options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS, interval, async () => {
      const snapshot = await snapshots.get(name)
      return snapshot?.status === "saving" ? undefined : snapshot ?? null
    })
    if (saved?.status !== "ready") throw new Error(`Boat template ${name} save ${saved ? "failed" : "vanished"}`)
    log(`template ${name} saved at ${elapsed()}`)
  } finally {
    if (sandboxId) await sandboxes.delete(sandboxId)
  }
}

/**
 * A new share code for the image's template. Older codes are revoked except
 * the newest before it, which the running Worker still creates with until
 * the deploy hands it this one; a revoked code's create pulls and seeds.
 */
export async function shareBoatRuntimeTemplate(options: BoatRuntimeTemplateOptions): Promise<BoatRuntimeTemplate> {
  const { snapshots } = clients(options)
  const name = await boatRuntimeTemplateName(options.image, options.prefix)
  const created = await snapshots.share(name)
  const older = (await snapshots.shares(name))
    .filter((share) => share.status === "active" && share.id !== created.share.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  for (const share of older.slice(KEPT_SHARE_CODES - 1)) await snapshots.revokeShare(name, share.id)
  return { image: options.image, shareCode: created.shareCode }
}

/**
 * Each template past Boat's ten free named snapshots costs $1.70 a month, and
 * a template serves only the image it was built for, so templates of the
 * prefix beyond the newest `keep` (and the image's own) are removed; Boat
 * removes their share codes with them.
 */
export async function pruneBoatRuntimeTemplates(options: BoatRuntimeTemplateOptions): Promise<string[]> {
  const { snapshots } = clients(options)
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const current = await boatRuntimeTemplateName(options.image, prefix)
  const others = (await snapshots.list())
    .filter((snapshot) => snapshot.name.startsWith(prefix) && snapshot.name !== current && snapshot.status !== "saving")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const removed = others.slice(Math.max(0, (options.keep ?? DEFAULT_KEEP) - 1)).map((snapshot) => snapshot.name)
  for (const name of removed) await snapshots.delete(name)
  if (removed.length) options.log?.(`pruned templates ${removed.join(", ")}`)
  return removed
}
