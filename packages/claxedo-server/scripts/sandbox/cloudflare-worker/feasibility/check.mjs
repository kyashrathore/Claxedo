import assert from "node:assert/strict"
const origin = process.env.BROKER_PROBE_ORIGIN ?? "http://127.0.0.1:8793"
assert.ok(process.env.BROKER_PROBE_TOKEN, "Set BROKER_PROBE_TOKEN")
const headers = { authorization: `Bearer ${process.env.BROKER_PROBE_TOKEN}` }
assert.equal((await fetch(origin, { method: "POST" })).status, 401, "Unauthenticated requests must not start a sandbox")
try {
  const response = await fetch(origin, { method: "POST", headers, signal: AbortSignal.timeout(240_000) })
  assert.equal(response.status, 200, await response.clone().text())
  const results = await response.json()
  assert.equal(results.length, 4)
  for (const [index, result] of results.entries()) {
    assert.equal(result.revision, index < 2 ? 1 : 2)
    assert.equal(result.client, index % 2 ? "bun" : "node")
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      revision: result.revision, url: "https://broker-probe.invalid/probe", clientHeader: "dummy",
    })
  }
  console.log("PASS: Node and Bun HTTPS interception; live handler update; four requests")
} finally {
  const response = await fetch(`${origin}/destroy`, { method: "POST", headers, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, "sandbox cleanup failed")
}
