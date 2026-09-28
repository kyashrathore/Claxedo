import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
for (const subpath of Object.keys(manifest.exports).filter((subpath) => subpath !== "./cursor-worker")) {
  await test(`plain Node imports ${subpath}`, async () => {
    if (subpath === "./testing") {
      await assert.rejects(import("@claxedo/harness/testing"), { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" })
      return
    }
    const exported = await import(`@claxedo/harness/${subpath.slice(2)}`)
    assert.ok(exported)
  })
}

await test("plain Node runs the built Cursor worker protocol", async () => {
  const { spawn } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@claxedo/harness/cursor-worker"))], { stdio: ["pipe", "pipe", "pipe"] })
  let output = ""
  let errors = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { errors += chunk })
  child.stdin.end(JSON.stringify({ id: 1, kind: "close", sessionId: "unused" }) + "\n")
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
  assert.equal(code, 0, errors)
  assert.deepEqual(JSON.parse(output), { id: 1, kind: "result" })
})
