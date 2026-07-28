import { digestDirectory } from "./cache"
import type { PackageSource } from "./types"

/**
 * Supply-chain integrity for materialization.
 *
 * The lock file is the only record of what content was reviewed at install
 * time: `resolved_sha` pins the commit and `component_digests.package` /
 * `manifest_digests.package` pin a content hash over the package tree that was
 * actually copied into the cache. Before this module, both were *recorded* but
 * neither was *required* — every check was of the form "if a digest happens to
 * be present, compare it", so a lock with no digests (or no lock at all)
 * materialized whatever happened to be sitting at the package root. An
 * attacker who could seed the cache directory, or push a snapshot with a
 * digest-less lock, got arbitrary code into every agent harness on the box.
 *
 * The rule now: a remote package may not be materialized unless the lock pins
 * both the commit and the content, and the content on disk hashes to the
 * pinned digest. Anything that cannot be verified is refused.
 */

const HEX_SHA = /^[A-Fa-f0-9]{7,64}$/

export type AgentExtensionIntegrityCode =
  | "agent_extension_unverifiable_package"
  | "agent_extension_digest_mismatch"
  | "agent_extension_source_mismatch"

export class AgentExtensionIntegrityError extends Error {
  constructor(
    message: string,
    public readonly code: AgentExtensionIntegrityCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "AgentExtensionIntegrityError"
  }
}

/**
 * The subset of a lock entry that integrity verification depends on. Kept
 * structurally typed (rather than importing `LockedExtensionPackage`) because
 * replay receives locks as untrusted JSON from a pushed snapshot and the
 * materializer sees a narrowed install shape.
 */
export type PackageIntegrityLock = {
  resolved_sha?: string
  source?: PackageSource
  manifest_digests?: Record<string, string>
  component_digests?: Record<string, string>
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function lockedPackageDigest(lock: PackageIntegrityLock | undefined) {
  return text(lock?.component_digests?.package) ?? text(lock?.manifest_digests?.package)
}

/**
 * "project" sources are a path inside the caller's own working tree; there is
 * no remote content to pin and the user edits them freely. Everything else —
 * github today, anything added later, and the "unknown" type replay falls back
 * to for a malformed snapshot — is remote and must be pinned.
 */
export function isRemotePackageSource(source: PackageSource | undefined) {
  return (source?.type ?? "") !== "project"
}

// Compared on the identity fields only: a lock written by an older version, or
// a snapshot that round-tripped through JSON, must not fail over an
// incidental extra key.
function sourceIdentity(source: PackageSource | undefined) {
  if (!source) return undefined
  if (source.type === "project") return JSON.stringify(["project", source.package_path ?? ""])
  return JSON.stringify([
    source.type ?? "",
    source.owner ?? "",
    source.repo ?? "",
    source.ref ?? "",
    source.package_path ?? "",
  ])
}

export function samePackageSourceIdentity(left: PackageSource | undefined, right: PackageSource | undefined) {
  const key = sourceIdentity(left)
  return !!key && key === sourceIdentity(right)
}

/**
 * Verifies that `packageRoot` is the content the lock pins, and returns the
 * digest it actually hashed to.
 *
 * Fails closed: a remote install with no lock, no resolved SHA, or no recorded
 * package digest is refused rather than materialized unverified. A desired
 * source that disagrees with the locked source is also refused — changing the
 * pinned owner/repo/ref is a deliberate re-install, never something a pushed
 * snapshot gets to do implicitly.
 */
export async function verifyPackageIntegrity(input: {
  id: string
  source?: PackageSource
  lock?: PackageIntegrityLock
  packageRoot: string
  digest?: (root: string) => Promise<string>
}): Promise<string> {
  const expected = lockedPackageDigest(input.lock)
  if (isRemotePackageSource(input.source)) {
    if (!input.lock) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} has no lock entry; refusing to materialize an unverified package (reinstall it or run \`agent-extensions update ${input.id}\`)`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "lock" },
      )
    }
    if (!text(input.lock.resolved_sha) || !HEX_SHA.test(input.lock.resolved_sha!.trim())) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} is missing resolved SHA in its lock; refusing to materialize an unpinned package`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "resolved_sha" },
      )
    }
    if (!expected) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} lock records no package digest; refusing to materialize an unverified package (reinstall it or run \`agent-extensions update ${input.id}\`)`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "package_digest" },
      )
    }
  }
  if (input.lock?.source && !samePackageSourceIdentity(input.source, input.lock.source)) {
    throw new AgentExtensionIntegrityError(
      `Agent Extension ${input.id} requested source does not match its locked source; reinstall it to change the pinned source`,
      "agent_extension_source_mismatch",
      { id: input.id, requestedSource: input.source, lockedSource: input.lock.source },
    )
  }
  const actual = await (input.digest ?? digestDirectory)(input.packageRoot)
  if (expected && actual !== expected) {
    throw new AgentExtensionIntegrityError(
      `Agent Extension ${input.id} cache checksum mismatch; run \`agent-extensions update ${input.id}\` to refetch the package`,
      "agent_extension_digest_mismatch",
      { id: input.id, expected, actual },
    )
  }
  return actual
}
