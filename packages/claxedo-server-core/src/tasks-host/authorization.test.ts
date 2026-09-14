/**
 * What a session's Tasks grant may name, decided at the door: the workspace a
 * created task prefers, the provenance it claims, the session a link opens,
 * and the workspace a Start would run in. The routes, store and bridge are not
 * here; what is pinned is the identity the two signed compositions share.
 * Every workspace lookup goes through the capability port the grant was
 * admitted by, so the authority here answers only for sessions.
 */
import { describe, expect, test, vi } from "vitest"
import { createMemoryTasksStore, fakeBridge, presetRow, taskRow } from "@claxedo/tasks/test-support"
import type { StartPreviewCommand, TasksActor } from "@claxedo/tasks"
import type { WorkspaceAuthority } from "../platform/auth/authority"
import type { TasksCapabilityOwner, TasksCapabilityScope } from "./capability"
import { signedTasksIdentity } from "./contribution"

const SCOPE: TasksCapabilityScope = {
  userId: "alice",
  orgId: "org-1",
  projectId: "project-a",
  workspaceId: "ws_root",
  sessionId: "ses_1",
  operations: ["read", "create", "start"],
}

const ALICE = { userId: "alice", actorId: "actor:alice", orgId: "org-1" }

/** Three of alice's workspaces: the grant's own, a sibling in the same project, and one in another project. */
const OWNERS: Record<string, TasksCapabilityOwner> = {
  ws_root: { ...ALICE, projectId: "project-a" },
  ws_sibling: { ...ALICE, projectId: "project-a" },
  ws_other: { ...ALICE, projectId: "project-b" },
}

function identity(options: { scope?: TasksCapabilityScope; authorizeRuntimeSession?: WorkspaceAuthority["authorizeRuntimeSession"] } = {}) {
  const scope = options.scope ?? SCOPE
  const authority = {
    authorizeSessionRead: vi.fn(async () => undefined),
    ...(options.authorizeRuntimeSession ? { authorizeRuntimeSession: options.authorizeRuntimeSession } : {}),
  } as unknown as WorkspaceAuthority
  const composed = signedTasksIdentity({
    authority,
    signed: async () => ({ error: "unsigned", status: 401 }),
    capability: {
      verify: async (token) => (token === "grant" ? scope : undefined),
      workspaceOwner: async (workspaceId) => OWNERS[workspaceId],
    },
  })
  return { ...composed, authority }
}

const TASKS = "https://core.test/api/claxedo/tasks"

function createRequest(input: Record<string, unknown>) {
  return new Request(`${TASKS}/commands`, {
    method: "POST",
    headers: { authorization: "Bearer grant", "content-type": "application/json" },
    body: JSON.stringify({
      clientRequestId: "agent-1",
      command: {
        type: "task.create",
        input: { projectId: "project-a", title: "Probe", description: "", workspaceId: null, parentTaskId: null, ...input },
      },
    }),
  })
}

async function actorOf(composed: ReturnType<typeof identity>): Promise<TasksActor> {
  const admitted = await composed.authenticate(createRequest({}))
  if (!("actor" in admitted)) throw new Error(`the grant was refused: ${admitted.error}`)
  return admitted.actor
}

const refusal = async (composed: ReturnType<typeof identity>, request: Request) => {
  const answer = await composed.authenticate(request)
  return "actor" in answer ? "admitted" : `${answer.status} ${answer.error}`
}

describe("a Tasks grant creating a task", () => {
  test("may prefer its own workspace or none", async () => {
    const composed = identity()
    expect(await refusal(composed, createRequest({ workspaceId: null }))).toBe("admitted")
    expect(await refusal(composed, createRequest({ workspaceId: "ws_root" }))).toBe("admitted")
    expect(await refusal(composed, createRequest({}))).toBe("admitted")
  })

  test("may prefer a sibling workspace of its own project", async () => {
    expect(await refusal(identity(), createRequest({ workspaceId: "ws_sibling" }))).toBe("admitted")
  })

  test("may not direct the task into another project's workspace, nor one the authority cannot place", async () => {
    const composed = identity()
    expect(await refusal(composed, createRequest({ workspaceId: "ws_other" }))).toBe(
      "403 This session may act only in project project-a",
    )
    expect(await refusal(composed, createRequest({ workspaceId: "ws_unknown" }))).toBe(
      "403 This session may act only in project project-a",
    )
  })

  test("may record itself as the task's provenance, and nothing else", async () => {
    const composed = identity()
    expect(await refusal(composed, createRequest({ createdFrom: { workspaceId: "ws_root", sessionId: "ses_1" } }))).toBe("admitted")
    expect(await refusal(composed, createRequest({ createdFrom: { workspaceId: "ws_victim", sessionId: "ses_victim" } }))).toBe(
      "403 This session may record only itself as a task's provenance",
    )
    expect(await refusal(composed, createRequest({ createdFrom: { workspaceId: "ws_root", sessionId: "ses_2" } }))).toBe(
      "403 This session may record only itself as a task's provenance",
    )
    expect(await refusal(composed, createRequest({ createdFrom: { workspaceId: null, sessionId: "ses_1" } }))).toBe(
      "403 This session may record only itself as a task's provenance",
    )
  })

  test("minted for no session in particular may record no provenance at all", async () => {
    const { sessionId: _sessionId, ...sessionless } = SCOPE
    const composed = identity({ scope: sessionless })
    expect(await refusal(composed, createRequest({}))).toBe("admitted")
    expect(await refusal(composed, createRequest({ createdFrom: { workspaceId: "ws_root", sessionId: "ses_1" } }))).toBe(
      "403 This session may record only itself as a task's provenance",
    )
  })
})

