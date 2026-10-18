/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { placementId, projectId, sessionId, type Placement, type ProjectId, type Server, type SessionFirstPagesInput, type SessionListInput, type SessionRow } from "@/server"
import type { RequestsInternal } from "../requests/store"
import { createSessionList } from "./store"

const ALPHA = projectId("prj_alpha")
const BETA = projectId("prj_beta")

const placement = (project: string): Placement => ({ id: placementId(`ws_${project}`), projectId: projectId(project), kind: "cloud", reachable: true, onThisMachine: false } as unknown as Placement)
const row = (project: string, id: string): SessionRow => ({ ref: { projectId: projectId(project), placementId: placementId(`ws_${project}`), sessionId: sessionId(id) }, title: id, createdAt: 1, updatedAt: 1, lastHumanTurnAt: 10 })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function world() {
  const [placements, setPlacements] = createSignal<readonly Placement[]>([placement("prj_alpha")])
  const asked: string[] = []
  const rows = new Map<string, SessionRow[]>()
  let failing = false
  const list = async (input: SessionListInput) => {
    const project = "projectId" in input ? input.projectId : "every"
    asked.push(project)
    if (failing) throw new Error("list unavailable")
    return { rows: rows.get(project) ?? [], statuses: new Map(), readers: new Map(), nextAfter: undefined }
  }
  const server = {
    placements: { list: placements, load: async () => placements(), byId: (id: string) => placements().find((candidate) => candidate.id === id) },
    sessions: { list, firstPages: (input: SessionFirstPagesInput) => ({ page: (projectId: ProjectId) => list({ ...input, projectId }) }) },
  } as unknown as Server
  const requests = { openBySession: () => new Map() } as unknown as RequestsInternal
  return { server, requests, asked, rows, setPlacements, placements, failLists: () => (failing = true) }
}

test("a project that joins the catalog while the list is live gets its first page read at once, so a session created there is listed without a re-read", async () => {
  await createRoot(async (dispose) => {
    const { server, requests, asked, rows, setPlacements, placements } = world()
    const list = createSessionList(server, requests, { showSettled: () => false, activityShown: () => false })
    list.start()
    await settled()
    expect(list.state().kind).toBe("live")
    expect(asked).toEqual([ALPHA])
    const created = row("prj_beta", "ses_new")
    rows.set(BETA, [created])
    setPlacements([...placements(), placement("prj_beta")])
    await settled()
    expect(asked).toEqual([ALPHA, BETA])
    expect(list.order()).toEqual([created.ref])
    expect(list.hasMore(BETA)).toBe(false)
    dispose()
  })
})

test("a project whose first page failed keeps its failure for the rail's Retry instead of being read again on its own", async () => {
  await createRoot(async (dispose) => {
    const { server, requests, asked, setPlacements, placements, failLists } = world()
    const list = createSessionList(server, requests, { showSettled: () => false, activityShown: () => false })
    list.start()
    await settled()
    failLists()
    setPlacements([...placements(), placement("prj_beta")])
    await settled()
    expect(asked).toEqual([ALPHA, BETA])
    expect(list.pageFailure(BETA)?.message).toBe("list unavailable")
    expect(list.order()).toEqual([])
    dispose()
  })
})
