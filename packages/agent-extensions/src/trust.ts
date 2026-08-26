import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { digestDirectory } from "./cache"
import { discoverAgentExtensionComponents } from "./discovery"
import { readFileIfExists, withAgentExtensionStateLock, writeFileAtomic } from "./fs-safe"
import { lockStatePath, readExtensionLock, type ExtensionLock, type LockedExtensionPackage } from "./lock"
import {
  agentExtensionStateRoot,
  installedStatePath,
  readDesiredExtensionState,
  type DesiredExtensionInstall,
} from "./state"
import { FIRST_PARTY_AGENT_EXTENSIONS_DIR } from "./types"

/**
 * Consent gate for repo-controlled extension declarations.
 *
 * A workspace checkout is attacker-controlled input: cloning a repository
 * ships its `.agent-extensions/{installed.json,lock.json}` and its
 * `agent-extensions/` source directory verbatim. Neither may influence what a
 * runtime materializes unless the HOST has recorded trust for this exact
 * project directory in this host-owned ledger (`<dataRoot>/agent-extensions/
 * project-trust.json`, deliberately outside any checkout).
 *
 * Trust is scoped and content-bound:
 *
 * - Per install id: a grant records the canonical form of that install row
 *   plus its lock entry. Consenting to one package (a lifecycle command) never
 *   blesses other rows the checkout shipped.
 * - First-party discovery (`agent-extensions/`) needs its own explicit grant;
 *   its fingerprint covers component paths AND file contents, so editing an
 *   already-trusted component in place invalidates it just like adding one.
 * - Serialization is recursive over sorted keys: nested objects (notably
 *   `source`) are part of the fingerprint, so retargeting an install at
 *   another owner/repo cannot ride an old grant.
 *
 * Timestamps are excluded from row fingerprints — they churn on every
 * lifecycle write without changing what the checkout declares. Every mutating
 * lifecycle command re-grants for the ids it acted on immediately after its
 * own successful projection anyway.
 *
 * This is the local counterpart of control-plane-signed locks: the lock is
 * still self-signed by whoever shipped it, but it can never rotate silently.
 */

export const PROJECT_EXTENSION_TRUST_FILE = "project-trust.json"

export type ProjectExtensionTrustEntry = {
  granted_at: number
  installs: Record<string, { fingerprint: string }>
  first_party?: { fingerprint: string }
}

export type ProjectExtensionTrust = {
  version: 1
  projects: Record<string, ProjectExtensionTrustEntry>
}

/** What a host may apply for a project right now, per currently-valid grants. */
export type ResolvedProjectExtensionTrust = {
  installIds: string[]
  firstParty: boolean
}

export function projectExtensionTrustPath(input: { dataRoot: string }) {
  return path.join(
    agentExtensionStateRoot({ scope: "machine", dataRoot: input.dataRoot }),
    PROJECT_EXTENSION_TRUST_FILE,
  )
}

export async function readProjectExtensionTrust(file: string): Promise<ProjectExtensionTrust> {
  const raw = await readFileIfExists(file)
  if (raw === undefined) return { version: 1, projects: {} }
  let data: Partial<ProjectExtensionTrust>
  try {
    data = JSON.parse(raw) as Partial<ProjectExtensionTrust>
  } catch {
    // Fail closed: an unreadable ledger means nothing is trusted. Nothing
    // cascades from this file (unlike desired state), so corruption only ever
    // disables extensions; it can never materialize one.
    return { version: 1, projects: {} }
  }
  return {
    version: 1,
    projects: data.projects && typeof data.projects === "object" && !Array.isArray(data.projects)
      ? data.projects as ProjectExtensionTrust["projects"]
      : {},
  }
}

async function writeProjectExtensionTrust(file: string, trust: ProjectExtensionTrust) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await writeFileAtomic(file, JSON.stringify(trust, null, 2) + "\n")
}

// Deterministic, key-order-independent serialization over EVERYTHING,
// recursively. The array-replacer form of JSON.stringify applies its key list
// at every depth, which silently erased nested objects such as `source` —
// exactly the field a retarget attack changes.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

// installed_at/updated_at churn on every lifecycle write without changing
// what the checkout declares; excluding them keeps enable/disable from
// invalidating unrelated grants.
function canonicalInstallForFingerprint(install: DesiredExtensionInstall) {
  const { installed_at: _installedAt, updated_at: _updatedAt, ...declared } = install
  return canonicalJson(declared)
}

function canonicalLockForFingerprint(locked: LockedExtensionPackage | undefined) {
  return locked ? canonicalJson(locked) : ""
}

/**
 * Digest over everything one declared install can influence: its desired row
 * and its lock entry. Missing lock hashes like an absent one.
 */
export function installFingerprint(input: {
  install: DesiredExtensionInstall
  locked?: LockedExtensionPackage
}) {
  return crypto.createHash("sha256")
    .update(`${canonicalInstallForFingerprint(input.install)}\u0000${canonicalLockForFingerprint(input.locked)}`)
    .digest("hex")
}

// Component contents, not just their paths: an in-place edit of a trusted
// component must invalidate the grant exactly like adding or removing one.
async function firstPartyFingerprint(projectDir: string): Promise<string> {
  const dir = path.join(projectDir, FIRST_PARTY_AGENT_EXTENSIONS_DIR)
  if (!await fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false)) {
    return crypto.createHash("sha256").update("absent").digest("hex")
  }
  return digestDirectory(dir)
}

function trustKey(projectDir: string) {
  return path.resolve(projectDir)
}

