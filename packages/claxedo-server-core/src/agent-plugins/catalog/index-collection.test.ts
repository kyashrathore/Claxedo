import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { indexCollection } from "./index-collection"
import { fileSystemCollectionSource } from "../artifacts/node-tree"

const roots: string[] = []

async function collection() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-collection-"))
  roots.push(root)
  return root
}

async function write(root: string, relative: string, content: string) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

const manifest = (name: string) => JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("indexCollection", () => {
  test("indexes immediate valid children and reports invalid siblings", async () => {
    const root = await collection()
    await write(root, "review/plugin.json", manifest("review"))
    await write(root, "review/skills/review/SKILL.md", "---\nname: review\ndescription: Review code\n---\n")
    await write(root, "broken/plugin.json", "not json")
    await write(root, "nested/group/plugin/plugin.json", manifest("too-deep"))
    await write(root, "README.md", "collection docs")

    const result = await indexCollection(await fileSystemCollectionSource({
      id: "claxedo-public",
      kind: "claxedo",
      label: "Claxedo",
      revision: "commit-1",
    }, root))

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      sourceId: "claxedo-public",
      sourceKind: "claxedo",
      relativePath: "review",
      sourceRevision: "commit-1",
      manifest: { name: "review" },
    })
    expect(result.candidates[0]?.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.errors).toEqual([
      expect.objectContaining({ sourceId: "claxedo-public", relativePath: "broken", code: "manifest_invalid" }),
      expect.objectContaining({ sourceId: "claxedo-public", relativePath: "nested", code: "manifest_invalid" }),
    ])
  })

  test("keeps same-name plugins source-scoped without merge or conflict logic", async () => {
    const first = await collection()
    const second = await collection()
    await write(first, "review/plugin.json", manifest("review"))
    await write(second, "review/plugin.json", manifest("review"))

    const a = await indexCollection(await fileSystemCollectionSource({ id: "personal", kind: "personal", label: "Mine", revision: "1" }, first))
    const b = await indexCollection(await fileSystemCollectionSource({ id: "organization", kind: "organization", label: "Team", revision: "1" }, second))

    expect(a.candidates[0]?.pluginInstanceId).not.toBe(b.candidates[0]?.pluginInstanceId)
    expect(a.candidates[0]?.manifest.name).toBe("review")
    expect(b.candidates[0]?.manifest.name).toBe("review")
  })

  test("keeps a valid candidate while exposing its invalid component diagnostics", async () => {
    const root = await collection()
    await write(root, "review/plugin.json", manifest("review"))
    await write(root, "review/skills/broken/SKILL.md", "---\nname: broken\n---\n")
    await write(root, "review/mcp.json", JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        valid: { type: "streamable-http", url: "https://mcp.example.com" },
        broken: { type: "streamable-http", url: "not-a-url" },
      },
    }))

    const result = await indexCollection(await fileSystemCollectionSource({
      id: "claxedo-public",
      kind: "claxedo",
      label: "Claxedo",
      revision: "commit-1",
    }, root))

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.componentDiagnostics).toEqual([
      expect.objectContaining({ code: "skill_invalid", path: "skills/broken/SKILL.md" }),
      expect.objectContaining({ code: "mcp_server_invalid", path: "mcp.json#/mcpServers/broken" }),
    ])
  })

  test("rejects an immediate child that resolves outside the collection", async () => {
    const root = await collection()
    const outside = await collection()
    await write(outside, "plugin.json", manifest("escaped"))
    await fs.symlink(outside, path.join(root, "escaped"), "dir")

    const result = await indexCollection(await fileSystemCollectionSource({
      id: "claxedo-public",
      kind: "claxedo",
      label: "Claxedo",
      revision: "commit-1",
    }, root))

    expect(result.candidates).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ relativePath: "escaped", code: "plugin_root_escape" }),
    ])
  })
})
