import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken, type AcpScript } from "../harness/acp/script"
import { ClaxedoApi } from "../harness/api"
import { git, gitFolder } from "../harness/git"
import type { Stack } from "../harness/stack"
import type { Workspace } from "../harness/workspaces"

export type SeedData = { workspace: Workspace; sessionId: string; notesSessionId: string }

export const ONBOARDING_FOLDER = "folders/onboarding"

export async function prepareFreshStack(stack: Stack) {
  await gitFolder(path.join(stack.dataDir, path.dirname(ONBOARDING_FOLDER)), path.basename(ONBOARDING_FOLDER))
}

const APP_SOURCE = "export function greet(name: string) {\n  return `Hello, ${name}`\n}\n"
const APP_CHANGED = "export function greet(name: string) {\n  return `Hello, ${name}!`\n}\n"
const REPLY = [
  "The greeting now ends with an exclamation mark.",
  "",
  "```ts",
  APP_CHANGED.trimEnd(),
  "```",
  "",
  "Run `bun test` to check it.",
].join("\n")

function turnScript(directory: string): AcpScript {
  const app = path.join(directory, "src/app.ts")
  return {
    steps: [
      { kind: "reasoning", text: "Reading the greeting first" },
      { kind: "tool", tool: "read", title: "Read src/app.ts", locations: [{ path: app }], text: APP_SOURCE },
      { kind: "tool", tool: "search", title: "Search for greet", input: { pattern: "greet" }, text: "src/app.ts:1: export function greet" },
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status --short" }, text: " M README.md" },
      { kind: "diff", path: app, oldText: APP_SOURCE, newText: APP_CHANGED },
      { kind: "plan", entries: [{ content: "Make the greeting friendlier", priority: "medium", status: "completed" }] },
      { kind: "text", text: REPLY, chunks: 3 },
    ],
  }
}

async function writeProjectFiles(directory: string) {
  await fs.mkdir(path.join(directory, "src"), { recursive: true })
  await fs.writeFile(path.join(directory, "src/app.ts"), APP_SOURCE)
  await git(directory, "add", "--", "src/app.ts")
  await git(directory, "commit", "-q", "-m", "add the greeting", "--", "src/app.ts")
  await fs.writeFile(path.join(directory, "README.md"), "parity\n\nA project for the parity screens.\n")
}

export async function seedStack(stack: Stack): Promise<SeedData> {
  const api = new ClaxedoApi(stack.url)
  const workspace = await stack.daemon.makeWorkspace("parity", "Parity")
  await writeProjectFiles(workspace.directory)
  await stack.acp.write("parity-notes", { steps: [{ kind: "text", text: "Noted." }] })
  const notes = await api.createSession(workspace.directory, { title: "Parity notes", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, notes.id, `Keep a note. ${acpScriptToken("parity-notes")}`)
  await stack.acp.write("parity-turn", turnScript(workspace.directory))
  const session = await api.createSession(workspace.directory, { title: "Parity session", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Make the greeting friendlier. ${acpScriptToken("parity-turn")}`)
  return { workspace, sessionId: session.id, notesSessionId: notes.id }
}
