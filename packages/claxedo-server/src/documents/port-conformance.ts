import { expect, test } from "vitest"
import { DocumentVersionConflictError } from "./errors"
import type { DocumentActor, DocumentEntry, DocumentWorkspace } from "./port"

const actor: DocumentActor = { type: "user", id: "conformance-user" }

export type DocumentWorkspaceConformanceFixture = Readonly<{
  workspace: DocumentWorkspace
  entry: DocumentEntry
  dispose: () => Promise<void>
}>

export function documentWorkspaceConformance(
  createFixture: () => Promise<DocumentWorkspaceConformanceFixture>,
) {
  test("port: resolves one canonical document and reads its exact Markdown", async () => {
    const fixture = await createFixture()
    try {
      const handle = await fixture.workspace.resolve(fixture.entry)
      const read = await fixture.workspace.read(handle)

      expect(read.markdown).toBe("# Initial\n")
      expect(read.modifiedAt).toBeGreaterThan(0)
      expect(read.version).toEqual(expect.any(String))
    } finally {
      await fixture.dispose()
    }
  })

  test.each([
    ["EC-A1 preserves a UTF-8 BOM", "\uFEFF# BOM\n"],
    ["EC-A2 preserves CRLF line endings", "# CRLF\r\n\r\nBody\r\n"],
    ["EC-A3 does not normalize Unicode", "# Cafe\u0301\n\n한국어\n"],
    ["EC-A5 preserves an empty file", ""],
    ["EC-A5 preserves a whitespace-only file", " \t  "],
    ["EC-A6 preserves a missing trailing newline", "# No newline"],
  ])("%s", async (_name, markdown) => {
    const fixture = await createFixture()
    try {
      const handle = await fixture.workspace.resolve(fixture.entry)
      const current = await fixture.workspace.read(handle)
      const written = await fixture.workspace.write(handle, {
        markdown,
        expectedVersion: current.version,
        actor,
      })

      expect((await fixture.workspace.read(handle)).markdown).toBe(markdown)
      expect(written.version).toBe((await fixture.workspace.read(handle)).version)
    } finally {
      await fixture.dispose()
    }
  })

  test("port: a stale compare-and-swap write returns a typed conflict", async () => {
    const fixture = await createFixture()
    try {
      const handle = await fixture.workspace.resolve(fixture.entry)
      const original = await fixture.workspace.read(handle)
      const winner = await fixture.workspace.write(handle, {
        markdown: "winner",
        expectedVersion: original.version,
        actor,
      })

      await expect(
        fixture.workspace.write(handle, {
          markdown: "loser",
          expectedVersion: original.version,
          actor,
        }),
      ).rejects.toMatchObject({
        name: "DocumentVersionConflictError",
        code: "document_version_conflict",
        currentVersion: winner.version,
      } satisfies Partial<DocumentVersionConflictError>)
      expect((await fixture.workspace.read(handle)).markdown).toBe("winner")
    } finally {
      await fixture.dispose()
    }
  })

  test("port: snapshot restore is itself compare-and-swap protected", async () => {
    const fixture = await createFixture()
    try {
      const handle = await fixture.workspace.resolve(fixture.entry)
      const original = await fixture.workspace.read(handle)
      const snapshot = await fixture.workspace.snapshot(handle, {
        reason: "conformance",
        actor,
      })
      const changed = await fixture.workspace.write(handle, {
        markdown: "changed",
        expectedVersion: original.version,
        actor,
      })

      await expect(
        fixture.workspace.restore(handle, snapshot.id, {
          expectedVersion: original.version,
          actor,
        }),
      ).rejects.toBeInstanceOf(DocumentVersionConflictError)

      await fixture.workspace.restore(handle, snapshot.id, {
        expectedVersion: changed.version,
        actor,
      })
      expect((await fixture.workspace.read(handle)).markdown).toBe("# Initial\n")
    } finally {
      await fixture.dispose()
    }
  })
}
