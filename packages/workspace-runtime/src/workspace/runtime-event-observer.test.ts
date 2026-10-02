import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "@claxedo/session-core"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"

/**
 * `onPresentationEvent` carries session metadata; a host that has to keep something a
 * harness said during the turn — a plan's quota windows, which outlive the
 * session that heard about them — has only the SSE stream without this, and
 * nothing in-process to write them from.
 */
test("a host observer is handed every runtime event the hub publishes, and stops when the host is disposed", async () => {
  const eventHub = createRuntimeEventHub()
  const seen: RuntimeEventEnvelope[] = []
  const host = createWorkspaceHost({ target: { workspaceId: "ws_test", directory: path.join(os.tmpdir(), "runtime-event-observer-root") },
    sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), eventHub, onRuntimeEvent: (event) => seen.push(event) })

  eventHub.publishRuntime({
    directory: "/tmp/workspace",
    sessionId: "ses_1",
    payload: { type: "rate-limit", status: "ok", usedPercent: 23, limitName: "session" },
  })

  expect(seen.map((event) => event.payload)).toEqual([
    { type: "rate-limit", status: "ok", usedPercent: 23, limitName: "session" },
  ])
  expect(seen[0]?.sessionId).toBe("ses_1")

  await host.dispose()
  eventHub.publishRuntime({
    directory: "/tmp/workspace",
    sessionId: "ses_1",
    payload: { type: "rate-limit", status: "limited" },
  })

  expect(seen).toHaveLength(1)
})
