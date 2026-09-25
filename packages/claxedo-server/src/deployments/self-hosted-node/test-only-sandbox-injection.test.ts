import { expect, test } from "vitest"
import fs from "node:fs/promises"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"
import { localBrokeringTestDriverCatalogEntry, sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"

test("product composition cannot select the local broker by id or environment", async () => {
  expect(isSandboxDriverID(localBrokeringTestDriverCatalogEntry.id)).toBe(false)
  expect(Object.hasOwn(sandboxDriverCatalog, localBrokeringTestDriverCatalogEntry.id)).toBe(false)
  const entry = await fs.readFile(new URL("./index.ts", import.meta.url), "utf8")
  expect(entry).toMatch(/startSelfHostedServer\(\{ port \}\)/)
  expect(entry).not.toContain("sandboxDriver:")
  const composition = await fs.readFile(new URL("./app.ts", import.meta.url), "utf8")
  expect(composition.slice(composition.indexOf("export function startServer("))).not.toContain("sandboxDriver")
})
