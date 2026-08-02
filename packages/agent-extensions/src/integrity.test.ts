import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { digestDirectory } from "./cache"
import {
  AgentExtensionIntegrityError,
  isRemotePackageSource,
  lockedPackageDigest,
  samePackageSourceIdentity,
  verifyPackageIntegrity,
} from "./integrity"
import { materializeAgentExtensionSnapshot } from "./materialize"

const root = path.join(os.tmpdir(), `agent-extensions-integrity-${randomUUID().slice(0, 8)}`)
const remote = { type: "github", owner: "acme", repo: "review" } as const

async function writePackage(name: string, content = "---\nname: review\n---\n") {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "SKILL.md"), content)
  return dir
}

async function integrityError(run: Promise<unknown>) {
  const caught = await run.then(() => undefined, (err: unknown) => err)
  expect(caught).toBeInstanceOf(AgentExtensionIntegrityError)
  return caught as AgentExtensionIntegrityError
}

describe("Agent Extension package integrity", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("accepts a remote package whose content matches the digest its lock pins", async () => {
    const packageRoot = await writePackage("verified")
    const digest = await digestDirectory(packageRoot)

    await expect(verifyPackageIntegrity({
      id: "review",
      source: remote,
      lock: {
        source: remote,
        resolved_sha: "abcdef1234567890",
        component_digests: { package: digest },
      },
      packageRoot,
    })).resolves.toBe(digest)
  })

  test("rejects a remote package whose content does not match the locked digest", async () => {
    const packageRoot = await writePackage("tampered")
    const digest = await digestDirectory(packageRoot)
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: evil\n---\n")

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: remote,
      lock: {
        source: remote,
        resolved_sha: "abcdef1234567890",
        component_digests: { package: digest },
      },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_digest_mismatch")
    expect(err.message).toContain("cache checksum mismatch")
  })

  // The core of the fix: before it, every one of these three shapes was read as
  // "nothing to compare against, therefore fine" and materialized unverified.
  test("refuses a remote package that has no lock entry", async () => {
    const packageRoot = await writePackage("unlocked")

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: remote,
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_unverifiable_package")
    expect(err.details).toMatchObject({ missing: "lock" })
  })

  test("refuses a remote package whose lock records no package digest", async () => {
    const packageRoot = await writePackage("undigested")

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: remote,
      lock: { source: remote, resolved_sha: "abcdef1234567890", component_digests: {}, manifest_digests: {} },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_unverifiable_package")
    expect(err.details).toMatchObject({ missing: "package_digest" })
  })

  test("refuses a remote package whose lock records no resolved SHA", async () => {
    const packageRoot = await writePackage("unpinned")
    const digest = await digestDirectory(packageRoot)

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: remote,
      lock: { source: remote, component_digests: { package: digest } },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_unverifiable_package")
    // Hosts classify replay failures off this substring; keep it stable.
    expect(err.message.toLowerCase()).toContain("missing resolved sha")
  })

  test("refuses a remote package whose resolved SHA is not a hex commit id", async () => {
    const packageRoot = await writePackage("optioninjection")
    const digest = await digestDirectory(packageRoot)

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: remote,
      lock: { source: remote, resolved_sha: "--upload-pack=/tmp/evil", component_digests: { package: digest } },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_unverifiable_package")
  })

  test("refuses a package whose requested source does not match its locked source", async () => {
    const packageRoot = await writePackage("swapped")
    const digest = await digestDirectory(packageRoot)

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: { type: "github", owner: "kyashrathore", repo: "Claxedo", ref: "dev" },
      lock: {
        source: remote,
        resolved_sha: "abcdef1234567890",
        component_digests: { package: digest },
      },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_source_mismatch")
  })

  test("refuses an unrecognised source type rather than treating it as local", async () => {
    const packageRoot = await writePackage("unknown-source")

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: { type: "unknown" },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_unverifiable_package")
  })

  // Project sources are a path in the caller's own working tree: there is no
  // remote content to pin, and the first-party agent-extensions directory is
  // edited in place, so requiring a lock there would break it.
  test("allows a project package with no lock", async () => {
    const packageRoot = await writePackage("project-source")

    await expect(verifyPackageIntegrity({
      id: "first-party-agent-extensions",
      source: { type: "project", package_path: "agent-extensions" },
      packageRoot,
    })).resolves.toBe(await digestDirectory(packageRoot))
  })

  test("still enforces a recorded digest for a project package", async () => {
    const packageRoot = await writePackage("project-drift")

    const err = await integrityError(verifyPackageIntegrity({
      id: "review",
      source: { type: "project", package_path: "agent-extensions" },
      lock: { component_digests: { package: "not-the-package-digest" } },
      packageRoot,
    }))
    expect(err.code).toBe("agent_extension_digest_mismatch")
  })

  test("prefers the component digest over the manifest digest", () => {
    expect(lockedPackageDigest({
      manifest_digests: { package: "manifest" },
      component_digests: { package: "component" },
    })).toBe("component")
    expect(lockedPackageDigest({ manifest_digests: { package: "manifest" } })).toBe("manifest")
    expect(lockedPackageDigest({ manifest_digests: {}, component_digests: {} })).toBeUndefined()
    expect(lockedPackageDigest(undefined)).toBeUndefined()
  })

  test("treats every source type except project as remote", () => {
    expect(isRemotePackageSource({ type: "project", package_path: "x" })).toBe(false)
    expect(isRemotePackageSource({ type: "github", owner: "acme", repo: "review" })).toBe(true)
    expect(isRemotePackageSource(undefined)).toBe(true)
  })

  test("compares source identity on the pinned fields only", () => {
    expect(samePackageSourceIdentity(remote, { ...remote, package_path: undefined })).toBe(true)
    expect(samePackageSourceIdentity(remote, { ...remote, ref: "dev" })).toBe(false)
    expect(samePackageSourceIdentity(remote, { type: "github", owner: "evil", repo: "review" })).toBe(false)
    expect(samePackageSourceIdentity(undefined, undefined)).toBe(false)
  })

  describe("materializer gate", () => {
    // The verification used to live only in the two callers (install.ts and
    // replay.ts). Anything that reached the materializer directly — the
    // exported entrypoint hosts are told to use — wrote to disk unchecked.
    async function materialize(input: {
      packageRoot: string
      lock?: Parameters<typeof verifyPackageIntegrity>[0]["lock"]
    }) {
      return materializeAgentExtensionSnapshot({
        installs: [{
          desired: {
            id: "review",
            package_name: "review",
            source: remote,
            scope: "project",
            enabled: true,
            targets: ["cursor"],
          },
          ...(input.lock ? { lock: input.lock } : {}),
        }],
        packageRoots: { review: input.packageRoot },
        projectDir: path.join(root, "project"),
        stateRoot: path.join(root, "project", ".agent-extensions"),
        homeDir: path.join(root, "home"),
        now: 100,
      })
    }

    test("refuses to write anything when the package root does not match the lock", async () => {
      const packageRoot = await writePackage("materializer-tamper")
      const digest = await digestDirectory(packageRoot)
      await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: evil\n---\n")

      await expect(materialize({
        packageRoot,
        lock: { source: remote, resolved_sha: "abcdef1234567890", component_digests: { package: digest } },
      })).rejects.toThrow("cache checksum mismatch")
      await expect(fs.stat(path.join(root, "project", ".cursor", "skills", "review"))).rejects.toThrow()
      await expect(fs.stat(path.join(root, "project", ".agent-extensions", "materialized.json"))).rejects.toThrow()
    })

    test("refuses to write anything for a remote install with no lock", async () => {
      const packageRoot = await writePackage("materializer-unlocked")

      await expect(materialize({ packageRoot })).rejects.toThrow("no lock entry")
      await expect(fs.stat(path.join(root, "project", ".cursor", "skills", "review"))).rejects.toThrow()
    })

    test("materializes a verified package end to end", async () => {
      const packageRoot = await writePackage("materializer-ok")

      await expect(materialize({
        packageRoot,
        lock: {
          source: remote,
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
        },
      })).resolves.toMatchObject({
        packages: {
          review: { status: "applied" },
        },
      })
      await expect(fs.readFile(path.join(root, "project", ".cursor", "skills", "review", "SKILL.md"), "utf8"))
        .resolves.toContain("name: review")
    })
  })
})
