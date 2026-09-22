import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { AgentPresentationMessage as Message, AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { clearConversationChatRegistryForTest, hydrateRegisteredConversationSnapshot } from "../conversation/conversation-registry"
import { createTurnCoverageOwner, type TurnCoverageClient } from "./session-coverage-obligations"
import { outstandingTurnCoverage, resetAcceptedPromptRefreshForTest } from "./accepted-prompt-refresh"

const DIR = "/repo/main"
const SESSION = "ses_reload"

afterEach(() => {
  resetAcceptedPromptRefreshForTest()
  clearConversationChatRegistryForTest()
})

function userRow(id: string): Message {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 }, agent: "build" } as Message
}

function assistantRow(id: string, parentID: string): Message {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    parentID,
    time: { created: 2, completed: 3 },
    agent: "build",
  } as Message
}

/** Seeds the transcript the owner reconstructs from. */
function seed(messages: Message[]) {
  hydrateRegisteredConversationSnapshot({
    directory: DIR,
    sessionID: SESSION,
    messages,
    parts: Object.fromEntries(messages.map((message) => [message.id, []])),
  })
}

const idleClient: TurnCoverageClient = {
  session: {
    messages: async () => ({ data: undefined }),
    status: async () => ({ data: {} }),
  },
}

/**
 * Runs the owner once against a fixed session, without a pane: the pane is held
 * inactive so no attempt starts and the assertions are about which obligations
 * reconstruction created, not about the reads that would follow.
 */
async function mount(status: SessionStatus | undefined, loaded: string[]) {
  let dispose = () => {}
  createRoot((disposer) => {
    dispose = disposer
    createTurnCoverageOwner({
      sessionID: () => SESSION,
      directory: () => DIR,
      paneActive: () => false,
      client: idleClient,
      createReadEpoch: () => ({ active: () => true, signal: new AbortController().signal, abort: () => {} }),
      loadedTurnIds: () => loaded,
      status: () => status,
    })
  })
  await Promise.resolve()
  const owed = outstandingTurnCoverage({ directory: DIR, sessionID: SESSION }).map((entry) => entry.turnId)
  return { owed, dispose }
}

describe("rebuilding a reopened range", () => {
  test("an idle session is not rebuilt at all", async () => {
    seed([userRow("u1")])
    const { owed, dispose } = await mount({ type: "idle" }, ["u1"])
    expect(owed).toEqual([])
    dispose()
  })

  test("a session with no status yet is not rebuilt either", async () => {
    seed([userRow("u1")])
    const { owed, dispose } = await mount(undefined, ["u1"])
    expect(owed).toEqual([])
    dispose()
  })

  test("a busy session owes coverage for a settled turn whose reply never landed", async () => {
    seed([userRow("u1"), userRow("u2"), assistantRow("a2", "u2"), userRow("u3")])
    const { owed, dispose } = await mount({ type: "busy" }, ["u1", "u2", "u3"])
    // u2 was answered; u3 is the turn now running.
    expect(owed).toEqual(["u1"])
    dispose()
  })

  // Reading a live turn's half-written transcript back would replace the rows
  // the stream is still delivering.
  test("the turn a busy session is running is never given an obligation", async () => {
    seed([userRow("u1"), assistantRow("a1", "u1"), userRow("u2")])
    const { owed, dispose } = await mount({ type: "busy" }, ["u1", "u2"])
    expect(owed).toEqual([])
    dispose()
  })

  test("an empty range is a history that has not arrived, so nothing is owed", async () => {
    seed([])
    const { owed, dispose } = await mount({ type: "busy" }, [])
    expect(owed).toEqual([])
    dispose()
  })

  // The guard is what keeps a reopened range from re-reading itself every time
  // the runtime reports a new status for the session.
  test("a status that keeps changing rebuilds the range only once", async () => {
    seed([userRow("u1"), userRow("u2")])
    const [status, setStatus] = createSignal<SessionStatus | undefined>({ type: "busy" })
    let consulted = 0
    let dispose = () => {}
    createRoot((disposer) => {
      dispose = disposer
      createTurnCoverageOwner({
        sessionID: () => SESSION,
        directory: () => DIR,
        paneActive: () => false,
        client: idleClient,
        createReadEpoch: () => ({ active: () => true, signal: new AbortController().signal, abort: () => {} }),
        loadedTurnIds: () => {
          consulted += 1
          return ["u1", "u2"]
        },
        status,
      })
    })
    await Promise.resolve()
    expect(consulted).toBe(1)

    setStatus({ type: "retry", attempt: 1, message: "retrying", next: 0 })
    setStatus({ type: "busy" })
    await Promise.resolve()

    expect(consulted).toBe(1)
    dispose()
  })
})
