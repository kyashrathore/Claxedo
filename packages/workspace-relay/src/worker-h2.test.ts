import { describe, expect, test } from "bun:test"
import h2Worker from "./worker-h2"
import type { WorkspaceRelayDurableObjectNamespace } from "./cloudflare"

// A namespace that records every idFromName it is asked for and returns benign
// stubs, so we can assert how the H2 gateway fans connections across shard DOs.
function recordingNamespace() {
  const names: string[] = []
  const namespace: WorkspaceRelayDurableObjectNamespace = {
    idFromName: (name: string) => {
      names.push(name)
      return name
    },
    get: (id) => ({
      fetch: async () => {
        // 101 for WS upgrades, 200 JSON otherwise — enough for the gateway to
        // route and return without touching real relay internals.
        void id
        return new Response(null, { status: 101 })
      },
    }),
  }
  return { namespace, names }
}

function wsRequest(path = "/workspaces/ws_h2/api/claxedo/pty/pty_1/connect") {
  return new Request(`https://relay.test${path}`, {
    headers: { upgrade: "websocket" },
  })
}

describe("workspace relay H2 opener-sharding worker", () => {
  test("fans cloud WebSocket upgrades across OPENER_COUNT shard DOs", async () => {
    const openerCount = 4
    // Shard selection is STATELESS random (a module-global round-robin cursor
    // collapses toward shard 0 under CF's concurrent-isolate spread — the bug
    // that made the first H2 run show no gain). So assert the two properties
    // random sharding must have: every pick is a valid shard, and over many
    // picks the fan-out covers ALL shards (distribution), not "each exactly once".
    const { namespace, names } = recordingNamespace()
    const samples = 400
    for (let i = 0; i < samples; i++) {
      await h2Worker.fetch(wsRequest(), {
        WORKSPACE_RELAY_ROOM: namespace,
        OPENER_COUNT: String(openerCount),
      })
    }
    expect(names).toHaveLength(samples)
    for (const name of names) {
      expect(name).toMatch(/^workspace:ws_h2#opener[0-3]$/)
    }
    // Every shard is hit at least once — proves the fan-out actually distributes
    // (over 400 uniform picks across 4 shards, missing one is astronomically
    // unlikely; a cursor-collapse-to-0 regression would fail this).
    const shards = new Set(names.map((name) => Number(name.split("#opener")[1])))
    expect([...shards].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  test("routes all shards to the same base workspace room name", async () => {
    const { namespace, names } = recordingNamespace()
    await h2Worker.fetch(wsRequest("/workspaces/ws_other/api/claxedo/pty/x/connect"), {
      WORKSPACE_RELAY_ROOM: namespace,
      OPENER_COUNT: "8",
    })
    expect(names[0]).toMatch(/^workspace:ws_other#opener\d+$/)
  })

  test("OPENER_COUNT=1 pins to a single shard (no fan-out)", async () => {
    const { namespace, names } = recordingNamespace()
    for (let i = 0; i < 3; i++) {
      await h2Worker.fetch(wsRequest(), {
        WORKSPACE_RELAY_ROOM: namespace,
        OPENER_COUNT: "1",
      })
    }
    expect(names).toEqual(["workspace:ws_h2#opener0", "workspace:ws_h2#opener0", "workspace:ws_h2#opener0"])
  })

  test("falls back to the stock worker when the DO namespace is unbound", async () => {
    // No WORKSPACE_RELAY_ROOM binding: the stock worker returns its
    // unconfigured 503 rather than the H2 gateway throwing.
    const res = await h2Worker.fetch(wsRequest(), {})
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "relay_durable_object_unconfigured" },
    })
  })
})
