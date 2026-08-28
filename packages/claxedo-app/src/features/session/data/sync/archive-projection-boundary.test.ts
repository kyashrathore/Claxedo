import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { cancelArchiveProjectionReads } from "./archive-projection-boundary"

afterEach(() => queryClient.clear())

describe("archive projection boundary", () => {
  test("cancels only producers that can republish the archived session", async () => {
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancelled: string[] = []
    const tracked = (key: readonly unknown[], label: string) => queryClient.fetchQuery({
      queryKey: key,
      queryFn: async ({ signal }) => {
        signal.addEventListener("abort", () => cancelled.push(label), { once: true })
        await pending
        return label
      },
    }).catch(() => undefined)

    const reads = [
      tracked(queryKeys.shell.sessionList("http://test.local", { scope: "project" }), "list"),
      tracked(queryKeys.shell.sessionInventory("http://test.local"), "inventory"),
      tracked(queryKeys.directory.sessionCache("/repo"), "directory"),
      tracked(["shell", "session", "ses_archived", "config-raw"], "session-resource"),
      tracked(["shell", "local-control-sessions", "http://test.local", "/repo"], "local-source"),
      tracked(["shell", "signed-runtime-sessions", "http://test.local", "wrk_1", "cloud"], "runtime-source"),
      tracked(["shell", "control-plane-sessions", "http://test.local", "wrk_1"], "control-source"),
      tracked(["shell", "global-sync", "workspace-groups", "http://test.local/experimental/session?groupBy=workspace", "request"], "group-source"),
      tracked(["shell", "global-sync", "signed-workspace-snapshot", "http://test.local", "usr_1"], "snapshot-source"),
    ]
    await Promise.resolve()

    await cancelArchiveProjectionReads({ baseUrl: "http://test.local", directory: "/repo", sessionId: "ses_archived" })
    expect(cancelled.sort()).toEqual([
      "control-source",
      "directory",
      "group-source",
      "inventory",
      "list",
      "local-source",
      "runtime-source",
      "session-resource",
      "snapshot-source",
    ])

    release()
    await Promise.all(reads)
  })

  test("leaves another server and directory projections running", async () => {
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancelled: string[] = []
    const tracked = (key: readonly unknown[], label: string) => queryClient.fetchQuery({
      queryKey: key,
      queryFn: async ({ signal }) => {
        signal.addEventListener("abort", () => cancelled.push(label), { once: true })
        await pending
        return []
      },
    })
    const reads = [
      tracked(queryKeys.shell.sessionList("http://other.test", { scope: "project" }), "list"),
      tracked(["shell", "local-control-sessions", "http://other.test", "/repo"], "local-source"),
      tracked(["shell", "global-sync", "workspace-groups", "http://other.test/experimental/session?groupBy=workspace", "request"], "group-source"),
      tracked(["shell", "global-sync", "signed-workspace-snapshot", "http://other.test", "usr_1"], "snapshot-source"),
    ]
    await Promise.resolve()

    await cancelArchiveProjectionReads({ baseUrl: "http://test.local", directory: "/repo", sessionId: "ses_archived" })
    expect(cancelled).toEqual([])
    release()
    await Promise.all(reads)
  })
})
