import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PiHarnessAdapter } from "./index"
import { PI_VERSION, piPackageRoot, resolvePiExecutable } from "./executable"
import { installFakePiRpc } from "../../test-utils/fake-pi-rpc.mjs"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { PromptInput } from "../../index"
import { PiRpcProcess } from "./rpc-process"

test.each(["resolve", "reject"] as const)(
  "an idle RPC check cannot dispose a new turn after a stale %s",
  async (outcome) => {
    const f = await installFakePiRpc()
    const store = createMemoryRuntimeStore()
    const adapter = new PiHarnessAdapter({ binary: f.binary, agentDir: f.agentDir, store, idleMs: 10 })
    // The call-through target has to be captured before `spyOn` overwrites
    // `request`, and eagerly: every shape that reads the prototype at call time
    // (`.call`/`.apply` on the member expression, a `super` call, an arrow that
    // re-looks-up) reaches the spy and recurses. `.bind` cannot help either —
    // the receiver is the spy's own `this`, one per call.
    //
    // So snapshot the prototype's own descriptors. The method stays reachable
    // as a property of an object rather than as a detached function, and the
    // one call below names its receiver.
    const unspied: Pick<PiRpcProcess, "request"> = Object.create(
      null,
      Object.getOwnPropertyDescriptors(PiRpcProcess.prototype),
    )
    let armed = false
    const gate = Promise.withResolvers<void>()
    const idle = Promise.withResolvers<void>()
    const prompted = Promise.withResolvers<void>()
    const checked = Promise.withResolvers<void>()
    const stat = fs.stat
    const statSpy = spyOn(fs, "stat").mockImplementation(
      new Proxy(stat, {
        apply(target, receiver, args) {
          return Reflect.apply(target, receiver, args).then((result: Awaited<ReturnType<typeof fs.stat>>) => {
            if (String(args[0]).endsWith(".jsonl")) checked.resolve()
            return result
          })
        },
      }),
    )
    const rpcSpy = spyOn(PiRpcProcess.prototype, "request").mockImplementation(async function (
      this: PiRpcProcess,
      type,
      body,
      timeout,
    ) {
      const result = await unspied.request.call(this, type, body, timeout)
      if (type === "get_state" && armed) {
        armed = false
        idle.resolve()
        await gate.promise
        if (outcome === "reject") {
          checked.resolve()
          throw new Error("Stale idle check failed")
        }
      }
      if (type === "prompt") prompted.resolve()
      return result
    })
    try {
      const session = await adapter.createSession(f.directory)
      const binding: AgentExecutionBinding = {
        workspaceId: "workspace",
        directory: f.directory,
        sessionId: session.id,
        upstreamSessionId: store.getAgentSessionId(session.id)!,
        connectionId: "native:pi",
      }
      armed = true
      await idle.promise
      const events: unknown[] = []
      const turn = (async () => {
        for await (const event of adapter.executeTurn(binding, prompt("hold"))) events.push(event)
      })()
      await prompted.promise
      gate.resolve()
      await checked.promise
      // The idle check has finished its filesystem observation; allow its continuation to run.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await adapter.abort(binding)).toMatchObject({ ok: true, status: "cancelled" })
      await turn
      expect(JSON.stringify(events)).not.toContain("Pi process disposed")
    } finally {
      gate.resolve()
      rpcSpy.mockRestore()
      statSpy.mockRestore()
      await adapter.dispose()
      await f.dispose()
    }
  },
)

/**
 * The adapter refuses any binary whose `--version` is not the pinned one, so a
 * machine carrying a different Pi cannot run the live catalog probe at all.
 * A binary outside the npm package has no readable version and is attempted:
 * only a proven mismatch is skipped, never an unknown.
 */
function unpinnedPi(): string | undefined {
  const binary = resolvePiExecutable()
  if (!binary) return `no Pi executable found; expected ${PI_VERSION}`
  const root = piPackageRoot(binary)
  if (!root) return undefined
  const installed = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version
  return installed && installed !== PI_VERSION ? `Pi ${installed} is installed, pinned ${PI_VERSION}` : undefined
}

