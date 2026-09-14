/**
 * The control-plane rules that bound what an agent may put on a machine,
 * applied at the bridge for capability actors only: the preset's own mark,
 * how far a chain of agent-started tasks may run from the person who started
 * it, and how many agent-started cloud roots a project may hold at once.
 */
import { describe, expect, test } from "vitest"
import {
  SCOPES,
  createMemoryTasksStore,
  fakeBridge,
  linkRow,
  presetRow,
  taskRow,
  type FakeBridge,
} from "@claxedo/tasks/test-support"
import type {
  Preset,
  SessionReference,
  StartCommand,
  StartPreviewCommand,
  Task,
  TasksActor,
  TasksSessionBridgePort,
  TasksStorePort,
} from "@claxedo/tasks"
import type { WorkspaceAuthority } from "../platform/auth/authority"
import { MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT, MAX_AGENT_START_CHAIN_DEPTH, gateAgentStarts } from "./agent-start-gates"
import { createTasksPrincipals } from "./authorization"
import type { TasksCapabilityOwner, TasksCapabilityScope } from "./capability"
import { signedTasksIdentity } from "./contribution"

const ORG = SCOPES.first
const PROJECT = "project-a"
const ROOT: SessionReference = { sessionId: "ses_root", workspaceId: "ws_root" }

const SCOPE: TasksCapabilityScope = {
  userId: "alice",
  orgId: ORG,
  projectId: PROJECT,
  workspaceId: "ws_root",
  sessionId: ROOT.sessionId,
  operations: ["read", "create", "start"],
}
const OWNER: TasksCapabilityOwner = { userId: "alice", actorId: "actor:alice", orgId: ORG, projectId: PROJECT }

const CLOUD: Preset["execution"] = { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } }

function preset(input: { placement: "local" | "cloud"; agentStartable: boolean; name?: string }): Preset {
  return presetRow({
    id: "prs_1",
    scopeId: ORG,
    ownerId: "alice",
    name: input.name ?? "Reviewer",
    execution: input.placement === "cloud" ? CLOUD : { placement: "local", capabilities: { mode: "inherit-local" } },
    agentStartable: input.agentStartable,
  })
}

function task(id: string, input: { createdFrom?: SessionReference; projectId?: string } = {}): Task {
  return taskRow({ id, scopeId: ORG, projectId: input.projectId ?? PROJECT, createdFrom: input.createdFrom ?? null })
}

function previewCommand(actor: TasksActor, task: Task, chosen: Preset, attempt = 1): StartPreviewCommand {
  return {
    actor,
    task,
    preset: chosen,
    slot: "primary",
    attempt,
    continueFromPrevious: false,
    currentLink: null,
    currentState: null,
    authorizeTranscript: async () => true,
  }
}

function startCommand(actor: TasksActor, task: Task, chosen: Preset, attempt = 1): StartCommand {
  return {
    actor,
    task,
    preset: chosen,
    slot: "primary",
    attempt,
    previewDigest: "digest",
    continueFromPrevious: false,
    clientRequestId: "request-1",
    configurationDigest: "c".repeat(64),
    previousSession: null,
    authorizeTranscript: async () => true,
  }
}

type Fixture = {
  store: TasksStorePort
  inner: FakeBridge
  gated: TasksSessionBridgePort
  agent: TasksActor
  person: TasksActor
}

function fixture(scope: TasksCapabilityScope = SCOPE): Fixture {
  const principals = createTasksPrincipals()
  const store = createMemoryTasksStore()
  const inner = fakeBridge()
  return {
    store,
    inner,
    gated: gateAgentStarts(principals, store, inner),
    agent: principals.capabilityActorOf({ scope, owner: OWNER }),
    person: principals.actorOf({ mode: "signed", token: "jwt", user: { subject: "alice", tokenIdentifier: "t", issuer: "i" } }, ORG),
  }
}

const refusal = (answer: { ok: boolean; error?: { code: string; message: string } }) =>
  answer.ok ? "admitted" : `${answer.error?.code} ${answer.error?.message}`

/**
 * A chain of agent-started cloud roots: task[0] is a person's, each later task
 * was created by the session the previous task's root runs.
 */
