import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listPiCatalogModels } from "./catalog"
import { piPackageRoot, resolvePiExecutable } from "./executable"

test("a scripted fixture is not the Pi package, so it has no catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-"))
  try {
    const binary = path.join(root, "pi.mjs")
    await fs.writeFile(binary, "export {}\n")
    expect(piPackageRoot(binary)).toBeUndefined()
    expect(await listPiCatalogModels(binary, path.join(root, "agent"))).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(!resolvePiExecutable())("lists Pi's credential-blind catalog without API keys", async () => {
  const binary = resolvePiExecutable()!
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-agent-"))
  try {
    expect(piPackageRoot(binary)).toContain("pi-coding-agent")
    const models = await listPiCatalogModels(binary, agentDir)
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((model) => model.id.startsWith("anthropic/"))).toBe(true)
    expect(models.some((model) => model.id.startsWith("openai/"))).toBe(true)
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true })
  }
})
