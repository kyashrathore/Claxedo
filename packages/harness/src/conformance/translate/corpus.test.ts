import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { RawHarnessEvent } from "@claxedo/agent-event-runtime/contracts"
import type { HarnessEventAdapter } from "../../translate/adapter"
import { createAcpEventTranslator } from "../../transports/acp/translate"
import { claudeSdkAdapter } from "../../transports/claude-sdk/translate"
import { codexAppServerAdapter } from "../../transports/codex-app-server/translate"
import { cursorSdkAdapter } from "../../transports/cursor-sdk/translate"
import { piRpcAdapter } from "../../transports/pi-rpc/translate"

type Callback = { name: "now" | "createId"; value: unknown }
type Call = {
  state: unknown
  event: RawHarnessEvent
  context: { harness: string; threadId: string }
  callbacks: Callback[]
  output: unknown
}
type Recording = { adapter: string; initialState: unknown; calls: Call[] }

const root = path.join(import.meta.dirname, "../../translate/corpus")
const files = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  .flatMap((folder) => readdirSync(path.join(root, folder.name)).filter((name) => name.endsWith(".json"))
    .map((name) => path.join(root, folder.name, name)))

function adapterFor(name: string): HarnessEventAdapter {
  if (name === "pi-rpc") return piRpcAdapter() as HarnessEventAdapter
  if (name === "claude-sdk") return claudeSdkAdapter() as HarnessEventAdapter
  if (name === "codex-app-server") return codexAppServerAdapter() as HarnessEventAdapter
  if (name === "cursor-sdk") return cursorSdkAdapter() as HarnessEventAdapter
  return createAcpEventTranslator({ client: name }) as HarnessEventAdapter
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe("translator corpus", () => {
  test("has recordings", () => expect(files.length).toBeGreaterThan(0))
  for (const file of files) test(path.relative(root, file), () => {
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording
    const adapter = adapterFor(recording.adapter)
    let state = adapter.createInitialState?.()
    expect(json(state)).toEqual(recording.initialState)
    expect(recording.calls.length).toBeGreaterThan(0)
    for (const [index, call] of recording.calls.entries()) {
      expect(json(state)).toEqual(call.state)
      const callbacks = [...call.callbacks]
      const take = (name: Callback["name"]) => {
        const next = callbacks.shift()
        expect(next?.name).toBe(name)
        return next?.value
      }
      const result = adapter.translate({
        state,
        event: call.event,
        context: {
          ...call.context,
          now: () => take("now") as number,
          createId: () => take("createId") as string,
        },
      })
      expect(callbacks).toEqual([])
      const expected = process.env.CLAXEDO_TRANSLATOR_CORPUS_FAULT === "alter-output" && path.basename(file) === "H0-3.json" && index === 0
        ? { alteredRecording: call.output }
        : call.output
      expect(json(result)).toEqual(expected)
      if (!Array.isArray(result) && result.state !== undefined) state = result.state
    }
  })
})
