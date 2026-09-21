import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { codexUserInput, codexSteerTurn, createCodexTurnStop } from "./protocol"
import { createTurnStopRecord } from "../shared/cancellation-facts"
import type { CodexAppServerProcess } from "./app-server-process"
import type { RequestDeadline } from "../../launch"

const imagePart = {
  type: "file",
  mime: "image/png",
  filename: "shot.png",
  url: "data:image/png;base64,AAAB",
}
const videoPart = {
  type: "file",
  mime: "video/mp4",
  filename: "clip.mp4",
  url: "data:video/mp4;base64,AAAC",
}

let directory = ""
const written = () => {
  const folder = path.join(directory, ".claxedo", "attachments")
  return fs.readdirSync(folder)
    .filter((name) => name !== ".gitignore")
    .map((name) => path.join(folder, name))
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-attachment-"))
})

afterEach(() => {
  removeTestTempDir(directory)
})

describe("Codex turn input", () => {
  test("sends one text block for a prompt with no attachments", async () => {
    expect(await codexUserInput({ parts: [{ type: "text", text: "run the tests" }], directory }))
      .toEqual([{ type: "text", text: "run the tests", text_elements: [] }])
    expect(fs.existsSync(path.join(directory, ".claxedo"))).toBe(false)
  })

  test("sends an empty text block for an empty prompt", async () => {
    expect(await codexUserInput({ parts: [], directory }))
      .toEqual([{ type: "text", text: "", text_elements: [] }])
  })

  test("adds a localImage input for the workspace path a pasted image was written to", async () => {
    const sent = await codexUserInput({ parts: [{ type: "text", text: "look" }, imagePart], directory })
    const [target] = written()
    expect(fs.readFileSync(target).toString("base64")).toBe("AAAB")
    expect(sent).toEqual([
      { type: "text", text: `look\nAttached file (image/png): ${target}`, text_elements: [] },
      { type: "localImage", path: target },
    ])
  })

  test("leaves a pasted video to the path the text names", async () => {
    const sent = await codexUserInput({ parts: [{ type: "text", text: "watch" }, videoPart], directory })
    const [target] = written()
    expect(fs.readFileSync(target).toString("base64")).toBe("AAAC")
    expect(sent).toEqual([
      { type: "text", text: `watch\nAttached file (video/mp4): ${target}`, text_elements: [] },
    ])
  })
})


test("Codex steering carries the stable user identity and target turn precondition", async () => {
  const requests: unknown[] = []
  const process = { request: async (method: string, params: unknown) => { requests.push({ method, params }); return { turnId: "turn-1" } } }
  await codexSteerTurn({
    process, threadId: "thread-1", turnId: "turn-1", directory,
    input: { parts: [{ type: "text", text: "S" }], userMessageId: "msg_stable", assistantMessageId: "reply", agent: "build", model: { providerID: "codex", modelID: "default" } },
  })
  expect(requests).toEqual([{ method: "turn/steer", params: {
    threadId: "thread-1", expectedTurnId: "turn-1", clientUserMessageId: "msg_stable",
    input: [{ type: "text", text: "S", text_elements: [] }],
  } }])
})

test("every inventory read carries its own budget, so a paged stop cannot expire partway through", async () => {
  const seen: Array<{ method: string; deadlineAt: number }> = []
  // Each call costs real time, the way a provider answering slowly does. One
  // budget shared across the interrupt, three pages and a terminate would be
  // spent long before the last of them.
  const PER_CALL_MS = 40
  const record = createTurnStopRecord()
  const pages: Record<string, { data: Array<{ processId: string }>; nextCursor: string | null }> = {
    "": { data: [{ processId: "p1" }], nextCursor: "b" },
    b: { data: [{ processId: "p2" }], nextCursor: "c" },
    c: { data: [{ processId: "p3" }], nextCursor: null },
  }
  let terminated = false
  const process = {
    async request(method: string, params: unknown, deadline: RequestDeadline) {
      seen.push({ method, deadlineAt: deadline.deadlineAt })
      await new Promise((resolve) => setTimeout(resolve, PER_CALL_MS))
      if (method === "thread/backgroundTerminals/terminate") { terminated = true; return {} }
      if (method !== "thread/backgroundTerminals/list") return {}
      const cursor = String((params as { cursor?: string }).cursor ?? "")
      const page = pages[cursor]!
      return terminated ? { data: [], nextCursor: null } : page
    },
  } as unknown as Pick<CodexAppServerProcess, "request">

  const stop = createCodexTurnStop({ process, threadId: "thread-1", turnId: () => "turn-1", record })
  stop.observe("item/started", { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", processId: "p1" } })
  await stop.stop()

  expect(record.cleanup).toBe("verified_clear")
  const reads = seen.filter((call) => call.method === "thread/backgroundTerminals/list")
  expect(reads.length).toBeGreaterThanOrEqual(3)
  // Each read is budgeted from when it starts, so later ones end later. A
  // single instant captured up front would give every call the same deadline.
  expect(new Set(reads.map((read) => read.deadlineAt)).size).toBeGreaterThan(1)
  expect(reads.at(-1)!.deadlineAt).toBeGreaterThan(reads[0]!.deadlineAt)
})
