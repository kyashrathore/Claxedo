import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createOpenCodeHost, type OpenCodeHost } from "./host"
import { authorizeWorkspace } from "./scope"
import { createSessionPort } from "./session-port"
import {
  expectationFor,
  toV2Transfer,
  TransferSchemaError,
  validateImported,
  type LegacyTransferEnvelope,
} from "./transfer"

const hosts: OpenCodeHost[] = []
const roots: string[] = []

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-transfer-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close().catch(() => {})))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function legacyEnvelope(directory: string, overrides: Partial<LegacyTransferEnvelope["info"]> = {}): LegacyTransferEnvelope {
  return {
    info: {
      id: "ses_legacy_fixture_0001",
      projectID: "proj_legacy",
      title: "legacy session",
      location: { directory },
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 2, write: 3 } },
      time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
      ...overrides,
    },
    messages: [],
  }
}

test("maps a legacy envelope onto an importable V2 payload", () => {
  const result = toV2Transfer(legacyEnvelope("/tmp/ws"))
  expect(result.payload.info.id).toBe("ses_legacy_fixture_0001")
  expect(result.payload.info.projectID).toBe("proj_legacy")
  expect(result.payload.info.title).toBe("legacy session")
  expect(result.payload.info.location).toEqual({ directory: "/tmp/ws" })
  expect(result.payload.info.tokens).toEqual({
    input: 10,
    output: 20,
    reasoning: 1,
    cache: { read: 2, write: 3 },
  })
})

test("lifts archive state OUT of the SDK payload so Claxedo stays the authority", () => {
  const archived = toV2Transfer(legacyEnvelope("/tmp/ws", { time: { created: 1, updated: 2, archived: 1_234 } }))
  // The SDK has no archive mutation, so importing this field would create a
  // second, unwritable authority that silently disagrees with Claxedo's.
  expect((archived.payload.info.time as Record<string, unknown>).archived).toBeUndefined()
  expect(archived.archivedAt).toBe(1_234)

  const notArchived = toV2Transfer(legacyEnvelope("/tmp/ws"))
  expect(notArchived.archivedAt).toBeUndefined()
})

test("reports fields V2 cannot represent instead of dropping them silently", () => {
  const result = toV2Transfer(legacyEnvelope("/tmp/ws", { tools: { bash: true } }))
  expect(result.droppedFields).toContain("info.tools")
})

test("preserves lineage fields that Unit 6 validation asserts on", () => {
  const result = toV2Transfer(
    legacyEnvelope("/tmp/ws", {
      parentID: "ses_parent",
      agent: "build",
      subpath: "packages/app",
      model: { id: "claude-opus-5", providerID: "anthropic", variant: "default" },
    }),
  )
  expect(result.payload.info.parentID).toBe("ses_parent")
  expect(result.payload.info.agent).toBe("build")
  expect(result.payload.info.subpath).toBe("packages/app")
  expect(result.payload.info.model).toEqual({
    id: "claude-opus-5",
    providerID: "anthropic",
    variant: "default",
  })
})

test("refuses an envelope that cannot be migrated rather than guessing", () => {
  expect(() => toV2Transfer({ info: { ...legacyEnvelope("/tmp/ws").info, id: "" }, messages: [] })).toThrow(
    TransferSchemaError,
  )
  expect(() =>
    toV2Transfer({
      info: { ...legacyEnvelope("/tmp/ws").info, time: { created: Number.NaN as never, updated: 2 } },
      messages: [],
    }),
  ).toThrow(TransferSchemaError)
})

test("validation catches a semantic mismatch after import", () => {
  const expected = expectationFor(legacyEnvelope("/tmp/ws", { parentID: "ses_parent" }))
  expect(validateImported(expected, { id: expected.id, parentID: "ses_parent", title: "legacy session", messageCount: 0 })).toEqual([])

  const failures = validateImported(expected, {
    id: expected.id,
    parentID: undefined,
    title: "legacy session",
    messageCount: 0,
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]!.field).toBe("parentID")
})

test("a real session round-trips through export and the transfer shape", async () => {
  const root = tempRoot()
  const workspace = path.join(root, "ws")
  fs.mkdirSync(workspace)
  const scope = authorizeWorkspace({ workspaceID: "w", directory: workspace })

  const host = createOpenCodeHost({ databasePath: path.join(root, "opencode.db") })
  hosts.push(host)
  const created = await createSessionPort(host).create(scope, { title: "round trip" })

  const client = await host.client()
  const exported = await client.sessions.export({ sessionID: created.id })

  // The exported envelope is the same { info, messages } shape the legacy
  // exporter produces, which is what makes checkpoint 6a -> 6b viable.
  expect(Object.keys(exported).sort()).toEqual(["info", "messages"])
  expect(exported.info.id).toBe(created.id)

  // And it feeds the transformer without special-casing.
  const transferred = toV2Transfer(exported as unknown as LegacyTransferEnvelope)
  expect(transferred.payload.info.id).toBe(created.id)
  expect(transferred.payload.info.title).toBe("round trip")
})
