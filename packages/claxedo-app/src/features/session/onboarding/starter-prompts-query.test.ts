import { describe, expect, test } from "bun:test"
import { loadStarterPromptSignals, starterPromptQuery } from "./starter-prompts-query"

describe("starter prompt project signals", () => {
  test("loads files, README, and the first TODO through server APIs", async () => {
    const client = {
      find: {
        files: async () => ({ data: ["src/index.ts", "README.md"] }),
        text: async () => ({ data: [{ path: { text: "src/index.ts" }, lines: { text: "// TODO: retry" }, line_number: 7 }] }),
      },
      file: { read: async () => ({ data: { type: "text" as const, content: "# Project" } }) },
    }

    await expect(loadStarterPromptSignals({ client, directory: "/repo" })).resolves.toEqual({
      files: ["src/index.ts", "README.md"],
      readme: "# Project",
      todos: [{ path: "src/index.ts", line: 7, text: "// TODO: retry" }],
    })
  })

  test("uses a project-scoped infinite-stale query cache", () => {
    const query = starterPromptQuery({
      client: { find: { files: async () => ({ data: [] }), text: async () => ({ data: [] }) }, file: { read: async () => ({}) } },
      directory: "/repo",
    })
    expect(query.queryKey).toEqual(["onboarding", "starter-prompts", "/repo"])
    expect(query.staleTime).toBe(Infinity)
  })

  test("degrades to static-signal inputs when repository inspection is unavailable", async () => {
    const client = {
      find: { files: async () => { throw new Error("offline") }, text: async () => ({ data: [] }) },
      file: { read: async () => ({}) },
    }
    await expect(loadStarterPromptSignals({ client, directory: "/repo" })).resolves.toEqual({ files: [], todos: [] })
  })
})
