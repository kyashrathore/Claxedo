import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Scripted wire peer for lifecycle failures; real Pi is exercised separately. */
export async function installFakePiRpc() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-pi-rpc-"))
  const binary = path.join(directory, "pi.mjs")
  await fs.writeFile(
    binary,
    `
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { randomUUID } from "node:crypto"
const args = process.argv.slice(2)
if (args.includes("--version")) { console.log("0.85.0"); process.exit(0) }
if (args.includes("-p")) {
  fs.writeFileSync(path.join(process.cwd(), "evaluating"), "yes")
  if (fs.existsSync(path.join(process.cwd(), "hold-evaluator"))) await new Promise(() => { setInterval(() => {}, 1000) })
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ met: true, reason: "verified" }) }], usage: { input: 5, output: 2 } } })); process.exit(0)
}
const sessionDir = args[args.indexOf("--session-dir") + 1]
const resume = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined
const id = resume ? JSON.parse(fs.readFileSync(resume, "utf8")).id : randomUUID()
const file = resume || path.join(sessionDir, "session_" + id + ".jsonl")
fs.mkdirSync(sessionDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ id }))
fs.writeFileSync(path.join(sessionDir, "..", "launch-env.json"), JSON.stringify(process.env))
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n")
let pending
const done = text => {
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 }, timestamp: Date.now() } })
  emit({ type: "agent_end" }); emit({ type: "agent_settled" })
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line)
  if (cmd.type === "extension_ui_response") { done(cmd.value || "cancelled"); continue }
  const ok = data => emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data })
  switch (cmd.type) {
    case "get_state": ok({ sessionId: id, sessionFile: file, model: { provider: "test", id: "model" }, thinkingLevel: "off" }); break
    case "get_available_models": ok({ models: [{ provider: "test", id: "model", name: "Test" }] }); break
    case "get_available_thinking_levels": ok({ levels: ["off", "high"] }); break
    case "set_model": case "set_thinking_level": case "clear_queue": ok({}); break
    case "steer": ok({}); done("steered: " + cmd.message); break
    case "abort": ok({}); emit({ type: "agent_settled" }); break
    case "prompt":
      ok({}); emit({ type: "agent_start" });
      if (cmd.message === "die") { process.exit(9) }
      if (cmd.message === "hold") break
      if (cmd.message === "question") { emit({ type: "extension_ui_request", id: "question-" + id, method: "input", title: "Name?" }); break }
      if (cmd.message === "provider-error") { emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Provider rejected request", content: [] } }); emit({ type: "agent_settled" }); break }
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "work" } });
      done("work done"); break
    default: emit({ type: "response", id: cmd.id, success: false, error: "unknown command" })
  }
}
`,
  )
  return {
    directory,
    binary,
    agentDir: path.join(directory, "agent"),
    dispose: () => fs.rm(directory, { recursive: true, force: true }),
  }
}
