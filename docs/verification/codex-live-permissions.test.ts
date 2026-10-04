import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { codexEntry, makeCodexTransport, recordingBackend, type CodexBackend } from "../../packages/harness/e2e/harness/codex-conformance"
import { setupConformance } from "../../packages/harness/src/conformance/test-support/run"

async function updateNativeDefaults(context: Awaited<ReturnType<typeof setupConformance>>) {
  const entry = codexEntry(context.transport, context.session.binding.sessionId)
  let remove = () => {}
  const acknowledged = new Promise<void>((resolve) => {
    remove = entry.rpc.onMessage((message) => {
      if (message.method === "thread/settings/updated") {
        expect(message.params).toMatchObject({ threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } })
        resolve()
      }
    })
  })
  try {
    await entry.rpc.request("thread/settings/update", { threadId: context.session.binding.upstreamSessionId,
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } })
    await acknowledged
  } finally { remove() }
}

test("thread defaults update but the active sandbox remains unchanged", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-live-command", backend: recorder.backend, makeTransport: makeCodexTransport })
  const backend = context.backend as CodexBackend
  const artifacts = path.resolve(import.meta.dirname, "../../packages/harness/.artifacts")
  await fs.mkdir(artifacts, { recursive: true })
  const outside = await fs.mkdtemp(path.join(artifacts, "codex-live-permissions-"))
  const output = path.join(outside, "outside-workspace.txt")
  backend.server.scriptToolSequence("LIVECOMMAND", [
    { name: "exec_command", input: { cmd: "printf first-batch" } },
    { name: "exec_command", input: { cmd: `printf approved > '${output}'` } },
  ])
  const release = backend.server.holdOpeningReplies("LIVECOMMAND")
  const broker = context.turnBroker()
  let asked = 0
  const running = (async () => {
    for await (const _event of context.transport.send(context.session, context.turn("Run the command LIVECOMMAND"), {
      ...broker, ask: async () => { asked++; return { kind: "permission", decision: "deny" } },
    })) {}
  })()
  try {
    await backend.server.textGateReached("LIVECOMMAND")
    await updateNativeDefaults(context)
    release()
    await running
    expect(asked).toBe(0)
    expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
    expect(recorder.frames.filter((frame) => frame.method === "turn/start")).toHaveLength(1)
    await context.transport.config!.setPermissionMode(context.session, "full-access")
    backend.server.scriptTool({ whenPromptIncludes: "NEXTCOMMAND", name: "exec_command", input: { cmd: `printf approved > '${output}'` } })
    for await (const _event of context.transport.send(context.session, context.turn("Run the command NEXTCOMMAND"), context.turnBroker())) {}
    expect(await fs.readFile(output, "utf8")).toBe("approved")
  } finally {
    release()
    await running
    await context.close()
    await fs.rm(outside, { recursive: true, force: true })
  }
}, 60_000)
