import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function git(dir: string, command: string) {
  await $`bash -lc ${command}`.cwd(dir).quiet()
}

describe("session diff routes", () => {
  test("GET /session/diff-targets returns targets for requested directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "a.txt"), "one\\n")
    await git(tmp.path, "git add a.txt")
    await git(tmp.path, "git commit -m 'add a'")

    const app = Server.App()
    const response = await app.request(`/session/diff-targets?directory=${encodeURIComponent(tmp.path)}`)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(typeof body.defaultRef).toBe("string")
    expect(body.defaultRef.length > 0).toBe(true)
    expect(Array.isArray(body.candidates)).toBe(true)
    expect(body.candidates.length > 0).toBe(true)
  })

  test("GET /session/:id/diff rejects to-from mode without refs", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({}),
    })

    const app = Server.App()
    const response = await app.request(
      `/session/${session.id}/diff?directory=${encodeURIComponent(tmp.path)}&mode=to-from`,
    )

    expect(response.status).toBe(400)
  })

  test("GET /session/:id/diff supports staged mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "staged.txt"), "one\\n")
    await git(tmp.path, "git add staged.txt")
    await git(tmp.path, "git commit -m 'base'")
    await Bun.write(path.join(tmp.path, "staged.txt"), "one\\ntwo\\n")
    await git(tmp.path, "git add staged.txt")

    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => Session.create({}),
    })

    const app = Server.App()
    const response = await app.request(
      `/session/${session.id}/diff?directory=${encodeURIComponent(tmp.path)}&mode=staged`,
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((item: { file: string }) => item.file === "staged.txt")).toBe(true)
  })
})
