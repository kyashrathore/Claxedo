import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../harness/api"
import { startCloudProductHost } from "../harness/cloud-product-host"
import { unexpectedEgress } from "../harness/egress-guard"
import { frameType, openEventStream } from "../harness/stream"

export async function run() {
  const host = await startCloudProductHost()
  try {
    const entries = await fs.readdir(host.storeRoot)
    assert.ok(!entries.includes("opencode"), "OpenCode was composed before a session requested it")
    if (process.env.CLAXEDO_E2E_CLOUD_FAULT === "opencode-composition-refused") {
      await fs.writeFile(path.join(host.storeRoot, "opencode"), "composition directory refused")
    }
    const api = new ClaxedoApi(host.url)
    const stream = await openEventStream(host.url, host.directory)
    try {
      const response = await fetch(`${host.url}/session?directory=${encodeURIComponent(host.directory)}&nativeHarness=opencode`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "H19 on-demand OpenCode", harness: { id: "opencode", access: "native" } }),
      })
      const body = await response.text()
      assert.equal(response.status, 201, `C-3: OpenCode did not compose on the product host: ${body}`)
      const session = JSON.parse(body) as { id: string }
      assert.deepEqual((await api.sessionConfig(host.directory, session.id)).harness, { id: "opencode", access: "native" })
      await api.updateSession(host.directory, session.id, { title: "H19 composed session" })
      assert.equal((await api.session(host.directory, session.id)).title, "H19 composed session")
      assert.ok((await fs.stat(path.join(host.storeRoot, "opencode", "opencode.db"))).isFile())
      await stream.waitFor((frame) => frameType(frame) === "session.updated" && (frame.data.payload as { properties?: { info?: { id?: string } } }).properties?.info?.id === session.id,
        { label: "H19 OpenCode persisted session frame" })
      assert.deepEqual(unexpectedEgress(host.guard.attempts), [])
    } finally { stream.close() }
  } finally { await host.close() }
}
