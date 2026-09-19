import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk"
import type { WithInternals } from "../../test-utils/class-internals"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { ACPProcess } from "./process"
import { init, merge, modeIds, sync, type ACPState } from "./session"

describe("ACP session config sync", () => {
  test("preserves an explicitly selected permission mode when a turn starts", async () => {
    const calls: unknown[] = []
    const state = merge(init({ sessionCapabilities: { setMode: true } } as never), {
      modes: {
        currentModeId: "bypassPermissions",
        availableModes: [
          { id: "auto", name: "Auto" },
          { id: "bypassPermissions", name: "Bypass permissions" },
        ],
      },
    })

    await sync({ request: async (_method: unknown, params: unknown) => calls.push(params) } as never, state, "agent-session", {
      agent: "auto",
      model: { providerID: "connection:example", modelID: "default" },
      parts: [],
    } as never, { syncMode: false })

    expect(calls).toEqual([])
  })

  test("does not translate app defaults to an agent-private option spelling", async () => {
    const calls: unknown[] = []
    const conn = {
      async request(_method: unknown, params: unknown) {
        calls.push(params)
        return { configOptions: state.cfg }
      },
    }
    const state: ACPState = {
      caps: null,
      prompt: null,
      modes: [],
      cfg: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.5[reasoning=medium]",
        options: [{ value: "default[]", name: "Auto" }],
      }],
    }

    await sync(conn as never, state, "agent-session", {
      agent: "build",
      model: { providerID: "connection:example", modelID: "default" },
      parts: [],
    } as never)

    expect(calls).toEqual([])
  })

  test("applies the selected reasoning effort through its authoritative config option", async () => {
    const calls: unknown[] = []
    const state: ACPState = {
      caps: null,
      prompt: null,
      modes: [],
      cfg: [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "ultra", name: "Ultra" },
          ],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        },
      ],
    }
    const conn = {
      async request(_method: unknown, params: unknown) {
        calls.push(params)
        const value = (params as { value: string }).value
        return {
          configOptions: state.cfg?.map((option) => option.id === "reasoning_effort"
            ? { ...option, currentValue: value }
            : option),
        }
      },
    }

    await sync(conn as never, state, "agent-session", {
      agent: "read-only",
      model: { providerID: "connection:example", modelID: "gpt-5.6-sol" },
      variant: "ultra",
      parts: [],
    } as never, { syncMode: false })

    expect(calls).toEqual([{
      sessionId: "agent-session",
      configId: "reasoning_effort",
      value: "ultra",
    }])
  })
})

describe("ACP advertised modes", () => {
  const base = () => init(null)

  test("preserves the agent's own name and description, not just the id", () => {
    const state = merge(base(), {
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
          { id: "acceptEdits", name: "Accept edits" },
        ],
      },
    })
    // `SessionModeId` is an open `string` in the spec, so these labels are the
    // ONLY non-invented text a client can show for a mode.
    expect(state.modes).toEqual([
      { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
      { id: "acceptEdits", name: "Accept edits" },
    ])
    expect(modeIds(state)).toEqual(["default", "acceptEdits"])
  })

  test("drops malformed modes rather than fabricating a label", () => {
    const state = merge(base(), {
      modes: {
        currentModeId: "ok",
        availableModes: [
          { id: "ok", name: "Fine" },
          { id: "no-name" },
          { name: "no-id" },
          null,
          "nonsense",
          { id: 7, name: "wrong types" },
        ],
      },
    })
    expect(state.modes).toEqual([{ id: "ok", name: "Fine" }])
  })

  test("omits an absent description instead of storing null", () => {
    const state = merge(base(), {
      modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A", description: null }] },
    })
    expect(state.modes).toEqual([{ id: "a", name: "A" }])
    expect("description" in state.modes[0]).toBe(false)
  })

  test("an explicit null modes field clears them; undefined leaves them alone", () => {
    const withModes = merge(base(), {
      modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A" }] },
    })
    expect(merge(withModes, { modes: null }).modes).toEqual([])
    expect(merge(withModes, {}).modes).toEqual([{ id: "a", name: "A" }])
  })

  test("a agent advertising no modes yields an empty list, never undefined", () => {
    expect(merge(base(), { modes: { currentModeId: "", availableModes: [] } }).modes).toEqual([])
    expect(merge(base(), { modes: {} }).modes).toEqual([])
    expect(base().modes).toEqual([])
  })
})

const PNG = Buffer.from("iVBORw0KGgo=", "base64").toString("base64")
const MP3 = Buffer.from([73, 68, 51, 4, 0, 0]).toString("base64")
const PDF = Buffer.from("%PDF-1.7\n").toString("base64")
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]).toString("base64")

