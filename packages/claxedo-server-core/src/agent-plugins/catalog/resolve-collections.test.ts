import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { resolveCollections } from "./resolve-collections"
import type { CatalogSourceProvider } from "../ports"
import { fileSystemCollectionSource } from "../artifacts/node-tree"

const roots: string[] = []

async function fixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-source-"))
  roots.push(root)
  const plugin = path.join(root, name)
  await fs.mkdir(plugin)
  await fs.writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
  }))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("resolveCollections", () => {
  test("returns only product-supplied sources without personal or organization placeholders", async () => {
    const root = await fixture("review")
    const provider: CatalogSourceProvider = {
      async listAuthorizedSources() {
        return [await fileSystemCollectionSource({ id: "claxedo", kind: "claxedo", label: "Claxedo", revision: "1" }, root)]
      },
    }

    const result = await resolveCollections(provider)

    expect(result.collections.map((collection) => collection.source.kind)).toEqual(["claxedo"])
    expect(result.candidates.map((candidate) => candidate.manifest.name)).toEqual(["review"])
    expect(result.errors).toEqual([])
  })

  test("does not scan a project checkout that the product did not supply as a collection", async () => {
    const collection = await fixture("catalog-plugin")
    await fixture("repo-local-plugin")
    const provider: CatalogSourceProvider = {
      async listAuthorizedSources() {
        return [await fileSystemCollectionSource({ id: "claxedo", kind: "claxedo", label: "Claxedo", revision: "1" }, collection)]
      },
    }

    const result = await resolveCollections(provider)

    expect(result.candidates.map((candidate) => candidate.manifest.name)).toEqual(["catalog-plugin"])
  })

  test("reports an unavailable supplied source without hiding healthy sources", async () => {
    const root = await fixture("review")
    const provider: CatalogSourceProvider = {
      async listAuthorizedSources() {
        return [
          await fileSystemCollectionSource({ id: "claxedo", kind: "claxedo", label: "Claxedo", revision: "1" }, root),
          await fileSystemCollectionSource({ id: "organization", kind: "organization", label: "Team", revision: "2" }, path.join(root, "gone")),
        ]
      },
    }

    const result = await resolveCollections(provider)

    expect(result.candidates.map((candidate) => candidate.manifest.name)).toEqual(["review"])
    expect(result.errors).toEqual([
      expect.objectContaining({ sourceId: "organization", relativePath: ".", code: "source_unavailable" }),
    ])
  })

  test("rejects duplicate source IDs because candidate identity would become ambiguous", async () => {
    const first = await fixture("first")
    const second = await fixture("second")
    const provider: CatalogSourceProvider = {
      async listAuthorizedSources() {
        return [
          await fileSystemCollectionSource({ id: "same", kind: "personal", label: "Mine", revision: "1" }, first),
          await fileSystemCollectionSource({ id: "same", kind: "organization", label: "Team", revision: "1" }, second),
        ]
      },
    }

    await expect(resolveCollections(provider)).rejects.toMatchObject({ code: "duplicate-source-id" })
  })
})
