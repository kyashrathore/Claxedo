import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ENABLED_OUT = path.join(os.tmpdir(), `claxedo-agent-plugins-enabled-${process.pid}`)
const DISABLED_OUT = path.join(os.tmpdir(), `claxedo-agent-plugins-disabled-${process.pid}`)

afterAll(() => {
  fs.rmSync(ENABLED_OUT, { recursive: true, force: true })
  fs.rmSync(DISABLED_OUT, { recursive: true, force: true })
})

function emittedText(dir: string): string {
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return emittedText(full)
    return entry.name.endsWith(".js") ? fs.readFileSync(full, "utf8") : ""
  }).join("\n")
}

async function bundle(enabled: boolean, out: string) {
  const script = [
    'import path from "node:path"',
    'import { bundleClaxedoServer } from "./bundle-claxedo-server.ts"',
    'await bundleClaxedoServer(path.resolve("claxedo-server-boot.ts"), process.env.TEST_AGENT_PLUGINS_OUT)',
  ].join(";")
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAXEDO_AGENT_PLUGINS: enabled ? "1" : "0",
      TEST_AGENT_PLUGINS_OUT: out,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
}

test("enabled desktop build emits the Agent Plugins route and activation authority", async () => {
  await bundle(true, ENABLED_OUT)

  const text = emittedText(ENABLED_OUT)
  expect(text).toContain("/api/claxedo/plugins")
  expect(text).toContain("agent_plugin_activation_meta")
  expect(text).toContain("codeload.github.com")
}, 300_000)

test("disabled desktop build contains no Agent Plugins route, storage, or catalog fetcher", async () => {
  await bundle(false, DISABLED_OUT)

  const text = emittedText(DISABLED_OUT)
  expect(text).not.toContain("/api/claxedo/plugins")
  expect(text).not.toContain("agent_plugin_activation_meta")
  expect(text).not.toContain("codeload.github.com")
}, 300_000)
