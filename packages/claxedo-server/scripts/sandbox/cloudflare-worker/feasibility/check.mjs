import assert from "node:assert/strict"
const origin = process.env.BROKER_PROBE_ORIGIN ?? "http://127.0.0.1:8793"
assert.ok(process.env.BROKER_PROBE_TOKEN, "Set BROKER_PROBE_TOKEN")
const headers = { authorization: `Bearer ${process.env.BROKER_PROBE_TOKEN}` }
assert.equal((await fetch(origin, { method: "POST" })).status, 401, "Unauthenticated requests must not start a sandbox")
try {
  const response = await fetch(origin, { method: "POST", headers, signal: AbortSignal.timeout(240_000) })
  assert.equal(response.status, 200, await response.clone().text())
  const results = await response.json()
  assert.equal(results.length, 6)
  for (const client of ["node", "bun"]) {
    const phases = results.filter((row) => row.client === client)
    assert.deepEqual(phases.map((row) => row.revision), [1, 2, 3])
    assert.equal(new Set(phases.map((row) => row.pid)).size, 1, "The same client must survive rotation and withdrawal")
    for (const row of phases.slice(0, 2)) {
      assert.equal(row.status, 200)
      assert.deepEqual(JSON.parse(row.body), { authenticated: true, revision: row.revision })
    }
    assert.ok([401, 403].includes(phases[2].status), "Withdrawal must reject credential use")
  }
  console.log(JSON.stringify({ ok: true, clients: ["node", "bun"], requests: results.length, productionHandler: true, sameClientRotationAndWithdrawal: true, withdrawalStatuses: results.slice(4).map((row) => row.status) }))
} finally {
  const response = await fetch(`${origin}/destroy`, { method: "POST", headers, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, "sandbox cleanup failed")
}
