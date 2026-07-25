import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

// Boot-level coverage for the desktop server composition. Unit tests run from
// packages that carry their own node_modules/opencode link, so they can never
// see the bundled server's module-resolution reality: the bundle externalizes
// `opencode/node-embed` and loads the engine from the explicit artifact path
// the desktop main hands over (CLAXEDO_CHILD_OPENCODE_EMBED_PATH). These tests
// exercise that path with the real bundle, the real artifact, and a hermetic
// data dir.

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const SERVER_BUNDLE = path.join(PACKAGE_DIR, "resources/claxedo-server/index.js")
const ENGINE_ARTIFACT = path.resolve(PACKAGE_DIR, "../opencode/dist/node/node.js")

const require = createRequire(import.meta.url)

test("embedded OpenCode engine artifact exists at the desktop-resolved path", () => {
  // The desktop main points CLAXEDO_CHILD_OPENCODE_EMBED_PATH at this exact
  // location in dev. If the artifact moves or the dist layout changes, the
  // embedded engine silently dies in the app — fail here instead.
  expect(fs.existsSync(ENGINE_ARTIFACT)).toBe(true)
})

test("bundled claxedo-server boots the embedded engine and serves engine-backed routes", async () => {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] claxedo-server bundle missing — run `bun run predev` first")
    return
  }
  if (!fs.existsSync(ENGINE_ARTIFACT)) {
    console.warn("[skip] embedded engine artifact missing — run `bun run predev` first")
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-boot-test-"))
  const port = await freePort()
  const child = Bun.spawn({
    cmd: [process.execPath, require.resolve("electron/cli.js"), SERVER_BUNDLE],
    env: {
      ...Bun.env,
      ELECTRON_RUN_AS_NODE: "1",
      // Hermetic HOME: no user config, credentials, or caches leak in.
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DESKTOP_PARENT_PID: String(process.pid),
      CLAXEDO_DATA_DIR: mkdir(path.join(root, "data")),
      CLAXEDO_WORKGRAPH_REPOSITORY: mkdir(path.join(root, "workgraph")),
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: ENGINE_ARTIFACT,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  try {
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child)

    // Mirror the app's open-workspace flow: registering the workspace first is
    // what makes engine-backed session routes answer for that directory.
    const directory = encodeURIComponent(PACKAGE_DIR)
    const project = await fetch(`${base}/project/current?directory=${directory}`)
    expect(project.status).toBe(200)

    // /session is engine-backed with no network dependency (pure DB read), so
    // it is the offline-safe discriminator: a dead embedded engine surfaces a
    // 500 here while claxedo-local routes keep answering 200.
    const sessions = await fetch(`${base}/session?directory=${directory}&roots=true`)
    expect(sessions.status).toBe(200)
    expect(await sessions.json()).toBeArray()
  } finally {
    child.kill()
    await child.exited
  }
}, 90_000)

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error("could not allocate a free port")
  return port
}

function mkdir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function waitForHealth(base: string, child: { exited: Promise<number>; stderr: Bun.ReadableStream }) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(250).then(() => false)])
    if (exited) {
      const stderr = await new Response(child.stderr).text()
      throw new Error(`claxedo-server exited before becoming healthy:\n${stderr.slice(-2000)}`)
    }
    const res = await fetch(`${base}/api/claxedo/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
    if (res?.ok) return
  }
  throw new Error("claxedo-server did not become healthy in time")
}
