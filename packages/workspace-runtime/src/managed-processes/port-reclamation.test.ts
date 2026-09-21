import { afterEach, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { killAndReclaimPort } from "./manager"

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL") } catch {}
    try { child.kill("SIGKILL") } catch {}
  }
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A real listener, so the port lookup finds a real occupier to decide about. */
async function occupy(detached: boolean) {
  const child = spawn(
    process.execPath,
    ["-e", "const s=require('node:net').createServer(()=>{}); s.listen(0,'127.0.0.1',()=>console.log(s.address().port)); setInterval(()=>{},1000)"],
    { detached, stdio: ["ignore", "pipe", "ignore"] },
  )
  children.push(child)
  const port = Number(await new Promise<string>((resolve) => {
    child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()))
  }))
  return { child, port }
}

test.skipIf(process.platform === "win32")("a verifiable occupier of a preferred port is retired and the port comes back", async () => {
  const { child, port } = await occupy(true)

  const outcome = await killAndReclaimPort(port, { termGraceMs: 1_000, killVerifyMs: 1_000 })

  expect(outcome).toEqual({ reclaimed: true })
  expect(alive(child.pid!)).toBe(false)
}, 20_000)

test.skipIf(process.platform === "win32")("an occupier this manager cannot own is reported, not signalled", async () => {
  // Not detached: it shares this process's group, so signalling "its" group
  // would reach the test runner and everything else in here.
  const { child, port } = await occupy(false)

  const outcome = await killAndReclaimPort(port, { termGraceMs: 200, killVerifyMs: 200 })

  expect(outcome).toEqual({ reclaimed: false, reason: "ownership_unverified", pid: child.pid })
  expect(alive(child.pid!)).toBe(true)
}, 20_000)

test.skipIf(process.platform === "win32")("a port nobody holds needs no signal at all", async () => {
  const { child, port } = await occupy(true)
  process.kill(-child.pid!, "SIGKILL")
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(await killAndReclaimPort(port, { termGraceMs: 200, killVerifyMs: 200 })).toEqual({ reclaimed: true })
}, 20_000)
