import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { request as httpRequest } from "node:http"
import { activateCloudCredential, cloudRuntimeUrl, cloudTransport, createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"
import { sendJson } from "../harness/transport"

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

export async function run() {
  const stack = await startStack({ label: "h30-cloud-consent", cloud: true })
  try {
    const key = `h30-secret-${crypto.randomUUID()}`
    const stored = await sendJson(cloudTransport(stack), "PUT", `${stack.url}/api/claxedo/credentials`, {
      provider_id: "openai", kind: "api_key", source: "managed", scope: "shared", secret: key,
    }, "Storing a cloud-consented account")
    const credential = (JSON.parse(stored) as { credential: { id: string } }).credential
    await activateCloudCredential(stack, credential.id)
    const effective = await fetch(`${stack.url}/api/claxedo/credentials/effective?scope=shared`, { headers: { authorization: `Bearer ${stack.daemon.cloudToken}` } })
    const effectiveBody = await effective.json() as { credentials?: Array<{ provider_id?: string; status?: string; scope?: string; is_active?: boolean }> }
    assert.equal(effective.status, 200)
    assert.ok(effectiveBody.credentials?.some((row) => row.provider_id === "openai" && row.scope === "shared" && row.is_active), "shared account was not active in the server readback")
    const workspace = await createCloudWorkspace(stack, "h30-consent")
    const connection = await waitCloudConnection(stack, workspace.id)
    assert.equal(connection.status, 200, `Cloud connection: ${connection.body}`)
    const first = await cloudRuntimeUrl(stack, workspace.id)
    const names = first.secretNames.filter((name) => name.startsWith("CLAXEDO_PROVIDER_OPENAI_"))
    assert.equal(names.length, 1, `one person's shared account must reach the sandbox under one name: ${first.secretNames.join(",")}`)
    const name = names[0]
    const placeholder = `${name}=claxedo-broker:${name}`
    assert.ok(!sandboxEnvironment(first.pid).includes(key), "real cloud account key entered sandbox process environment")
    assert.ok(!(await sandboxFiles(first.home)).includes(key), "real cloud account key entered sandbox home files")
    assert.ok(!(await sandboxFiles(first.directory)).includes(key), "real cloud account key entered sandbox workspace files")
    if (!sandboxEnvironment(first.pid).includes(placeholder)) {
      throw new Error(`The signed shared credential did not reach its cloud sandbox as a placeholder; delivered names: ${first.secretNames.join(",")}`)
    }

    await sendJson(cloudTransport(stack), "PATCH", `${stack.url}/api/claxedo/credentials/${credential.id}/scope`, { scope: "local" }, "Revoking cloud consent")
    const until = Date.now() + 20_000
    let next = first
    while (Date.now() < until) {
      try { next = await cloudRuntimeUrl(stack, workspace.id) } catch { /* The driver is replacing the runtime. */ }
      if (next.pid !== first.pid) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.notEqual(next.pid, first.pid, "revocation did not replace the sandbox process")
    assert.ok(!sandboxEnvironment(next.pid).includes(placeholder), "revoked placeholder remained in sandbox process")
    assert.ok(!sandboxEnvironment(next.pid).includes(key), "real cloud account key entered renewed sandbox process")
    assert.equal(await refusedBrokerUse(next.pid, `${stack.scripted.v1Url}/chat/completions`, name), 403, "revoked placeholder was accepted by the sandbox broker")
    const readback = await fetch(`${stack.url}/api/claxedo/credentials/openai`, { headers: { authorization: `Bearer ${stack.daemon.cloudToken}` } })
    assert.equal((await readback.json() as { credential: { scope: string } }).credential.scope, "local")
    assert.deepEqual(stack.egress.attempts, [])
  } finally {
    await stack.close()
  }
}