/**
 * The grants for a project that still match the checkout's current
 * declaration. Anything drifted, unreadable, or absent is simply not
 * returned — the caller's fallback is always "do not apply".
 */
export async function resolveProjectExtensionTrust(input: {
  dataRoot: string
  projectDir: string
}): Promise<ResolvedProjectExtensionTrust> {
  const trust = await readProjectExtensionTrust(projectExtensionTrustPath(input))
  const entry = trust.projects[trustKey(input.projectDir)]
  if (!entry) return { installIds: [], firstParty: false }

  const valid: ResolvedProjectExtensionTrust = { installIds: [], firstParty: false }
  const declaredFirstParty = entry.first_party?.fingerprint
  if (declaredFirstParty) {
    try {
      valid.firstParty = (await firstPartyFingerprint(input.projectDir)) === declaredFirstParty
    } catch {
      valid.firstParty = false
    }
  }

  if (Object.keys(entry.installs ?? {}).length > 0) {
    let state: Awaited<ReturnType<typeof readDesiredExtensionState>>
    let lock: ExtensionLock
    try {
      [state, lock] = await Promise.all([
        readDesiredExtensionState(installedStatePath({ scope: "project", projectDir: input.projectDir })),
        readExtensionLock(lockStatePath(agentExtensionStateRoot({ scope: "project", projectDir: input.projectDir }))),
      ])
    } catch {
      // Undeclarable install state invalidates INSTALL grants only; a
      // first-party grant this call already verified stands on its own.
      valid.installIds = []
      return valid
    }
    for (const [id, granted] of Object.entries(entry.installs)) {
      const install = state.installs.find((item) => item.id === id)
      if (!install || !granted?.fingerprint) continue
      // A project ledger only ever vouches for PROJECT-scope rows. A
      // checkout-declared `scope:"machine"` row would materialize OUTSIDE
      // the checkout (into $HOME runner dirs) and persist after the repo is
      // gone — exactly what a per-checkout consent must not authorize. A
      // user's own machine installs live in machine-root state, which this
      // gate never touches.
      if (install.scope !== "project") continue
      if (installFingerprint({ install, locked: lock.packages[id] }) === granted.fingerprint) {
        valid.installIds.push(id)
      }
    }
    valid.installIds.sort()
  }
  return valid
}

/**
 * Records (or extends) trust for parts of a project's CURRENT declaration:
 * the named install ids and/or the first-party directory. Granting one part
 * never blesses the rest.
 *
 * The ledger is one machine-wide file shared by every project, so the
 * read-modify-write runs under the machine state-root lock — otherwise two
 * concurrent lifecycles in different checkouts could silently drop each
 * other's grants. Lock ordering is always project root → machine root, so
 * this cannot deadlock against applyProjection's project lock.
 */
export async function grantProjectExtensionTrust(input: {
  dataRoot: string
  projectDir: string
  now?: number
  installIds?: string[]
  firstParty?: boolean
  /** Ids whose grants are withdrawn (uninstall withdrew the user's consent). */
  removeIds?: string[]
}): Promise<{ installIds: string[]; firstParty: boolean }> {
  const machineRoot = agentExtensionStateRoot({ scope: "machine", dataRoot: input.dataRoot })
  return withAgentExtensionStateLock(machineRoot, async () => {
    const file = projectExtensionTrustPath(input)
    const trust = await readProjectExtensionTrust(file)
    const key = trustKey(input.projectDir)
    const previous = trust.projects[key] ?? { granted_at: input.now ?? Date.now(), installs: {} }
    const next: ProjectExtensionTrustEntry = {
      granted_at: previous.granted_at || (input.now ?? Date.now()),
      installs: { ...previous.installs },
      ...(previous.first_party ? { first_party: previous.first_party } : {}),
    }

    if ((input.installIds?.length ?? 0) > 0) {
      const root = agentExtensionStateRoot({ scope: "project", projectDir: input.projectDir })
      const [state, lock] = await Promise.all([
        readDesiredExtensionState(installedStatePath({ scope: "project", projectDir: input.projectDir })),
        readExtensionLock(lockStatePath(root)),
      ])
      for (const id of input.installIds!) {
        const install = state.installs.find((item) => item.id === id)
        // Same project-scope-only rule as resolve: a checkout cannot talk a
        // bulk grant into blessing a row that materializes into $HOME.
        if (!install || install.scope !== "project") continue
        next.installs[id] = { fingerprint: installFingerprint({ install, locked: lock.packages[id] }) }
      }
    }
    if (input.firstParty) {
      next.first_party = { fingerprint: await firstPartyFingerprint(input.projectDir) }
    }
    for (const id of input.removeIds ?? []) {
      delete next.installs[id]
    }

    await writeProjectExtensionTrust(file, {
      version: 1,
      projects: { ...trust.projects, [key]: next },
    })
    return resolveProjectExtensionTrust(input)
  })
}

export async function revokeProjectExtensionTrust(input: { dataRoot: string; projectDir: string }): Promise<boolean> {
  const machineRoot = agentExtensionStateRoot({ scope: "machine", dataRoot: input.dataRoot })
  return withAgentExtensionStateLock(machineRoot, async () => {
    const file = projectExtensionTrustPath(input)
    const trust = await readProjectExtensionTrust(file)
    const key = trustKey(input.projectDir)
    if (!trust.projects[key]) return false
    const { [key]: _removed, ...projects } = trust.projects
    await writeProjectExtensionTrust(file, { version: 1, projects })
    return true
  })
}
