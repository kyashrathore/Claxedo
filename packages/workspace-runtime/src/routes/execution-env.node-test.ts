import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import { pidRunning, serveExecutionEnv, waitForPidExit } from "../test-support/execution-env-server"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

void test("a client disconnect from exec retires the running command", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "wr-execution-env-node-")))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const server = await serveExecutionEnv({ directory })
  cleanups.push(server.close)
  const controller = new AbortController()
  const response = await fetch(`${server.origin}/api/wr/execution-env/exec`, {
    method: "POST", signal: controller.signal, body: JSON.stringify({ command: "echo $$; exec sleep 60" }),
    headers: { ...await server.headers({ sessionId: "ses_1" }), "content-type": "application/json" },
  })
  const reader = response.body!.getReader()
  let text = ""
  while (!/"text":"\d+/.test(text)) text += new TextDecoder().decode((await reader.read()).value)
  const pid = Number(/"text":"(\d+)/.exec(text)![1])
  assert.equal(pidRunning(pid), true)
  controller.abort()
  assert.equal(await waitForPidExit(pid, 10_000), true, `pid ${pid} outlived the disconnect`)
})
