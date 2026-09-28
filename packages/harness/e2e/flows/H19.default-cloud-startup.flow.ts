import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { startCloudProductHost } from "../harness/cloud-product-host"
import { frameType, openEventStream } from "../harness/stream"

export async function run() {
  const host = await startCloudProductHost("pi")
  try {
    const health = await fetch(`${host.url}/api/wr/health`)
    assert.equal(health.status, 200)
    assert.deepEqual((await health.json() as { harness?: unknown }).harness, { kind: "native", harnessId: "pi" },
      "C-9: the product host did not read the driver's startup harness key")
    const stream = await openEventStream(host.url, host.directory)
    try {
      const created = await fetch(`${host.url}/session?directory=${encodeURIComponent(host.directory)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "H19 default" }),
      })
      const body = await created.text()
      assert.equal(created.status, 201, `H19 default session failed: ${body}`)
      const session = JSON.parse(body) as { id: string }
      const api = new ClaxedoApi(host.url)
      assert.deepEqual((await api.sessionConfig(host.directory, session.id)).harness, { id: "pi", access: "native" })
      await api.updateSession(host.directory, session.id, { title: "H19 composed session" })
      assert.equal((await api.session(host.directory, session.id)).title, "H19 composed session")
      await stream.waitFor((frame) => frameType(frame) === "session.updated" && (frame.data.payload as { properties?: { info?: { id?: string } } }).properties?.info?.id === session.id,
        { label: "H19 default persisted session frame" })
      assert.deepEqual(host.guard.attempts, [])
    } finally { stream.close() }
  } finally { await host.close() }
}
