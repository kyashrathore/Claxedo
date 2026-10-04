import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionRowStatus } from "@claxedo/server-core/session/navigation-list"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { putSessionMeta, recordSessionLastTurn } from "@claxedo/server-core/session/meta/index"
import { localSessionProjectionStore } from "../../app/local-services"
import { localSessionRowSource } from "./local-session-rows"

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

let dataDir: string
let previous: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-session-rows-"))
  previous = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
})

const idle = (at: number): SessionRowStatus => ({ kind: "idle", awaitingInput: false, at })
const busy: SessionRowStatus = { kind: "busy", awaitingInput: true, at: 9_000 }

function source(live: Map<string, SessionRowStatus> = new Map()) {
  return localSessionRowSource(localSessionProjectionStore(), {
    current: () => idle(5_000),
    snapshot: async () => live,
  })
}

describe("rows from the local projection", () => {
  test("lists a workspace's root sessions, archived included, with the runtime's status where it has one", async () => {
    await putSessionMeta("root", { workspaceID: WS, directory: "/work", title: "Root", createdAt: 1_000, updatedAt: 2_000, lastHumanTurnAt: 1_500 })
    await putSessionMeta("archived", { workspaceID: WS, directory: "/work", archived: 3_000, createdAt: 1_000, updatedAt: 3_000 })
    await putSessionMeta("child", { workspaceID: WS, directory: "/work", parentID: "root", createdAt: 1_000, updatedAt: 2_000 })
    await putSessionMeta("elsewhere", { workspaceID: OTHER, directory: "/other", createdAt: 1_000, updatedAt: 2_000 })
    recordSessionLastTurn(WS, "root", { status: "failed", completedAt: 1_800 })

    const rows = await source(new Map([["root", busy]])).listRows(WS)

    expect(rows.map((row) => row.sessionId).sort()).toEqual(["archived", "root"])
    expect(rows.find((row) => row.sessionId === "root")).toEqual({
      workspaceId: WS,
      sessionId: "root",
      title: "Root",
      createdAt: 1_000,
      updatedAt: 2_000,
      lastHumanTurnAt: 1_500,
      status: busy,
      lastTurn: { status: "failed", completedAt: 1_800 },
    })
    expect(rows.find((row) => row.sessionId === "archived")).toEqual({
      workspaceId: WS,
      sessionId: "archived",
      createdAt: 1_000,
      updatedAt: 3_000,
      archivedAt: 3_000,
      status: idle(5_000),
    })
  })

  test("reads one row, and tells a child and a missing session apart", async () => {
    await putSessionMeta("root", { workspaceID: WS, directory: "/work", createdAt: 1_000, updatedAt: 2_000 })
    await putSessionMeta("child", { workspaceID: WS, directory: "/work", parentID: "root", createdAt: 1_000, updatedAt: 2_000 })
    const rows = source()

    expect(await rows.readRow(WS, "root")).toMatchObject({ kind: "row", row: { sessionId: "root", status: idle(5_000) } })
    expect(await rows.readRow(WS, "child")).toEqual({ kind: "child" })
    expect(await rows.readRow(WS, "gone")).toEqual({ kind: "absent" })
    expect(await rows.readRow(OTHER, "root"), "a row placed in another workspace is absent from this one").toEqual({ kind: "absent" })
  })
})
