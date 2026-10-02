import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { request as httpRequest } from "node:http"
import { hostedOwner, hostedWorkspace, type HostedStack } from "../harness/hosted-flow"
import { hostedFetch, type HostedPerson } from "../harness/hosted-auth"
import { hostedRuntimeTarget } from "../harness/hosted-cloud"
import { startHostedStack } from "../harness/hosted-stack"

async function sandboxFiles(directory: string) {
  const contents: string[] = []
  for (const entry of await fs.readdir(directory, { recursive: true })) {
    const file = path.join(directory, entry)
    if ((await fs.lstat(file)).isFile()) contents.push(await fs.readFile(file, "utf8"))
  }
  return contents.join("\n")
}

function sandboxEnvironment(pid: number) {
  return execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" })
}

async function refusedBrokerUse(pid: number, target: string, name: string) {
  const proxy = /HTTP_PROXY=http:\/\/127\.0\.0\.1:(\d+)/.exec(sandboxEnvironment(pid))
  assert.ok(proxy?.[1], "sandbox has no broker proxy")
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(proxy[1]),
      path: target,
      method: "POST",
      headers: { authorization: `Bearer claxedo-broker:${name}`, "content-type": "application/json" },
    }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    })
    request.on("error", reject)
    request.end("{}")
  })
}

async function connectedPiProviders(stack: HostedStack, owner: HostedPerson) {
  const catalog = await hostedFetch(stack, "/api/claxedo/agent-config/providers?nativeHarness=pi", {}, owner)
  assert.equal(catalog.status, 200, `Pi provider catalog: ${catalog.status}`)
  return (await catalog.json() as { connected: string[] }).connected
}

export async function run() {
  const stack = await startHostedStack("h30-cloud-consent")
  try {
    const owner = await hostedOwner(stack)
    const key = `h30-secret-${crypto.randomUUID()}`
    const stored = await hostedFetch(stack, "/auth/openai?harness=pi", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth: { key } }),
    }, owner)
    assert.equal(stored.status, 200, `Storing a cloud account: ${await stored.text()}`)
    assert.ok((await connectedPiProviders(stack, owner)).includes("openai"), "stored account was not connected in the server readback")
    const workspace = await hostedWorkspace(stack, owner, "h30-consent")
    const connection = await hostedFetch(stack, `/api/workspace/${workspace.id}/connection`, {}, owner)
    assert.equal(connection.status, 200, `Cloud connection: ${await connection.text()}`)
    const first = await hostedRuntimeTarget(stack, workspace.id)
    const names = first.secretNames.filter((name) => name.startsWith("CLAXEDO_PROVIDER_OPENAI_"))
    assert.equal(names.length, 1, `one person's account must reach the sandbox under one name: ${first.secretNames.join(",")}`)
    const name = names[0]
    const placeholder = `${name}=claxedo-broker:${name}`
    assert.ok(!sandboxEnvironment(first.pid).includes(key), "real cloud account key entered sandbox process environment")
    assert.ok(!(await sandboxFiles(first.home)).includes(key), "real cloud account key entered sandbox home files")
    assert.ok(!(await sandboxFiles(first.directory)).includes(key), "real cloud account key entered sandbox workspace files")
    if (!sandboxEnvironment(first.pid).includes(placeholder)) {
      throw new Error(`The stored account did not reach its cloud sandbox as a placeholder; delivered names: ${first.secretNames.join(",")}`)
    }

    const revoked = await hostedFetch(stack, "/auth/openai?harness=pi", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: "{}",
    }, owner)
    assert.equal(revoked.status, 200, `Revoking the cloud account: ${await revoked.text()}`)
    const until = Date.now() + 20_000
    let next = first
    while (Date.now() < until) {
      try { next = await hostedRuntimeTarget(stack, workspace.id) } catch { /* The driver is replacing the runtime. */ }
      if (next.pid !== first.pid) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.notEqual(next.pid, first.pid, "revocation did not replace the sandbox process")
    assert.ok(!sandboxEnvironment(next.pid).includes(placeholder), "revoked placeholder remained in sandbox process")
    assert.ok(!sandboxEnvironment(next.pid).includes(key), "real cloud account key entered renewed sandbox process")
    assert.equal(await refusedBrokerUse(next.pid, `${stack.model.v1Url}/chat/completions`, name), 403, "revoked placeholder was accepted by the sandbox broker")
    assert.ok(!(await connectedPiProviders(stack, owner)).includes("openai"), "revoked account is still connected in the server readback")
    assert.deepEqual(await stack.outboundAttempts(), [])
  } finally {
    await stack.close()
  }
}
