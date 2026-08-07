import { afterEach, expect, test } from "bun:test"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTranscriptResolver } from "../transcript-resolver"
import { defaultWorkspaceHarnessRegistry, type WorkspaceRuntimeStore } from "./runtime"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("Cursor native receives the parent/workspace-bound opaque transcript registrar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-native-transcript-"))
  roots.push(root)
  const providerRoot = path.join(root, "cursor", "sessions")
  await fs.mkdir(providerRoot, { recursive: true })
  const valid = path.join(providerRoot, "agent-1.jsonl")
  const invalid = path.join(root, "outside.jsonl")
  await Promise.all([
    Bun.write(valid, '{"type":"text","text":"hello"}\n'),
    Bun.write(invalid, '{}\n'),
  ])
  const runner = { id: "cursor", access: "native" } as const
  const entry = defaultWorkspaceHarnessRegistry().find((candidate) => candidate.match(runner))
  if (!entry) throw new Error("Expected the Cursor native registry entry")
  const adapter = entry.create({
    runner,
    options: {
      storeFactory: () => createMemoryRuntimeStore() as unknown as WorkspaceRuntimeStore,
      transcripts: {
        workspaceId: "workspace-a",
        resolver: createTranscriptResolver({
          workspaceId: "workspace-a",
          providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
          authorizeParent: ({ parentSessionId }) => parentSessionId === "parent-a",
          createHandle: () => "cursor_transcript_opaque",
        }),
      },
    },
  })
  const registrar = (adapter as unknown as {
    driver: { host: { transcriptRegistrar?: {
      register(input: { parentSessionId: string; providerKind: string; filePath: string }): Promise<unknown>
      open(input: { parentSessionId: string; handle: string }): Promise<unknown>
    } } }
  }).driver.host.transcriptRegistrar
  if (!registrar) throw new Error("Expected Cursor transcript registrar")

  expect(await registrar.register({
    parentSessionId: "parent-a",
    providerKind: "cursor-agent",
    filePath: valid,
  })).toEqual({ state: "ready", handle: "cursor_transcript_opaque" })
  expect(await registrar.open({
    parentSessionId: "parent-a",
    handle: "cursor_transcript_opaque",
  })).toEqual({ state: "ready", messages: [{ type: "text", text: "hello" }] })
  expect(await registrar.register({
    parentSessionId: "parent-a",
    providerKind: "cursor-agent",
    filePath: invalid,
  })).toMatchObject({ state: "unavailable", reason: "outside-root" })
  const unauthorized = await registrar.register({
    parentSessionId: "parent-b",
    providerKind: "cursor-agent",
    filePath: valid,
  })
  expect(unauthorized).toMatchObject({ state: "unavailable", reason: "unauthorized" })
  expect(JSON.stringify(unauthorized)).not.toContain(providerRoot)
  adapter.dispose()
})