describe("a Tasks grant opening a linked session", () => {
  test("is answered by the session authority as the workspace's owner, never as the token", async () => {
    const authorizeRuntimeSession = vi.fn(async () => undefined)
    const composed = identity({ authorizeRuntimeSession })
    const actor = await actorOf(composed)

    expect(await composed.authorization.authorizeSessionOpen(actor, { sessionId: "ses_9", workspaceId: "ws_root" })).toBe(true)
    expect(authorizeRuntimeSession).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor:alice",
      actorKind: "human",
      sessionId: "ses_9",
      workspaceId: "ws_root",
      action: "read",
    })
    expect(composed.authority.authorizeSessionRead).not.toHaveBeenCalled()
  })

  test("is refused a session the owner may not open", async () => {
    const authorizeRuntimeSession = vi.fn(async () => {
      throw new Error("denied")
    })
    const composed = identity({ authorizeRuntimeSession })
    const actor = await actorOf(composed)
    expect(await composed.authorization.authorizeSessionOpen(actor, { sessionId: "ses_9", workspaceId: "ws_root" })).toBe(false)
  })

  test("is refused a session outside its project before the authority is asked", async () => {
    const authorizeRuntimeSession = vi.fn(async () => undefined)
    const composed = identity({ authorizeRuntimeSession })
    const actor = await actorOf(composed)
    expect(await composed.authorization.authorizeSessionOpen(actor, { sessionId: "ses_9", workspaceId: "ws_other" })).toBe(false)
    expect(await composed.authorization.authorizeSessionOpen(actor, { sessionId: "ses_9", workspaceId: "ws_unknown" })).toBe(false)
    expect(authorizeRuntimeSession).not.toHaveBeenCalled()
  })

  test("may open a sibling workspace's session in its own project when the owner may", async () => {
    const authorizeRuntimeSession = vi.fn(async () => undefined)
    const composed = identity({ authorizeRuntimeSession })
    const actor = await actorOf(composed)
    expect(await composed.authorization.authorizeSessionOpen(actor, { sessionId: "ses_9", workspaceId: "ws_sibling" })).toBe(true)
  })

  test("is refused a link naming no workspace, and every link on an authority that cannot answer for an actor", async () => {
    const answering = identity({ authorizeRuntimeSession: vi.fn(async () => undefined) })
    expect(await answering.authorization.authorizeSessionOpen(await actorOf(answering), { sessionId: "ses_9", workspaceId: null })).toBe(false)

    const silent = identity()
    expect(await silent.authorization.authorizeSessionOpen(await actorOf(silent), { sessionId: "ses_9", workspaceId: "ws_root" })).toBe(false)
  })
})

describe("a Tasks grant starting a task", () => {
  function previewCommand(actor: TasksActor, workspaceId: string | null): StartPreviewCommand {
    return {
      actor,
      task: taskRow({ id: "tsk_1", scopeId: actor.scopeId, projectId: "project-a", workspaceId }),
      preset: presetRow({ id: "prs_1", scopeId: actor.scopeId, ownerId: actor.ownerId, agentStartable: true }),
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
      currentLink: null,
      currentState: null,
      authorizeTranscript: async () => true,
    }
  }

  test("reaches the bridge for a task preferring a workspace of its own project, or none", async () => {
    const composed = identity()
    const inner = fakeBridge()
    const bridge = composed.bridge(inner, createMemoryTasksStore())
    const actor = await actorOf(composed)
    expect((await bridge.preview(previewCommand(actor, null))).ok).toBe(true)
    expect((await bridge.preview(previewCommand(actor, "ws_root"))).ok).toBe(true)
    expect((await bridge.preview(previewCommand(actor, "ws_sibling"))).ok).toBe(true)
    expect(inner.previews).toHaveLength(3)
  })

  test("is refused before the bridge for a task whose stored preference is outside its project", async () => {
    const composed = identity()
    const inner = fakeBridge()
    const bridge = composed.bridge(inner, createMemoryTasksStore())
    const actor = await actorOf(composed)
    for (const foreign of ["ws_other", "ws_unknown"]) {
      const answer = await bridge.preview(previewCommand(actor, foreign))
      expect(answer).toEqual({
        ok: false,
        error: { code: "forbidden", message: "This session may act only in project project-a" },
      })
    }
    expect(inner.previews).toHaveLength(0)
    expect(inner.starts).toHaveLength(0)
  })

  test("leaves a signed person's Start alone", async () => {
    const composed = identity()
    const inner = fakeBridge()
    const bridge = composed.bridge(inner, createMemoryTasksStore())
    const person = composed.principals.actorOf(
      { mode: "signed", token: "jwt", user: { subject: "alice", tokenIdentifier: "t", issuer: "i" } },
      "org-1",
    )
    expect((await bridge.preview(previewCommand(person, "ws_other"))).ok).toBe(true)
    expect(inner.previews).toHaveLength(1)
  })
})