const prompt = (text: string): PromptInput => ({
  parts: [{ type: "text", text }],
  agent: "build",
  assistantMessageId: crypto.randomUUID(),
  model: { providerID: "pi", modelID: "test/model" },
})
async function fixture() {
  const fake = await installFakePiRpc()
  const store = createMemoryRuntimeStore()
  const options = { binary: fake.binary, agentDir: fake.agentDir, store }
  const adapter = new PiHarnessAdapter(options)
  const session = await adapter.createSession(fake.directory)
  const binding: AgentExecutionBinding = {
    workspaceId: "workspace",
    directory: fake.directory,
    sessionId: session.id,
    upstreamSessionId: store.getAgentSessionId(session.id)!,
    connectionId: "native:pi",
  }
  return {
    ...fake,
    options,
    adapter,
    store,
    binding,
    async cleanup() {
      await adapter.dispose()
      await fake.dispose()
    },
  }
}
async function collect(adapter: PiHarnessAdapter, binding: AgentExecutionBinding, text: string) {
  const events = []
  for await (const event of adapter.executeTurn(binding, prompt(text))) events.push(event)
  return events
}

describe("native Pi through the shared adapter", () => {
  test("persists distinct product/native identity, reconciles deltas and resumes the native file", async () => {
    const f = await fixture()
    try {
      expect(f.binding.sessionId).not.toBe(f.binding.upstreamSessionId)
      await collect(f.adapter, f.binding, "hello")
      expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("work done")
      await f.adapter.dispose()
      const next = new PiHarnessAdapter(f.options)
      try {
        await collect(next, f.binding, "resume")
        expect(f.store.getAgentSessionId(f.binding.sessionId)).toBe(f.binding.upstreamSessionId)
      } finally {
        await next.dispose()
      }
    } finally {
      await f.cleanup()
    }
  })
  test("returns the process model list and thinking levels", async () => {
    const f = await fixture()
    try {
      expect(JSON.stringify(await f.adapter.probeConfigOptions(f.directory))).toContain("test/model")
    } finally {
      await f.cleanup()
    }
  })
  test.skipIf(unpinnedPi() !== undefined)("lists Pi's catalog when get_available_models is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-probe-"))
    const agentDir = path.join(root, "agent")
    await fs.mkdir(agentDir)
    const adapter = new PiHarnessAdapter({
      binary: resolvePiExecutable(),
      agentDir,
      store: createMemoryRuntimeStore(),
    })
    try {
      const payload = await adapter.probeConfigOptions(root)
      const models = payload.options.find((option) => option.category === "model")?.selectOptions ?? []
      expect(models.some((model) => model.id.startsWith("anthropic/"))).toBe(true)
      expect(models.every((model) => model.connected === false)).toBe(true)
      adapter.setModel(models[0].id)
      const selected = await adapter.probeConfigOptions(root)
      expect(selected.options.find((option) => option.category === "model")?.selectOptions).toEqual(models)
    } finally {
      await adapter.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  test("process death after prompt admission ends the product turn with an error", async () => {
    const f = await fixture()
    try {
      await collect(f.adapter, f.binding, "die")
      expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("Pi process exited")
      expect(f.adapter.readRuntimeHealth(f.directory).status).toBe("degraded")
    } finally {
      await f.cleanup()
    }
  })
  test("asynchronous provider error is retained instead of a successful empty reply", async () => {
    const f = await fixture()
    try {
      await collect(f.adapter, f.binding, "provider-error")
      expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("Provider rejected request")
    } finally {
      await f.cleanup()
    }
  })
  test("missing native file fails without creating a replacement session", async () => {
    const f = await fixture()
    try {
      await f.adapter.dispose()
      await fs.rm(path.join(f.agentDir, "sessions"), { recursive: true })
      await fs.mkdir(path.join(f.agentDir, "sessions"))
      const next = new PiHarnessAdapter(f.options)
      try {
        await collect(next, f.binding, "resume")
        expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("session file is missing")
        expect(await fs.readdir(path.join(f.agentDir, "sessions"))).toEqual([])
      } finally {
        await next.dispose()
      }
    } finally {
      await f.cleanup()
    }
  })
})

