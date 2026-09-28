import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../../harness/acp/connection"
import { acpScriptToken } from "../../harness/acp/script"
import type { ClaxedoApi } from "../../harness/api"
import { git } from "../../harness/git"
import type { Stack } from "../../harness/stack"
import { buildWorkspaceFixture, generateWorkspaceFileBytes } from "./workspace-fixture"

const LARGE_SOURCE = process.env.PANEL_LARGE_REPO ?? "/Users/yashvardhansingh/test/opencode"

export type Workspace = { readonly id: string; readonly directory: string; readonly name: string; readonly sessions: readonly string[]; readonly files: readonly string[]; readonly changed: readonly string[] }

async function registerWorkspace(stack: Stack, directory: string, name: string) {
  const resolved = await fetch(`${stack.url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  if (!resolved.ok) throw new Error(`resolve ${directory}: ${resolved.status} ${await resolved.text()}`)
  const project = await fetch(`${stack.url}/api/claxedo/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, source: { kind: "directory", directory } }) })
  if (!project.ok) throw new Error(`project ${directory}: ${project.status} ${await project.text()}`)
  return ((await resolved.json()) as { workspaceId: string }).workspaceId
}

async function seedSessions(stack: Stack, api: ClaxedoApi, directory: string, label: string, count: number) {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const session = await api.createSession(directory, { title: `${label} ${index + 1}`, harness: SCRIPTED_ACP_HARNESS })
    for (let turn = 1; turn <= 3; turn += 1) {
      const script = `${label}-${index}-${turn}`
      await stack.acp.write(script, { steps: [{ kind: "text", text: `Reply ${turn} for ${label} ${index + 1}: ${"lorem ipsum dolor sit amet ".repeat(30)}` }] })
      await api.prompt(directory, session.id, `Question ${turn}. ${acpScriptToken(script)}`)
    }
    ids.push(session.id)
  }
  return ids
}

export async function benchmarkWorkspace(stack: Stack, api: ClaxedoApi): Promise<Workspace> {
  const seed = "panel-switch-lane"
  const manifest = buildWorkspaceFixture({ directoryCount: 16, sourceFileCount: 160, sourceFileBytes: 32768, changedFileCount: 24, diffHunksPerFile: 8, diffLinesPerHunk: 24 }, seed)
  const directory = path.join(stack.dataDir, "workspaces", "bench")
  await fs.mkdir(directory, { recursive: true })
  await git(directory, "init", "-q", "--initial-branch=main")
  for (const revision of ["initial", "current"] as const) {
    for (const file of manifest.files) {
      const target = path.join(directory, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, generateWorkspaceFileBytes(seed, file, revision))
    }
    if (revision === "initial") {
      await git(directory, "add", "-A")
      await git(directory, "commit", "-qm", "benchmark corpus")
    }
  }
  const id = await registerWorkspace(stack, directory, "Bench")
  const sessions = await seedSessions(stack, api, directory, "bench", 2)
  return { id, directory, name: "bench", sessions, files: manifest.files.map((file) => file.path), changed: manifest.changedFilePaths }
}

export async function largeWorkspace(stack: Stack, api: ClaxedoApi): Promise<Workspace> {
  const directory = path.join(stack.dataDir, "workspaces", "large")
  execFileSync("git", ["clone", "-q", "--local", "--no-checkout", LARGE_SOURCE, directory], { stdio: "pipe" })
  execFileSync("git", ["-C", directory, "checkout", "-q", "HEAD"], { stdio: "pipe" })
  const tracked = execFileSync("git", ["-C", directory, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
  const candidates = tracked.filter((file) => file.startsWith("packages/claxedo-app/src/") && file.endsWith(".ts") && !file.endsWith(".test.ts"))
  const changed = candidates.filter((_, index) => index % Math.floor(candidates.length / 40) === 0).slice(0, 40)
  for (const file of changed) {
    const target = path.join(directory, file)
    const text = await fs.readFile(target, "utf8")
    const lines = text.split("\n")
    for (let hunk = 0; hunk < 6; hunk += 1) {
      const at = Math.min(lines.length - 1, Math.floor(((hunk + 1) * lines.length) / 7))
      lines.splice(at, 0, ...Array.from({ length: 12 }, (_, index) => `// changed line ${hunk}-${index} in ${path.basename(file)}`))
    }
    await fs.writeFile(target, lines.join("\n"))
  }
  const id = await registerWorkspace(stack, directory, "Large")
  const sessions = await seedSessions(stack, api, directory, "large", 2)
  return { id, directory, name: "large", sessions, files: tracked, changed }
}
