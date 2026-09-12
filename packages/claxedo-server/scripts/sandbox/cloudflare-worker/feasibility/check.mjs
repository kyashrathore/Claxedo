import assert from "node:assert/strict"
const origin = "http://127.0.0.1:8793"
try {
  const response = await fetch(origin, { signal: AbortSignal.timeout(240_000) })
  assert.equal(response.status, 200)
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
  const response = await fetch(`${origin}/destroy`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, "sandbox cleanup failed")
}