async function chain(store: TasksStorePort, length: number): Promise<Task[]> {
  const tasks: Task[] = []
  let createdFrom: SessionReference | undefined
  for (let index = 0; index < length; index += 1) {
    const current = task(`tsk_chain_${index}`, createdFrom ? { createdFrom } : {})
    await store.tasks.insert(current)
    tasks.push(current)
    const session: SessionReference = { sessionId: `ses_chain_${index}`, workspaceId: `ws_chain_${index}` }
    await store.links.insert(
      linkRow({
        scopeId: ORG,
        taskId: current.id,
        attempt: 1,
        sessionRef: session,
        startedFrom: createdFrom ?? null,
        placement: "cloud",
      }),
    )
    createdFrom = session
  }
  return tasks
}

/** Agent-started cloud roots `from` up to `to` in the project, each on a task of its own. */
async function agentStartedRoots(store: TasksStorePort, to: number, projectId = PROJECT, from = 0): Promise<void> {
  for (let index = from; index < to; index += 1) {
    const held = task(`tsk_held_${projectId}_${index}`, { projectId })
    await store.tasks.insert(held)
    await store.links.insert(
      linkRow({
        scopeId: ORG,
        taskId: held.id,
        attempt: 1,
        sessionRef: { sessionId: `ses_held_${projectId}_${index}`, workspaceId: `ws_held_${index}` },
        startedFrom: ROOT,
        placement: "cloud",
      }),
    )
  }
}

describe("the preset's own mark", () => {
  test("refuses preview and start on a preset nobody marked, whatever its placement", async () => {
    const { store, inner, gated, agent } = fixture()
    const fresh = task("tsk_1")
    await store.tasks.insert(fresh)
    for (const placement of ["cloud", "local"] as const) {
      const unmarked = preset({ placement, agentStartable: false, name: "Careful review" })
      expect(refusal(await gated.preview(previewCommand(agent, fresh, unmarked)))).toBe(
        "forbidden Preset Careful review is not marked as startable by agents; a person can mark it in Settings → Presets",
      )
      expect(refusal(await gated.start(startCommand(agent, fresh, unmarked)))).toBe(
        "forbidden Preset Careful review is not marked as startable by agents; a person can mark it in Settings → Presets",
      )
    }
    expect(inner.previews).toHaveLength(0)
    expect(inner.starts).toHaveLength(0)
  })

  test("admits a marked preset to the bridge", async () => {
    const { store, inner, gated, agent } = fixture()
    const fresh = task("tsk_1")
    await store.tasks.insert(fresh)
    const marked = preset({ placement: "cloud", agentStartable: true })
    expect(refusal(await gated.preview(previewCommand(agent, fresh, marked)))).toBe("admitted")
    expect(refusal(await gated.start(startCommand(agent, fresh, marked)))).toBe("admitted")
    expect(inner.previews).toHaveLength(1)
    expect(inner.starts).toHaveLength(1)
  })
})

