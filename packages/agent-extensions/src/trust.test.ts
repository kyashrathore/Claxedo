import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  grantProjectExtensionTrust,
  installFingerprint,
  projectExtensionTrustPath,
  readProjectExtensionTrust,
  resolveProjectExtensionTrust,
  revokeProjectExtensionTrust,
} from "./trust"
import { installCachedAgentExtension } from "./install"
import { installedStatePath, readDesiredExtensionState } from "./state"
import { FIRST_PARTY_AGENT_EXTENSIONS_DIR } from "./types"

const root = path.join(os.tmpdir(), `agent-extensions-trust-${randomUUID().slice(0, 8)}`)
const source = path.join(root, "source")
const project = path.join(root, "project")
const home = path.join(root, "home")
const data = path.join(root, "data")

async function seedInstalledState(projectDir: string, overrides: Partial<{ owner: string; id: string; enabled: boolean }> = {}) {
  const dir = path.join(projectDir, ".agent-extensions")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "installed.json"), JSON.stringify({
    version: 1,
    installs: [{
      id: overrides.id ?? "review",
      package_name: "review",
      source: { type: "github", owner: overrides.owner ?? "acme", repo: "review" },
      scope: "project",
      enabled: overrides.enabled ?? true,
      targets: ["cursor"],
      installed_at: 100,
      updated_at: 100,
    }],
  }))
}

describe("Agent Extensions project trust ledger", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\n")
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("scoped grant, resolve, and revoke round trip", async () => {
    await seedInstalledState(project)
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })

    const granted = await grantProjectExtensionTrust({
      dataRoot: data,
      projectDir: project,
      installIds: ["review"],
      now: 100,
    })
    expect(granted).toEqual({ installIds: ["review"], firstParty: false })
    await expect(readProjectExtensionTrust(projectExtensionTrustPath({ dataRoot: data }))).resolves.toMatchObject({
      version: 1,
      projects: {
        [path.resolve(project)]: { granted_at: 100, installs: { review: { fingerprint: expect.any(String) } } },
      },
    })

    // Granting the first-party directory merges; it does not reset installs.
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, firstParty: true })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: ["review"],
      firstParty: true,
    })

    await expect(revokeProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toBe(true)
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
    await expect(revokeProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toBe(false)
  })

  test("trust is per project directory", async () => {
    const other = path.join(root, "other-project")
    await fs.mkdir(other, { recursive: true })
    await seedInstalledState(project)
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      installIds: ["review"],
    })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: other })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
  })

  test("in-place edits to a trusted first-party component invalidate its grant", async () => {
    const skillDir = path.join(project, FIRST_PARTY_AGENT_EXTENSIONS_DIR, "skills", "review")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "benign")
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, firstParty: true })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      firstParty: true,
    })

    // A pulled commit rewriting the component in place — same path list —
    // must not ride the old grant.
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "pwned")
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      firstParty: false,
    })
  })

  test("a source-only retarget invalidates an install grant", async () => {
    await seedInstalledState(project)
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })

    // Unit level: rows differing ONLY in source fingerprint differently.
    const state = await readDesiredExtensionState(installedStatePath({ scope: "project", projectDir: project }))
    const row = state.installs[0]!
    const retargeted = { ...row, source: { ...row.source, owner: "attacker" } }
    expect(installFingerprint({ install: row })).not.toBe(installFingerprint({ install: retargeted }))

    // End to end: rewrite the row holding every other field constant.
    await seedInstalledState(project, { owner: "attacker" })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
  })

  test("lifecycle timestamp churn does not invalidate a grant", async () => {
    await seedInstalledState(project)
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })
    const file = installedStatePath({ scope: "project", projectDir: project })
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { installs: Array<Record<string, unknown>> }
    parsed.installs[0]!.installed_at = 999
    parsed.installs[0]!.updated_at = 999
    await fs.writeFile(file, JSON.stringify(parsed))
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      installIds: ["review"],
    })
  })

  test("an enabled flip is a declaration change and invalidates a grant", async () => {
    await seedInstalledState(project)
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })
    await seedInstalledState(project, { enabled: false })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
  })

  test("unreadable ledgers and undeclarable state fail closed", async () => {
    await seedInstalledState(project)
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })

    await fs.writeFile(projectExtensionTrustPath({ dataRoot: data }), "{not json")
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })

    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, installIds: ["review"] })
    await fs.writeFile(installedStatePath({ scope: "project", projectDir: project }), "{corrupt")
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
  })

  test("corrupt install state does not discard an independently valid first-party grant", async () => {
    const skillDir = path.join(project, FIRST_PARTY_AGENT_EXTENSIONS_DIR, "skills", "review")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "benign")
    await grantProjectExtensionTrust({ dataRoot: data, projectDir: project, firstParty: true })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      firstParty: true,
    })

    await fs.mkdir(path.join(project, ".agent-extensions"), { recursive: true })
    await fs.writeFile(installedStatePath({ scope: "project", projectDir: project }), "{corrupt")

    // Install grants are gone, but the first-party consent was verified
    // against content that never became unreadable.
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: true,
    })
  })

  test("an explicit lifecycle install grants only the id it acted on", async () => {
    // The checkout also ships an unrelated row and a first-party component;
    // installing one package must not bless either.
    await seedInstalledState(project, { id: "shipped" })
    const skillDir = path.join(project, FIRST_PARTY_AGENT_EXTENSIONS_DIR, "skills", "extra")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "extra")

    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "mine",
      now: 100,
    })

    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: ["mine"],
      firstParty: false,
    })
  })

  test("a checkout-declared machine-scope row is never blessable (checkout escape)", async () => {
    // A repo ships a row claiming scope:"machine"; if a bulk grant honored
    // it, its components would materialize into $HOME runner dirs and persist
    // after the checkout is gone. Project ledgers vouch for project scope only.
    const dir = path.join(project, ".agent-extensions")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "installed.json"), JSON.stringify({
      version: 1,
      installs: [{
        id: "vendor-tools",
        package_name: "vendor-tools",
        source: { type: "project", package_path: "vendor/payload" },
        scope: "machine",
        enabled: true,
        targets: ["claude", "codex"],
        installed_at: 1,
        updated_at: 1,
      }],
    }))

    const granted = await grantProjectExtensionTrust({
      dataRoot: data,
      projectDir: project,
      installIds: ["vendor-tools"],
      firstParty: true,
      now: 100,
    })
    expect(granted.installIds).toEqual([])
  })

  test("uninstall withdraws the grant so identical bytes cannot resurrect the install", async () => {
    const extensions = (await import("./facade")).createAgentExtensions({
      projectDir: project,
      homeDir: home,
      dataRoot: data,
    })
    await fs.mkdir(path.join(project, "packages", "review"), { recursive: true })
    await fs.writeFile(path.join(project, "packages", "review", "SKILL.md"), "---\nname: review\n---\n")
    await extensions.installCached({ packagePath: "packages/review", id: "review", targets: ["cursor"] })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toMatchObject({
      installIds: ["review"],
    })

    await extensions.uninstall({ id: "review" })
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })

    // Restoring the exact pre-uninstall declaration from git history must not
    // ride the withdrawn grant: no grant entry exists for this id anymore.
    await seedInstalledState(project)
    await expect(resolveProjectExtensionTrust({ dataRoot: data, projectDir: project })).resolves.toEqual({
      installIds: [],
      firstParty: false,
    })
  })
})
