import { afterAll, afterEach, describe, expect, test } from "vitest"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `file-content-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("./routes/opencode-compat")
const { ensureWorkspace } = await import("./workspace-store")

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

async function repo(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.ru.md"), "# Privet\n")
  sh(`git init -b main ${dir}`)
  sh(`git -C ${dir} config user.email test@example.com`)
  sh(`git -C ${dir} config user.name test`)
  sh(`git -C ${dir} add README.ru.md`)
  sh(`git -C ${dir} commit -m "init"`)
  return dir
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  process.env.CLAXEDO_DATA_DIR = prev
})

describe("opencode compat file content", () => {
  test("reads workspace-relative file paths", async () => {
    const dir = await repo("readme-ru")
    await ensureWorkspace({
      workspaceId: "ws_file_content",
      project_id: "ws_file_content",
      directory: dir,
    })

    const res = await app.request(
      `/file/content?directory=${encodeURIComponent(dir)}&path=${encodeURIComponent("README.ru.md")}`,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      type: "text",
      content: "# Privet",
    })
  })
})
