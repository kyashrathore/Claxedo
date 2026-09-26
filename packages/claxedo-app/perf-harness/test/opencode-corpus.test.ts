import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkspaceScope, createOpenCodeRuntime } from "@claxedo/workspace-runtime/opencode"
import { OpenCodeCorpus } from "../src/opencode-corpus"

function corpus(directory: string) {
  const value = new OpenCodeCorpus()
  value.addSession({ id: "ses_corpus", projectId: "global", directory, title: "Corpus", created: 100, updated: 200 })
  value.addMessage("msg_user", "ses_corpus", { role: "user", time: { created: 100 } })
  value.setPart("prt_user", "msg_user", 0, { type: "text", text: "hello" })
  value.addMessage("msg_assistant", "ses_corpus", {
    role: "assistant",
    agent: "build",
    providerID: "benchmark",
    modelID: "deterministic",
    time: { created: 101, completed: 200 },
    finish: "stop",
  })
  value.setPart("prt_answer", "msg_assistant", 0, { type: "text", text: "answer" })
  return value
}

test("the native SDK copy preserves transcript content and migrated snapshot metadata", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "claxedo-corpus-port-")))
  const databasePath = path.join(directory, "opencode.db")
  const runtime = createOpenCodeRuntime({ databasePath, configContent: "{}" })
  try {
    const value = corpus(directory)
    value.setPart("prt_start", "msg_assistant", -1, { type: "step-start", snapshot: "before" })
    value.setPart("prt_patch", "msg_assistant", 1, { type: "patch", hash: "before", files: ["src/example.ts"] })
    value.setPart("prt_finish", "msg_assistant", 2, { type: "step-finish", snapshot: "after" })
    const restored = await value.persist(databasePath)
    const assistant = restored[0].messages.find((message) => message.type === "assistant")
    expect(assistant?.snapshot).toEqual({ start: "before", end: "after", files: ["src/example.ts"] })
    const scope = WorkspaceScope.authorize({ workspaceID: "fixture", directory })
    const session = await runtime.sessions.get(scope, "ses_corpus")
    expect(session.title).toBe("Corpus")
    expect(session.createdAt).toBe(100)
    const page = await runtime.sessions.messages(scope, "ses_corpus", { order: "asc" })
    expect(page.messages.map((row) => row.id)).toEqual(["msg_user", "msg_assistant"])
    expect(page.messages[0]?.text).toBe("hello")
    expect(page.messages[1]?.content).toEqual([{ type: "text", text: "answer" }])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("unsupported corpus content fails before creating an SDK database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claxedo-corpus-reject-"))
  const databasePath = path.join(directory, "opencode.db")
  try {
    const value = corpus(directory)
    value.setPart("prt_answer", "msg_assistant", 0, { type: "unknown-content" })
    await expect(value.persist(databasePath)).rejects.toThrow("Unsupported assistant corpus part")
    expect(existsSync(databasePath)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a corpus part cannot move across message owners", () => {
  const value = corpus("/fixture")
  expect(() => value.setPart("prt_user", "msg_assistant", 1, { type: "text", text: "changed" })).toThrow(
    "changed its message",
  )
})