describe("how far a chain of agent-started tasks may run", () => {
  test("a task a person created, and a task created one machine away, may be started; two away is refused", async () => {
    const { store, inner, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const [person, oneAway, twoAway] = await chain(store, 3)
    if (!person || !oneAway || !twoAway) throw new Error("the chain is short")

    expect(MAX_AGENT_START_CHAIN_DEPTH).toBe(1)
    expect(refusal(await gated.preview(previewCommand(agent, person, marked)))).toBe("admitted")
    expect(refusal(await gated.preview(previewCommand(agent, oneAway, marked)))).toBe("admitted")
    expect(refusal(await gated.preview(previewCommand(agent, twoAway, marked)))).toBe(
      "forbidden Task tsk_chain_2 is two machines away from the person who started this chain; start it from the app",
    )
    expect(refusal(await gated.start(startCommand(agent, twoAway, marked)))).toBe(
      "forbidden Task tsk_chain_2 is two machines away from the person who started this chain; start it from the app",
    )
    expect(inner.previews).toHaveLength(2)
    expect(inner.starts).toHaveLength(0)
  })

  test("a task created by an ordinary session that no Start made is one machine away", async () => {
    const { store, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const created = task("tsk_from_session", { createdFrom: { sessionId: "ses_ordinary", workspaceId: "ws_root" } })
    await store.tasks.insert(created)
    expect(refusal(await gated.preview(previewCommand(agent, created, marked)))).toBe("admitted")
  })

  test("a chain that loops, or runs long, is refused after a bounded walk", async () => {
    const { store, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const own: SessionReference = { sessionId: "ses_self", workspaceId: "ws_self" }
    const looping = task("tsk_loop", { createdFrom: own })
    await store.tasks.insert(looping)
    await store.links.insert(
      linkRow({ scopeId: ORG, taskId: looping.id, attempt: 1, sessionRef: own, startedFrom: own, placement: "cloud" }),
    )
    expect(refusal(await gated.preview(previewCommand(agent, looping, marked)))).toBe(
      "forbidden Task tsk_loop is two machines away from the person who started this chain; start it from the app",
    )

    const long = await chain(store, 6)
    const last = long[5]
    if (!last) throw new Error("the chain is short")
    expect(refusal(await gated.preview(previewCommand(agent, last, marked)))).toBe(
      "forbidden Task tsk_chain_5 is two machines away from the person who started this chain; start it from the app",
    )
  })

  test("a local preset is not depth-gated", async () => {
    const { store, inner, gated, agent } = fixture()
    const local = preset({ placement: "local", agentStartable: true })
    const [, , twoAway] = await chain(store, 3)
    if (!twoAway) throw new Error("the chain is short")
    expect(refusal(await gated.preview(previewCommand(agent, twoAway, local)))).toBe("admitted")
    expect(inner.previews).toHaveLength(1)
  })
})

describe("how many agent-started cloud roots a project may hold", () => {
  test("the fifth concurrent root is refused, naming the count and the project", async () => {
    const { store, inner, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const next = task("tsk_next")
    await store.tasks.insert(next)

    expect(MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT).toBe(4)
    await agentStartedRoots(store, 3)
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).toBe("admitted")

    await agentStartedRoots(store, 4, PROJECT, 3)
    const sentence =
      "forbidden Project project-a already has 4 cloud machines started by agents, the most it may hold at once; archive one of their sessions or start this task from the app"
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).toBe(sentence)
    expect(refusal(await gated.start(startCommand(agent, next, marked)))).toBe(sentence)
    expect(inner.previews).toHaveLength(1)
    expect(inner.starts).toHaveLength(0)
  })

  test("archiving or deleting one of the four admits the next; an unreachable one still counts", async () => {
    const { store, inner, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const next = task("tsk_next")
    await store.tasks.insert(next)
    await agentStartedRoots(store, 4)

    inner.setState(`ses_held_${PROJECT}_0`, "unavailable")
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).not.toBe("admitted")

    inner.setState(`ses_held_${PROJECT}_0`, "archived")
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).toBe("admitted")

    inner.setState(`ses_held_${PROJECT}_0`, "live")
    inner.setState(`ses_held_${PROJECT}_1`, "deleted")
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).toBe("admitted")
  })

  test("counts only this project's cloud roots that an agent started, and never this attempt's own", async () => {
    const { store, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const next = task("tsk_next")
    await store.tasks.insert(next)
    await agentStartedRoots(store, 3)
    // A person's cloud root, a local agent start and another project's roots
    // are not what the cap counts.
    await store.links.insert(
      linkRow({ scopeId: ORG, taskId: next.id, slot: "review", attempt: 1, sessionRef: { sessionId: "ses_person", workspaceId: "ws_p" }, placement: "cloud" }),
    )
    await store.links.insert(
      linkRow({ scopeId: ORG, taskId: next.id, slot: "planning", attempt: 1, sessionRef: { sessionId: "ses_local", workspaceId: "ws_root" }, startedFrom: ROOT, placement: "local" }),
    )
    await agentStartedRoots(store, 4, "project-b")
    expect(refusal(await gated.preview(previewCommand(agent, next, marked)))).toBe("admitted")

    // The fourth is this very origin: previewing attempt 1 again while it
    // runs would otherwise refuse the Start that only returns that session.
    await store.links.insert(
      linkRow({ scopeId: ORG, taskId: next.id, attempt: 1, sessionRef: { sessionId: "ses_own", workspaceId: "ws_own" }, startedFrom: ROOT, placement: "cloud" }),
    )
    expect(refusal(await gated.preview(previewCommand(agent, next, marked, 1)))).toBe("admitted")
    expect(refusal(await gated.preview(previewCommand(agent, next, marked, 2)))).not.toBe("admitted")
  })

  test("a local preset is not cap-gated", async () => {
    const { store, gated, agent } = fixture()
    const local = preset({ placement: "local", agentStartable: true })
    const next = task("tsk_next")
    await store.tasks.insert(next)
    await agentStartedRoots(store, 4)
    expect(refusal(await gated.preview(previewCommand(agent, next, local)))).toBe("admitted")
  })
})

describe("the order of refusals, and who is refused", () => {
  test("the mark is asked before the chain, and the chain before the cap", async () => {
    const { store, gated, agent } = fixture()
    const [, , twoAway] = await chain(store, 3)
    if (!twoAway) throw new Error("the chain is short")
    await agentStartedRoots(store, 4)

    expect(refusal(await gated.preview(previewCommand(agent, twoAway, preset({ placement: "cloud", agentStartable: false }))))).toMatch(
      /^forbidden Preset /,
    )
    expect(refusal(await gated.preview(previewCommand(agent, twoAway, preset({ placement: "cloud", agentStartable: true }))))).toMatch(
      /^forbidden Task /,
    )
  })

  test("a signed person's preview and start pass through untouched", async () => {
    const { store, inner, gated, person } = fixture()
    const unmarked = preset({ placement: "cloud", agentStartable: false })
    const [, , twoAway] = await chain(store, 3)
    if (!twoAway) throw new Error("the chain is short")
    await agentStartedRoots(store, 4)

    expect(refusal(await gated.preview(previewCommand(person, twoAway, unmarked)))).toBe("admitted")
    const started = await gated.start(startCommand(person, twoAway, unmarked))
    expect(started.ok && started.session.startedFrom).toBe(null)
    expect(inner.previews).toHaveLength(1)
    expect(inner.starts).toHaveLength(1)
  })

  test("an agent's start records the grant's own session as what started it, never the request", async () => {
    const { store, gated, agent } = fixture()
    const marked = preset({ placement: "cloud", agentStartable: true })
    const fresh = task("tsk_1")
    await store.tasks.insert(fresh)
    const started = await gated.start(startCommand(agent, fresh, marked))
    expect(started.ok && started.session.startedFrom).toEqual(ROOT)
    expect(started.ok && started.session.sessionRef.sessionId).toBe("session-1")
  })

  test("a grant minted for no session in particular starts as nobody's session", async () => {
    const { sessionId: _sessionId, ...sessionless } = SCOPE
    const { store, gated, agent } = fixture(sessionless)
    const fresh = task("tsk_1")
    await store.tasks.insert(fresh)
    const started = await gated.start(startCommand(agent, fresh, preset({ placement: "cloud", agentStartable: true })))
    expect(started.ok && started.session.startedFrom).toBe(null)
  })
})

describe("the signed identity's bridge", () => {
  test("confines the scope first, then applies the gates, for a capability actor only", async () => {
    const store = createMemoryTasksStore()
    const inner = fakeBridge()
    const composed = signedTasksIdentity({
      authority: { authorizeSessionRead: async () => undefined } as unknown as WorkspaceAuthority,
      signed: async () => ({ error: "unsigned", status: 401 }),
      capability: {
        verify: async (token) => (token === "grant" ? SCOPE : undefined),
        workspaceOwner: async (workspaceId) => ({ ...OWNER, projectId: workspaceId === "ws_other" ? "project-b" : PROJECT }),
      },
    })
    const bridge = composed.bridge(inner, store)
    const admitted = await composed.authenticate(
      new Request("https://core.test/api/claxedo/tasks/presets", { headers: { authorization: "Bearer grant" } }),
    )
    if (!("actor" in admitted)) throw new Error(`the grant was refused: ${admitted.error}`)
    const unmarked = preset({ placement: "cloud", agentStartable: false })

    const elsewhere = taskRow({ id: "tsk_elsewhere", scopeId: ORG, projectId: PROJECT, workspaceId: "ws_other" })
    expect(refusal(await bridge.preview(previewCommand(admitted.actor, elsewhere, unmarked)))).toBe(
      "forbidden This session may act only in project project-a",
    )
    const here = task("tsk_here")
    await store.tasks.insert(here)
    expect(refusal(await bridge.preview(previewCommand(admitted.actor, here, unmarked)))).toMatch(/^forbidden Preset /)
    expect(inner.previews).toHaveLength(0)

    const person = composed.principals.actorOf(
      { mode: "signed", token: "jwt", user: { subject: "alice", tokenIdentifier: "t", issuer: "i" } },
      ORG,
    )
    expect(refusal(await bridge.preview(previewCommand(person, elsewhere, unmarked)))).toBe("admitted")
    expect(inner.previews).toHaveLength(1)
  })
})
