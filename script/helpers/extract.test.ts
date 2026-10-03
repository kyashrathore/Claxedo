import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { inventory } from "./extract"

test("inventory excludes native test fixtures while keeping production and support owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-helper-inventory-"))
  const files = {
    "src/attention.node-test.ts": "function attentionFixture() { return { sessionId: 'attention' } }",
    "src/session-delete.node-test.ts": "function deletionFixture() { return { sessionId: 'deletion' } }",
    "src/session-attention.node-test.tsx": "function routeFixture() { return { sessionId: 'route' } }",
    "src/reader.test.ts": "function standardFixture() { return { sessionId: 'reader' } }",
    "src/reader.node.ts": "export function readNativeSession() { return { sessionId: 'production' } }",
    "src/reader.test-support.ts": "export function seedReaderFixture() { return { sessionId: 'reader' } }",
    "scripts/seed.ts": "export function seedSessions() { return { sessionId: 'seed' } }",
  }
  try {
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(root, "packages/example", file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
    const helpers = inventory({ root })
    expect(helpers.map(({ name, shipped }) => ({ name, shipped })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual([
        { name: "readNativeSession", shipped: true },
        { name: "seedReaderFixture", shipped: false },
        { name: "seedSessions", shipped: false },
      ])
    expect(helpers.every((helper) => helper.file.startsWith(`packages${path.sep}example${path.sep}`))).toBe(true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