const ATTACHMENT_PARTS = [
  { type: "text", text: "review these" },
  { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG}` },
  { type: "file", mime: "audio/mpeg", filename: "note.mp3", url: `data:audio/mpeg;base64,${MP3}` },
  { type: "file", mime: "application/pdf", filename: "spec.pdf", url: `data:application/pdf;base64,${PDF}` },
  { type: "file", mime: "video/mp4", filename: "clip.mp4", url: `data:video/mp4;base64,${MP4}` },
]

type PromptingProcess = {
  agent: { request: (method: string, params: unknown) => Promise<unknown> }
  idle: { touch: () => void; lease: () => { release: () => void } }
  states: Map<string, ACPState>
  caps: { promptCapabilities: PromptCapabilities }
  transport: { kind: "stdio" | "websocket"; alive: boolean }
  promptQueue: Promise<void>
  promptQueueDepth: number
  sessionListeners: Map<string, unknown>
}

/**
 * An `ACPProcess` whose agent only records the `session/prompt` it receives, so
 * the assertion is on the blocks that actually went over the wire.
 */
function promptingProcess(input: { caps: PromptCapabilities; kind: "stdio" | "websocket" }) {
  const sent: Array<{ method: string; prompt: ContentBlock[] }> = []
  const proc = Object.create(ACPProcess.prototype) as WithInternals<ACPProcess, PromptingProcess>
  Object.assign(proc, {
    agent: {
      request: async (method: string, params: unknown) => {
        sent.push({ method, prompt: (params as { prompt: ContentBlock[] }).prompt })
        return { stopReason: "end_turn" }
      },
    },
    idle: { touch() {}, lease: () => ({ release() {} }) },
    states: new Map(),
    caps: { promptCapabilities: input.caps },
    transport: { kind: input.kind, alive: true },
    promptQueue: Promise.resolve(),
    promptQueueDepth: 0,
    promptQuiet: new Map(),
    sessionListeners: new Map(),
  })
  return { proc, sent }
}

describe("ACP prompt attachments", () => {
  let directory = ""
  const attachmentDirectory = () => path.join(directory, ".claxedo", "attachments")
  const written = (suffix: string) => {
    const names = fs.readdirSync(attachmentDirectory())
    const hit = names.find((name) => name.endsWith(suffix))
    if (!hit) throw new Error(`no attachment ending in ${suffix}, only ${names.join(", ")}`)
    return path.join(attachmentDirectory(), hit)
  }
  const fileUri = (suffix: string) => pathToFileURL(written(suffix)).href

  const send = async (proc: { prompt: ACPProcess["prompt"] }) =>
    await proc.prompt("agent-1", {
      parts: ATTACHMENT_PARTS,
      assistantMessageId: "a1",
      agent: "build",
      model: { providerID: "connection:example", modelID: "default" },
      system: "sys",
    } as never, () => {}, directory)

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-attachments-"))
  })

  afterEach(() => {
    removeTestTempDir(directory)
  })

  test("carries each attachment in the block its capabilities admit, plus the path it was written to", async () => {
    const { proc, sent } = promptingProcess({
      caps: { image: true, audio: true, embeddedContext: true },
      kind: "stdio",
    })

    await send(proc)

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe("session/prompt")
    expect(sent[0].prompt).toEqual([
      { type: "text", text: "sys", annotations: { audience: ["assistant"] } },
      {
        type: "text",
        text: [
          "review these",
          `Attached file (image/png): ${written("-shot.png")}`,
          `Attached file (audio/mpeg): ${written("-note.mp3")}`,
          `Attached file (application/pdf): ${written("-spec.pdf")}`,
          `Attached file (video/mp4): ${written("-clip.mp4")}`,
        ].join("\n"),
      },
      { type: "image", mimeType: "image/png", data: PNG, uri: fileUri("-shot.png") },
      { type: "audio", mimeType: "audio/mpeg", data: MP3 },
      { type: "resource", resource: { uri: fileUri("-spec.pdf"), blob: PDF, mimeType: "application/pdf" } },
      { type: "resource", resource: { uri: fileUri("-clip.mp4"), blob: MP4, mimeType: "video/mp4" } },
    ])
    expect(fs.readFileSync(written("-spec.pdf")).toString("base64")).toBe(PDF)
  })

  test("links a baseline agent to the workspace file instead of inlining bytes it never negotiated", async () => {
    const { proc, sent } = promptingProcess({ caps: {}, kind: "stdio" })

    await send(proc)

    expect(sent[0].prompt.slice(2)).toEqual([
      { type: "resource_link", uri: fileUri("-shot.png"), name: "shot.png", mimeType: "image/png" },
      { type: "resource_link", uri: fileUri("-note.mp3"), name: "note.mp3", mimeType: "audio/mpeg" },
      { type: "resource_link", uri: fileUri("-spec.pdf"), name: "spec.pdf", mimeType: "application/pdf" },
      { type: "resource_link", uri: fileUri("-clip.mp4"), name: "clip.mp4", mimeType: "video/mp4" },
    ])
  })

  test("sends bytes alone to an agent off this filesystem, naming no path it cannot open", async () => {
    const { proc, sent } = promptingProcess({
      caps: { image: true, audio: true, embeddedContext: true },
      kind: "websocket",
    })

    await send(proc)

    expect(sent[0].prompt).toEqual([
      { type: "text", text: "sys", annotations: { audience: ["assistant"] } },
      { type: "text", text: "review these" },
      { type: "image", mimeType: "image/png", data: PNG },
      { type: "audio", mimeType: "audio/mpeg", data: MP3 },
      { type: "resource", resource: { uri: "wr://attachment/2", blob: PDF, mimeType: "application/pdf" } },
      { type: "resource", resource: { uri: "wr://attachment/3", blob: MP4, mimeType: "video/mp4" } },
    ])
    expect(fs.existsSync(path.join(directory, ".claxedo"))).toBe(false)
  })

  test("refuses to drop an attachment an agent can neither receive nor read", async () => {
    const { proc, sent } = promptingProcess({ caps: {}, kind: "websocket" })

    await expect(send(proc)).rejects.toThrow("image/png")
    expect(sent).toEqual([])
  })
})
