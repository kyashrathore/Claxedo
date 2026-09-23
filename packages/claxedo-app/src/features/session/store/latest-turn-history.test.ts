import { afterEach, describe, expect, test } from "bun:test"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentPresentationMessage as Message,
  AgentUserMessage as UserMessage,
} from "@claxedo/agent-runtime-contract"
import { projectLatestSurfaceMessages } from "@claxedo/agent-sdk-runtime/message-page"
import { hydrateConversationPage } from "../conversation/conversation-hydrator"
import {
  applyRegisteredConversationEvent,
  clearConversationChatRegistryForTest,
  registeredConversationSnapshot,
} from "../conversation/conversation-registry"
import { Timeline } from "../ui/message-timeline.data"
import { syncLatestTurnHistory, syncSettledTurnHistory, type LatestTurnRead } from "./latest-turn-history"

const directory = "/repo"
const sessionID = "ses_child"

const conversation = () => registeredConversationSnapshot(directory, sessionID)

afterEach(() => {
  clearConversationChatRegistryForTest()
})

type Row = { info: Message; parts: Part[] }

/**
 * The runtime's transcript and the three pages the controller reads from it,
 * hydrated the way `syncSessionHistory` hydrates each view.
 */
function runtime(initial: Row[]) {
  let rows = initial
  const surface = () => {
    const owningUser = rows.findLastIndex((row) => row.info.role === "user")
    const window = owningUser === -1 ? [] : [rows[owningUser], ...(rows.length - 1 > owningUser ? [rows.at(-1)!] : [])]
    return projectLatestSurfaceMessages(window)
  }
  const latestTurn = () => rows.slice(Math.max(0, rows.findLastIndex((row) => row.info.role === "user")))
  const readSurface = async () => {
    hydrateConversationPage({ directory, sessionID, rows: surface(), messageCompleteness: "fragment", partCompleteness: "fragment" })
    return true
  }
  const readLatestTurn = async (request: LatestTurnRead) => {
    hydrateConversationPage({
      directory,
      sessionID,
      rows: "tail" in request ? rows : latestTurn(),
      mode: "replace-window",
      messageCompleteness: "canonical",
      partCompleteness: "canonical",
    })
    return true
  }
  return {
    set: (next: Row[]) => { rows = next },
    readSurface,
    readLatestTurn,
    activate: async () => {
      await readSurface()
      await syncLatestTurnHistory({ conversation, read: readLatestTurn })
    },
    settle: () => syncSettledTurnHistory({ conversation, readSurface, readLatestTurn }),
  }
}

function timelineRows() {
  const conversation = registeredConversationSnapshot(directory, sessionID)
  const user = conversation.messages.find((message): message is UserMessage => message.role === "user")
  if (!user) throw new Error("no user message")
  const assistants = conversation.messages
    .filter((message): message is AssistantMessage => message.role === "assistant")
    .filter((message) => message.parentID === user.id)
  return Timeline.constructMessageRows(
    user,
    (messageID) => conversation.parts[messageID] ?? [],
    assistants,
    0,
    false,
    "idle",
    true,
    true,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    (messageID) => conversation.fragmentParts.has(messageID),
  ).map((row) => row._tag)
}

const user: Row = {
  info: { id: "msg_user", sessionID, role: "user", time: { created: 1 } } as Message,
  parts: [{ id: "prt_prompt", sessionID, messageID: "msg_user", type: "text", text: "Explore the repo" } as Part],
}

function assistant(settled: boolean): Row {
  return {
    info: {
      id: "msg_user_r",
      sessionID,
      role: "assistant",
      parentID: "msg_user",
      time: settled ? { created: 2, completed: 3 } : { created: 2 },
      ...(settled ? { error: { name: "APIError", data: { message: "Usage limit reached" } } } : {}),
      modelID: "claude",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as Message,
    parts: [],
  }
}

function messageUpdated(row: Row) {
  applyRegisteredConversationEvent({ directory, event: { type: "message.updated", properties: { sessionID, info: row.info } } })
}

describe("a subagent turn that fails with no parts paints its error", () => {
  test("mounted while running: the live settlement replaces the envelope the surface marked", async () => {
    const server = runtime([user, assistant(false)])
    await server.activate()
    server.set([user, assistant(true)])
    messageUpdated(assistant(true))
    await server.settle()
    expect(timelineRows()).toEqual(["UserMessage", "Error"])
  })

  test("mounted after the failure: the canonical read lifts the surface's mark", async () => {
    const server = runtime([user, assistant(true)])
    await server.activate()
    expect(timelineRows()).toEqual(["UserMessage", "Error"])
  })

  test("mounted before the reply existed: the settled read that first delivers it lifts its own mark", async () => {
    const server = runtime([user])
    await server.activate()
    server.set([user, assistant(true)])
    await server.settle()
    expect(registeredConversationSnapshot(directory, sessionID).fragmentParts).toEqual(new Set())
    expect(timelineRows()).toEqual(["UserMessage", "Error"])
  })

  test("a settled read that finds every reply already whole makes no second read", async () => {
    const server = runtime([user, assistant(false)])
    await server.activate()
    server.set([user, assistant(true)])
    messageUpdated(assistant(true))
    let canonicalReads = 0
    await syncSettledTurnHistory({
      conversation,
      readSurface: server.readSurface,
      readLatestTurn: async (request) => {
        canonicalReads += 1
        return server.readLatestTurn(request)
      },
    })
    expect(canonicalReads).toBe(0)
  })
})
