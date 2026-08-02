import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeCompatRoutes } from "./opencode-compat"

const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY

afterEach(() => {
  if (previousDirectory === undefined) {
    delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  } else {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
  }
})

describe("OpenCodeCompatRoutes", () => {
  test("pins /path to the configured workspace target", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-compat"
    const app = OpenCodeCompatRoutes()

    const ok = await app.request("http://localhost/path")
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toMatchObject({
      directory: "/tmp/workspace-runtime-compat",
      worktree: "/tmp/workspace-runtime-compat",
    })

    const wrong = await app.request("http://localhost/path?directory=/tmp/other")
    expect(wrong.status).toBe(400)
    await expect(wrong.json()).resolves.toEqual({
      error: {
        code: "path_invalid_directory",
        message: "Path directory must match configured workspace",
      },
    })
  })
})
