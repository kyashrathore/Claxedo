import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const OUT = path.join(os.tmpdir(), `claxedo-agent-plugins-bundle-${process.pid}`)

afterAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true })
})

function emittedText(dir: string): string {
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return emittedText(full)
    return entry.name.endsWith(".js") ? fs.readFileSync(full, "utf8") : ""
  }).join("\n")
}

test("desktop server bundle emits the Agent Plugins route and activation authority", async () => {
  const script = [
    'import path from "node:path"',
    'import { emitClaxedoServerBundle } from "./bundle-claxedo-server.ts"',
    'await emitClaxedoServerBundle(path.resolve("claxedo-server-boot.ts"), process.env.TEST_AGENT_PLUGINS_OUT)',
  ].join(";")
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      TEST_AGENT_PLUGINS_OUT: OUT,
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

  const text = emittedText(OUT)
  expect(text).toContain("/api/claxedo/plugins")
  expect(text).toContain("agent_plugin_activation_meta")
  expect(text).toContain("codeload.github.com")
}, 300_000)
