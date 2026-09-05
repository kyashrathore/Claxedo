import { expect, test } from "bun:test"
import path from "node:path"
import { PERFORMANCE_CATALOG, performanceCatalog } from "./catalog"
import { repoRoot } from "./storage"
import { FLOWS } from "./flows"

test("catalog entries resolve to real owners and package entrypoints", async () => {
  const entries = await performanceCatalog()
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  expect(PERFORMANCE_CATALOG.filter((entry) => entry.id.startsWith("browser/") && FLOWS.some((flow) => entry.id === `browser/${flow.id}`))).toHaveLength(FLOWS.length)
  for (const entry of entries) {
    const owner = path.join(repoRoot, "packages", entry.owner)
    const manifest = await Bun.file(path.join(owner, "package.json")).json()
    if (entry.entrypoint.startsWith("bun run ")) {
      expect(manifest.scripts[entry.entrypoint.slice(8).split(" ")[0]!]).toBeDefined()
    } else if (!entry.entrypoint.startsWith("bun ")) {
      expect(await Bun.file(path.join(owner, entry.entrypoint)).exists()).toBe(true)
    }
  }
})