test("Pi extension questions are visible, scoped to their session, and settle after a reply", async () => {
  const f = await fixture()
  try {
    const turn = collect(f.adapter, f.binding, "question")
    let questionId: string | undefined
    for (let attempt = 0; attempt < 100 && !questionId; attempt++) {
      questionId = (await f.adapter.listQuestions(f.directory))[0]?.id
      if (!questionId) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(questionId).toBeDefined()
    const other = await f.adapter.createSession(f.directory)
    await expect(
      f.adapter.replyQuestion(
        { ...f.binding, sessionId: other.id, upstreamSessionId: f.store.getAgentSessionId(other.id)! },
        questionId!,
        [["wrong"]],
      ),
    ).rejects.toThrow("does not belong")
    await f.adapter.replyQuestion(f.binding, questionId!, [["Yash"]])
    await turn
    expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("Yash")
    expect(await f.adapter.listQuestions(f.directory)).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test("stopping an extension question releases admission and leaves another session running", async () => {
  const f = await fixture()
  try {
    const first = collect(f.adapter, f.binding, "question")
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.adapter.listQuestions(f.directory)).length) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect((await f.adapter.listQuestions(f.directory)).length).toBe(1)
    const session = await f.adapter.createSession(f.directory)
    const other = { ...f.binding, sessionId: session.id, upstreamSessionId: f.store.getAgentSessionId(session.id)! }
    const second = collect(f.adapter, other, "hello")
    expect(await f.adapter.abort(f.binding)).toMatchObject({ ok: true, status: "cancelled" })
    await Promise.all([first, second])
    expect(JSON.stringify(f.store.getMessages(other.sessionId))).toContain("work done")
    expect(await f.adapter.listQuestions(f.directory)).toEqual([])
    await collect(f.adapter, f.binding, "again")
    expect(JSON.stringify(f.store.getMessages(f.binding.sessionId))).toContain("work done")
  } finally {
    await f.cleanup()
  }
})

test("a goal accounts for work and evaluator usage before its single terminal event", async () => {
  const f = await fixture()
  const recorded: Array<Parameters<typeof f.store.appendEvent>[0]["payload"]> = []
  const append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = (input) => {
    recorded.push(input.payload)
    return append(input)
  }
  try {
    f.store.updateSessionConfig(
      f.binding.sessionId,
      await f.adapter.updateSessionConfig(f.binding, { model: { providerID: "pi", modelID: "test/model" } }),
    )
    await f.adapter.goals!.start(f.binding.sessionId, { objective: "Write and verify the file" }, f.directory)
    const deadline = Date.now() + 5000
    while ((await f.adapter.goals!.read(f.binding.sessionId, f.directory))?.status === "active") {
      if (Date.now() > deadline) throw new Error("Goal failed to finish")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect((await f.adapter.goals!.read(f.binding.sessionId, f.directory))?.status).toBe("complete")
    const usage = recorded.filter((event) => event.type === "session.usage")
    expect(usage).toHaveLength(2)
    expect(usage.map((event) => event.properties.observation?.tokens.input)).toEqual([11, 5])
    expect(recorded.filter((event) => event.type === "session.idle")).toHaveLength(1)
    expect(recorded.indexOf(usage[1])).toBeLessThan(recorded.findIndex((event) => event.type === "session.idle"))
    const messages = f.store.getMessages(f.binding.sessionId)
    const users = messages.filter((message) => message.info.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].parts).toContainEqual(expect.objectContaining({ type: "text", text: "Write and verify the file" }))
    expect(messages.filter((message) => message.info.role === "assistant").every((message) => message.info.parentID === users[0].info.id)).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('"met"')
  } finally {
    await f.cleanup()
  }
})
