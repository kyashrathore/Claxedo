import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseSkill } from "./launch-policy"
import { createOpenCodeRuntime } from "./runtime"
import { authorizeWorkspace } from "./scope"

function data(response: unknown): unknown {
  return response && typeof response === "object" && "data" in response ? (response as { data?: unknown }).data : response
}

test("parseSkill reads the frontmatter the engine reads and keeps the body", () => {
  const skill = parseSkill("review", "/skills/review/SKILL.md", '---\nname: "Code review"\ndescription: Review code\n---\n# Steps\n')
  expect(skill as Record<string, unknown>).toEqual({ id: "review", name: "Code review", description: "Review code", location: "/skills/review/SKILL.md", content: "# Steps\n" })
  expect(parseSkill("bare", "/skills/bare/SKILL.md", "no frontmatter")).toMatchObject({ id: "bare", name: "bare", content: "no frontmatter" })
})

test("launch policy exposes skill directories and MCP servers to one workspace and rewrites atomically", async () => {
  // The engine keys locations by real path; a symlinked tmpdir would look like two workspaces.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claxedo-launch-policy-"))
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  const skills = path.join(root, "plugin", "skills")
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  fs.mkdirSync(path.join(skills, "code-review"), { recursive: true })
  fs.writeFileSync(path.join(skills, "code-review", "SKILL.md"), "---\nname: code-review\ndescription: Review code\n---\nReview the diff.\n")
  const scopeA = authorizeWorkspace({ workspaceID: "a", directory: a })
  authorizeWorkspace({ workspaceID: "b", directory: b })
  const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db") })
  const client = await runtime.host.client()
  const skillIds = async (directory: string) =>
    (data(await client.skill.list({ location: { directory } })) as Array<{ id: string }>).map((skill) => skill.id)
  const mcpNames = async (directory: string) =>
    (data(await client.mcp.list({ location: { directory } })) as Array<{ name: string }>).map((server) => server.name)
  try {
    expect(await skillIds(a)).not.toContain("code-review")
    const store = await runtime.launch(scopeA)
    await store.write({
      skills: [skills],
      mcp: { "claxedo-docs": { type: "remote", url: "http://127.0.0.1:9/mcp", disabled: true } },
    })
    expect(await skillIds(a)).toContain("code-review")
    expect(await mcpNames(a)).toContain("claxedo-docs")
    // Workspace-scoped: the other workspace sees neither.
    expect(await skillIds(b)).not.toContain("code-review")
    expect(await mcpNames(b)).not.toContain("claxedo-docs")
    expect(await store.read()).toEqual({
      skills: [skills],
      mcp: { "claxedo-docs": { type: "remote", url: "http://127.0.0.1:9/mcp", disabled: true } },
    })

    await store.write({ skills: [], mcp: {} })
    expect(await skillIds(a)).not.toContain("code-review")
    expect(await mcpNames(a)).not.toContain("claxedo-docs")
  } finally {
    await runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
