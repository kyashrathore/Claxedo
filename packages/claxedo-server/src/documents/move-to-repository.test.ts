import { describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createMoveToRepository } from "./move-to-repository"

type State = {
  source?: string
  repository?: string
  indexed: "managed" | "repository"
  archived?: string
}

describe("moveToRepository", () => {
  test("resumes each crash window without ever losing the only copy", async () => {
    for (const failAfter of ["write", "verify", "flip", "archive"] as const) {
      const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
      const state: State = { source: "# Exact\n", indexed: "managed" }
      let faulted = false
      const move = createMoveToRepository({
        journalRoot: root,
        readManaged: async () => ({ markdown: state.source!, version: "v1" }),
        writeRepository: async (markdown) => {
          state.repository ??= markdown
          if (state.repository !== markdown) throw new Error("destination conflict")
        },
        readRepository: async () => state.repository,
        flipIndex: async () => {
          state.indexed = "repository"
        },
        indexOrigin: async () => state.indexed,
        archiveManaged: async (_input, expectedVersion) => {
          expect(expectedVersion).toBe("v1")
          state.archived = state.source
          state.source = undefined
        },
        restoreManagedIndex: async () => {
          state.indexed = "managed"
        },
        faults: {
          afterRepositoryWrite: () => fail("write"),
          afterRepositoryVerify: () => fail("verify"),
          afterIndexFlip: () => fail("flip"),
          afterManagedArchive: () => fail("archive"),
        },
      })

      await expect(move(request())).rejects.toThrow(`fault:${failAfter}`)
      expect([state.source, state.repository, state.archived].filter(Boolean).length).toBeGreaterThan(0)
      await expect(
        createMoveToRepository({
          journalRoot: root,
          readManaged: async () => {
            if (!state.source) throw new Error("source archived")
            return { markdown: state.source, version: "v1" }
          },
          writeRepository: async (markdown) => {
            state.repository ??= markdown
            if (state.repository !== markdown) throw new Error("destination conflict")
          },
          readRepository: async () => state.repository,
          flipIndex: async () => {
            state.indexed = "repository"
          },
          indexOrigin: async () => state.indexed,
          archiveManaged: async () => {
            if (!state.source) return
            state.archived = state.source
            state.source = undefined
          },
          restoreManagedIndex: async () => {
            state.indexed = "managed"
          },
        })(request()),
      ).resolves.toMatchObject({ state: "complete" })
      expect(state.indexed).toBe("repository")
      expect(state.repository).toBe("# Exact\n")
      expect(state.archived).toBe("# Exact\n")
      await fs.rm(root, { recursive: true, force: true })

      function fail(stage: typeof failAfter) {
        if (stage !== failAfter || faulted) return
        faulted = true
        throw new Error(`fault:${stage}`)
      }
    }
  })

  test("refuses to archive a managed source that changed after verification", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    let source = "first"
    let repository: string | undefined
    let origin: "managed" | "repository" = "managed"
    const move = createMoveToRepository({
      journalRoot: root,
      readManaged: async () => ({ markdown: source, version: source }),
      writeRepository: async (markdown) => {
        repository = markdown
      },
      readRepository: async () => repository,
      flipIndex: async () => {
        origin = "repository"
        source = "second"
      },
      indexOrigin: async () => origin,
      archiveManaged: async (_input, expectedVersion) => {
        if (source !== expectedVersion) throw new Error("managed source changed")
        source = ""
      },
      restoreManagedIndex: async () => {
        origin = "managed"
      },
    })

    await expect(move(request())).rejects.toThrow("managed source changed")
    expect(repository).toBe("first")
    expect(source).toBe("second")
    expect(origin).toBe("managed")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("resets a stale journal after an archive race so a newer source can move safely", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    let source = { markdown: "first", version: "v1" }
    let indexed: "managed" | "repository" = "managed"
    let archiveAttempts = 0
    let restoreFaulted = false
    const repositories = new Map<string, string>()
    const move = createMoveToRepository({
      journalRoot: root,
      readManaged: async () => source,
      writeRepository: async (markdown, input) => {
        const existing = repositories.get(input.relativePath)
        if (existing !== undefined && existing !== markdown) throw new Error("destination conflict")
        repositories.set(input.relativePath, markdown)
      },
      readRepository: async (input) => repositories.get(input.relativePath),
      flipIndex: async () => {
        indexed = "repository"
      },
      indexOrigin: async () => indexed,
      archiveManaged: async (_input, expectedVersion) => {
        archiveAttempts++
        if (archiveAttempts === 1) {
          source = { markdown: "second", version: "v2" }
          throw new Error(`managed source changed from ${expectedVersion}`)
        }
        if (expectedVersion !== source.version) throw new Error(`managed source changed from ${expectedVersion}`)
        expect(expectedVersion).toBe("v2")
        source = { markdown: "", version: "archived" }
      },
      restoreManagedIndex: async () => {
        indexed = "managed"
      },
      faults: {
        afterManagedIndexRestore: () => {
          if (restoreFaulted) return
          restoreFaulted = true
          throw new Error("fault:managed-index-restored")
        },
      },
    })

    await expect(move(request())).rejects.toThrow("fault:managed-index-restored")
    expect(indexed).toBe("managed")
    expect(source).toEqual({ markdown: "second", version: "v2" })
    expect(repositories.get(request().relativePath)).toBe("first")
    expect(await fs.readdir(root)).toHaveLength(1)

    await expect(move(request())).rejects.toThrow("Managed source changed before the repository index flip")
    expect(await fs.readdir(root)).toEqual([])

    await expect(move({ ...request(), relativePath: "docs/retried.md" })).resolves.toMatchObject({
      state: "complete",
      markdown: "second",
      sourceVersion: "v2",
    })
    expect(indexed).toBe("repository")
    expect(repositories).toEqual(
      new Map([
        ["docs/document.md", "first"],
        ["docs/retried.md", "second"],
      ]),
    )
    await fs.rm(root, { recursive: true, force: true })
  })

  test("reconciles a restored index after a crash before the journal reset", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    let source: string | undefined = "exact"
    let repository: string | undefined
    let archived: string | undefined
    let indexed: "managed" | "repository" = "managed"
    let archiveAttempts = 0
    let restoreFaulted = false
    const move = createMoveToRepository({
      journalRoot: root,
      readManaged: async () => ({ markdown: source!, version: "v1" }),
      writeRepository: async (markdown) => {
        repository = markdown
      },
      readRepository: async () => repository,
      flipIndex: async () => {
        indexed = "repository"
      },
      indexOrigin: async () => indexed,
      archiveManaged: async () => {
        archiveAttempts++
        if (archiveAttempts === 1) throw new Error("transient archive failure")
        archived = source
        source = undefined
      },
      restoreManagedIndex: async () => {
        indexed = "managed"
      },
      faults: {
        afterManagedIndexRestore: () => {
          if (restoreFaulted) return
          restoreFaulted = true
          throw new Error("fault:managed-index-restored")
        },
      },
    })

    await expect(move(request())).rejects.toThrow("fault:managed-index-restored")
    expect(indexed).toBe("managed")
    expect(source).toBe("exact")
    expect(await fs.readdir(root)).toHaveLength(1)

    await expect(move(request())).resolves.toMatchObject({ state: "complete" })
    expect(indexed).toBe("repository")
    expect(repository).toBe("exact")
    expect(archived).toBe("exact")
    expect(source).toBeUndefined()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("re-verifies a destination after restart before flipping the index", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    let repository: string | undefined
    const options = {
      journalRoot: root,
      readManaged: async () => ({ markdown: "exact", version: "v1" }),
      writeRepository: async (markdown: string) => {
        repository = markdown
      },
      readRepository: async () => repository,
      flipIndex: async () => {
        throw new Error("must not flip")
      },
      indexOrigin: async () => "managed" as const,
      archiveManaged: async () => {},
      restoreManagedIndex: async () => {},
    }
    await expect(
      createMoveToRepository({
        ...options,
        faults: {
          afterRepositoryVerify: () => {
            repository = "replaced"
            throw new Error("crash")
          },
        },
      })(request()),
    ).rejects.toThrow("crash")

    await expect(createMoveToRepository(options)(request())).rejects.toThrow(
      "Repository destination did not preserve the managed document bytes",
    )
    await fs.rm(root, { recursive: true, force: true })
  })

  test("reinstalls an exact destination lost after a durable journal write", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    let repository: string | undefined
    let origin: "managed" | "repository" = "managed"
    const options = {
      journalRoot: root,
      readManaged: async () => ({ markdown: "exact", version: "v1" }),
      writeRepository: async (markdown: string) => {
        repository = markdown
      },
      readRepository: async () => repository,
      flipIndex: async () => {
        origin = "repository"
      },
      indexOrigin: async () => origin,
      archiveManaged: async () => {},
      restoreManagedIndex: async () => {
        origin = "managed"
      },
    }
    await expect(
      createMoveToRepository({
        ...options,
        faults: {
          afterRepositoryWrite: () => {
            repository = undefined
            throw new Error("crash")
          },
        },
      })(request()),
    ).rejects.toThrow("crash")

    await expect(createMoveToRepository(options)(request())).resolves.toMatchObject({ state: "complete" })
    expect(repository).toBe("exact")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("serializes concurrent first moves and rejects a different destination without archiving twice", async () => {
    const root = path.join(os.tmpdir(), `document-move-${randomUUID()}`)
    const entered = deferred()
    const release = deferred()
    const repositories = new Map<string, string>()
    let indexed: string | undefined
    let archives = 0
    const move = createMoveToRepository({
      journalRoot: root,
      readManaged: async () => ({ markdown: "exact", version: "v1" }),
      writeRepository: async (markdown, input) => {
        repositories.set(input.relativePath, markdown)
      },
      readRepository: async (input) => repositories.get(input.relativePath),
      flipIndex: async (input) => {
        indexed = input.relativePath
      },
      indexOrigin: async () => (indexed ? "repository" : "managed"),
      archiveManaged: async () => {
        archives++
      },
      restoreManagedIndex: async () => {
        indexed = undefined
      },
      faults: {
        afterRepositoryWrite: async () => {
          entered.resolve()
          await release.promise
        },
      },
    })
    const firstRequest = request()
    const secondRequest = { ...request(), workspaceId: "workspace_2", relativePath: "docs/other.md" }
    const first = move(firstRequest)
    await entered.promise
    const second = move(secondRequest)
    await Promise.resolve()

    expect(repositories.has(secondRequest.relativePath)).toBe(false)
    release.resolve()
    await expect(first).resolves.toMatchObject({ state: "complete", relativePath: firstRequest.relativePath })
    await expect(second).rejects.toThrow("different repository move in progress")
    expect(indexed).toBe(firstRequest.relativePath)
    expect(repositories).toEqual(new Map([[firstRequest.relativePath, "exact"]]))
    expect(archives).toBe(1)
    const journal = JSON.parse(await fs.readFile(path.join(root, (await fs.readdir(root))[0]!), "utf8"))
    expect(journal).toMatchObject({
      state: "complete",
      workspaceId: firstRequest.workspaceId,
      relativePath: firstRequest.relativePath,
    })
    await fs.rm(root, { recursive: true, force: true })
  })
})

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function request() {
  return {
    orgId: "org_1",
    projectId: "project_1",
    documentId: "document_1",
    workspaceId: "workspace_1",
    relativePath: "docs/document.md",
    managedRelativePath: "project_1/document_1/exact.md",
  }
}
