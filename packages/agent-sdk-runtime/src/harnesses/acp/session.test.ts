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
  test("an agent-owned model is retained, and unsupported model changes fail explicitly", async () => {
    const state = merge(init({}), { models: { currentModelId: "owned", availableModels: [{ modelId: "owned", name: "Owned" }] } })
    const calls: unknown[] = []
    const conn = { request: async (...args: unknown[]) => calls.push(args) }
    expect(await sync(conn as never, state, "agent-session", { agent: "build", parts: [], assistantMessageId: "absent" })).toBe(state)
    const input = { agent: "build", model: { providerID: "example", modelID: "owned" }, parts: [] }
    await sync(conn as never, state, "agent-session", input as never)
    await expect(sync(conn as never, state, "agent-session", { ...input, model: { ...input.model, modelID: "other" } } as never))
      .rejects.toThrow("does not advertise a model selector")
    expect(calls).toEqual([])
  })

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

describe("ACP model and effort sync never runs a turn on values the picker did not show", () => {
  const levelsFor: Record<string, string[]> = { a: ["low", "medium"], b: ["low", "medium", "xhigh"] }
  const options = (model: string, effort: string) => [
    { id: "model", name: "Model", category: "model", type: "select" as const, currentValue: model,
      options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
    { id: "effort", name: "Effort", category: "thought_level", type: "select" as const, currentValue: effort,
      options: levelsFor[model].map((value) => ({ value, name: value })) },
  ]
  // An agent that resets effort to "medium" on a model switch and clamps
  // anything its current model does not list.
  function agent(start: { model: string; effort: string }, clamp = false) {
    let current = { ...start }
    const calls: Array<{ configId: string; value: string }> = []
    const conn = {
      async request(_method: unknown, params: { configId: string; value: string }) {
        calls.push({ configId: params.configId, value: params.value })
        if (params.configId === "model") current = { model: params.value, effort: "medium" }
        else current = { ...current, effort: clamp ? "medium" : params.value }
        return { configOptions: options(current.model, current.effort) }
      },
    }
    const state = merge(init({}), { configOptions: options(start.model, start.effort) })
    return { conn, calls, state }
  }
  const turn = (modelID: string, variant?: string) =>
    ({ agent: "build", model: { providerID: "connection:x", modelID }, ...(variant ? { variant } : {}), parts: [] }) as never

  test("switches the model first, then applies an effort only the new model offers", async () => {
    const { conn, calls, state } = agent({ model: "a", effort: "low" })
    await sync(conn as never, state, "s", turn("b", "xhigh"), { syncMode: false })
    expect(calls).toEqual([{ configId: "model", value: "b" }, { configId: "effort", value: "xhigh" }])
  })

  test("refuses an effort the current model does not offer instead of skipping it", async () => {
    const { conn, state } = agent({ model: "a", effort: "low" })
    await expect(sync(conn as never, state, "s", turn("a", "xhigh"), { syncMode: false }))
      .rejects.toThrow("ACP agent does not offer effort xhigh; it offers low, medium")
  })

  test("refuses when the agent keeps a different effort than it was sent", async () => {
    const { conn, state } = agent({ model: "b", effort: "low" }, true)
    await expect(sync(conn as never, state, "s", turn("b", "xhigh"), { syncMode: false }))
      .rejects.toThrow("ACP agent kept effort medium instead of xhigh")
  })

  test("matches the most specific model id first, whatever order the agent lists them in", async () => {
    const cfg = [{ id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "other",
      options: [{ value: "gpt", name: "GPT" }, { value: "connection:x/gpt", name: "GPT (x)" }, { value: "other", name: "Other" }] }]
    const calls: Array<{ value: string }> = []
    const conn = { request: async (_method: unknown, params: { value: string }) => { calls.push({ value: params.value }); return {} } }
    await sync(conn as never, merge(init({}), { configOptions: cfg }), "s", turn("gpt"), { syncMode: false })
    expect(calls).toEqual([{ value: "connection:x/gpt" }])
  })

  test("refuses an effort for an agent with no effort control", async () => {
    const state = merge(init({}), { configOptions: [options("a", "low")[0]] })
    await expect(sync({ request: async () => ({}) } as never, state, "s", turn("a", "high"), { syncMode: false }))
      .rejects.toThrow("ACP agent offers no effort control, so effort high cannot be applied")
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
  activePrompts: Set<string>
  sessionListeners: Map<string, unknown>
}

/**
 * An `ACPProcess` whose agent only records the `session/prompt` it receives, so
 * the assertion is on the blocks that actually went over the wire.
 */
function promptingProcess(input: { caps: PromptCapabilities; kind: "stdio" | "websocket"; sharedFilesystem?: boolean }) {
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
    transport: { kind: input.kind, alive: true, sharedFilesystem: input.sharedFilesystem === true },
    activePrompts: new Set(),
    uncertainSessions: new Map(),
    promptSettlements: new Map(),
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
      sharedFilesystem: true,
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
    const { proc, sent } = promptingProcess({ caps: {}, kind: "stdio", sharedFilesystem: true })

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
  test("a stdio bridge without shared filesystem delivers inline without leaking local paths", async () => {
    const { proc, sent } = promptingProcess({ caps: { image: true, audio: true, embeddedContext: true }, kind: "stdio" })
    await send(proc)
    expect(JSON.stringify(sent)).not.toContain("file:")
    expect(fs.existsSync(attachmentDirectory())).toBe(false)
  })

  test("an explicitly shared websocket workspace supports baseline file links", async () => {
    const { proc, sent } = promptingProcess({ caps: {}, kind: "websocket", sharedFilesystem: true })
    await send(proc)
    expect(sent[0].prompt[2]).toMatchObject({ type: "resource_link", uri: fileUri("-shot.png") })
  })

})
