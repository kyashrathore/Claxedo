import { expect, test } from "bun:test"
import fs from "node:fs"

test("the hydration routes a runtime mounts cannot grow without an inventory decision", () => {
  const source = fs.readFileSync(new URL("./hydration.ts", import.meta.url), "utf8")
  const routes = [...source.matchAll(/\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)]
    .filter((match) => match[2].startsWith("/"))
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
  expect([...new Set(routes)].sort()).toEqual([
    "POST /api/wr/documents/:sessionId/:documentId/activate",
    "POST /api/wr/documents/:sessionId/:documentId/resolve",
    "POST /api/wr/documents/hydrate",
  ])
})
