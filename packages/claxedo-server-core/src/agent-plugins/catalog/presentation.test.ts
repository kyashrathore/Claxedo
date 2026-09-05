import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { fileSystemCollectionSource, inspectPluginDirectory } from "../artifacts/node-tree"
import { indexCollection } from "./index-collection"
import { candidatePresentation, retainedPresentation } from "./presentation"
import type { AgentPluginCollectionSource } from "./types"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function collection() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-presentation-"))
  roots.push(root)
  return root
}

async function write(root: string, relative: string, content: string) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

function manifest(name: string, extensions?: Record<string, Record<string, unknown>>) {
  return JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    ...(extensions ? { extensions } : {}),
  })
}

async function candidates(
  root: string,
  metadata: Partial<Omit<AgentPluginCollectionSource, "plugins" | "errors">> = {},
) {
  const indexed = await indexCollection(await fileSystemCollectionSource({
    id: "claxedo",
    kind: "claxedo",
    label: "Claxedo",
    revision: "commit-1",
    ...metadata,
  }, root))
  return new Map(indexed.candidates.map((candidate) => [candidate.relativePath, candidate]))
}

describe("agent plugin candidate presentation", () => {
  test("prefers a declared https icon and falls back to the name monogram", async () => {
    const root = await collection()
    await write(root, "docs/plugin.json", manifest("docs", { claxedo: { icon: "https://cdn.example/docs.png" } }))
    await write(root, "insecure/plugin.json", manifest("insecure", { claxedo: { icon: "http://cdn.example/x.png" } }))
    await write(root, "nonsense/plugin.json", manifest("nonsense", { claxedo: { icon: 42 } }))
    await write(root, "code-review/plugin.json", manifest("code-review"))
    await write(root, "single/plugin.json", manifest("single"))
    await write(root, "long/plugin.json", manifest("a.b.c.d"))
    const indexed = await candidates(root)

    const icon = (relativePath: string) => candidatePresentation({ candidate: indexed.get(relativePath)! }).icon

    expect(icon("docs")).toEqual({ kind: "url", url: "https://cdn.example/docs.png" })
    // A renderer fetches the icon, so anything but https falls back rather than
    // asking the user's browser for a plaintext request.
    expect(icon("insecure")).toEqual({ kind: "monogram", text: "I" })
    expect(icon("nonsense")).toEqual({ kind: "monogram", text: "N" })
    expect(icon("code-review")).toEqual({ kind: "monogram", text: "CR" })
    expect(icon("single")).toEqual({ kind: "monogram", text: "S" })
    expect(icon("long")).toEqual({ kind: "monogram", text: "AB" })
  })

  test("projects the validated skills of the candidate and the source it came from", async () => {
    const root = await collection()
    await write(root, "docs/plugin.json", manifest("docs"))
    await write(root, "docs/skills/search/SKILL.md", "---\nname: search\ndescription: Search the docs\n---\n\nbody\n")
    await write(root, "docs/skills/write/SKILL.md", "---\nname: write\ndescription: Write a doc\n---\n")
    await write(root, "docs/skills/broken/SKILL.md", "---\nname: broken\n---\n")
    const indexed = await candidates(root, {
      id: "personal-1",
      kind: "personal",
      label: "kyashrathore/plugins",
      repository: "kyashrathore/plugins",
    })

    const presentation = candidatePresentation({ candidate: indexed.get("docs")! })

    expect(presentation.skills).toEqual([
      { name: "search", description: "Search the docs", path: "skills/search" },
      { name: "write", description: "Write a doc", path: "skills/write" },
    ])
    expect(presentation.source).toEqual({
      id: "personal-1",
      kind: "personal",
      label: "kyashrathore/plugins",
      repository: "kyashrathore/plugins",
    })
  })

  test("omits the repository for a source that names none", async () => {
    const root = await collection()
    await write(root, "docs/plugin.json", manifest("docs"))
    const indexed = await candidates(root)

    expect(candidatePresentation({ candidate: indexed.get("docs")! }).source).toEqual({
      id: "claxedo",
      kind: "claxedo",
      label: "Claxedo",
    })
  })

  test("lets the retained artifact's skills win over the source's, as its MCP servers already do", async () => {
    const root = await collection()
    await write(root, "docs/plugin.json", manifest("docs"))
    await write(root, "docs/skills/search/SKILL.md", "---\nname: search\ndescription: Newer source skill\n---\n")
    const indexed = await candidates(root)

    const retainedRoot = await collection()
    await write(retainedRoot, "plugin.json", manifest("docs"))
    await write(retainedRoot, "skills/search/SKILL.md", "---\nname: search\ndescription: Retained skill\n---\n")
    const retained = (await inspectPluginDirectory(retainedRoot)).plugin

    expect(candidatePresentation({ candidate: indexed.get("docs")!, retained }).skills)
      .toEqual([{ name: "search", description: "Retained skill", path: "skills/search" }])
  })

  test("reads a plugin whose source is gone from its retained artifact and names no source", async () => {
    const retainedRoot = await collection()
    await write(retainedRoot, "plugin.json", manifest("code-review", { claxedo: { icon: "https://cdn.example/cr.png" } }))
    await write(retainedRoot, "skills/review/SKILL.md", "---\nname: review\ndescription: Review a diff\n---\n")
    const retained = (await inspectPluginDirectory(retainedRoot)).plugin

    expect(retainedPresentation(retained)).toEqual({
      icon: { kind: "url", url: "https://cdn.example/cr.png" },
      skills: [{ name: "review", description: "Review a diff", path: "skills/review" }],
      source: null,
    })
  })

  test("has neither icon nor skills when the retained artifact is unreadable", async () => {
    expect(retainedPresentation(undefined)).toEqual({ skills: [], source: null })
  })
})
