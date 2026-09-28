import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareCodexProfile } from "."
import type { ResolvedCredentials, TurnActor } from "../../contract"

const projection = { generation: "test", mcpServers: [], pluginRoots: [], notApplied: [] }

async function fixture(run: (input: {
  homeRoot: string; ownerHome: string; owner: TurnActor; credentials: ResolvedCredentials;
  projection: typeof projection;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-credential-policy-"))
  const ownerHome = path.join(root, "owner")
  await fs.mkdir(ownerHome)
  await fs.writeFile(path.join(ownerHome, "auth.json"), "owner-sentinel")
  try {
    await run({ homeRoot: path.join(root, "homes"), ownerHome, owner: { kind: "person", userId: "owner" },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "test" }, projection })
    expect(await fs.readFile(path.join(ownerHome, "auth.json"), "utf8")).toBe("owner-sentinel")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

test.each(["codex-app-server", "openai"])("Codex uses its canonical %s binding without mirroring auth", async (providerId) => {
  await fixture(async (input) => {
    input.credentials.providers = { [providerId]: { baseUrl: "http://localhost:1234", placeholder: "bound", authMode: "api-key" } }
    const result = await prepareCodexProfile(input)
    expect(result.brokered).toBe(true)
    expect(await fs.readdir(result.home)).not.toContain("auth.json")
  })
})

test("only the machine owner without a binding may mirror its login", async () => {
  await fixture(async (input) => {
    const result = await prepareCodexProfile(input)
    expect(result.brokered).toBe(false)
    expect(await fs.readlink(path.join(result.home, "auth.json"))).toBe(await fs.realpath(path.join(input.ownerHome, "auth.json")))
  })
})

test("Codex refuses an unbound member before creating a home", async () => {
  await fixture(async (input) => {
    input.owner = { kind: "person", userId: "member" }
    input.credentials.machineLoginAllowed = false
    await expect(prepareCodexProfile(input)).rejects.toMatchObject({ code: "account_unavailable", retryable: false })
    await expect(fs.stat(input.homeRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

test("an unavailable canonical account refuses even the machine owner", async () => {
  await fixture(async (input) => {
    input.credentials.providers = { openai: { unavailable: true, reason: "revoked" } }
    await expect(prepareCodexProfile(input)).rejects.toMatchObject({ code: "account_unavailable", retryable: false })
    await expect(fs.stat(input.homeRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
