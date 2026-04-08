import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(process.cwd(), `.tmp-file-content-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("./routes/opencode-compat")
const { ensureWorkspace } = await import("./workspace-store")

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

async function repo(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.ru.md"), "# Privet\n")
  await Bun.$`git init -b main ${dir}`.quiet()
  await Bun.$`git -C ${dir} config user.email test@example.com`.quiet()
  await Bun.$`git -C ${dir} config user.name test`.quiet()
  await Bun.$`git -C ${dir} add README.ru.md`.quiet()
  await Bun.$`git -C ${dir} commit -m "init"`.quiet()
  return dir
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
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
