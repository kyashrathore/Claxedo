import { describe, expect, test } from "bun:test"
import { Process } from "@/process/process"
import {
  buildExternal,
  clipped,
  externalTitle,
  formatAge,
  formatUptimeSeconds,
  groupScore,
  groupStatus,
  kindLabel,
  kindTone,
  reasonLabel,
  rooted,
  score,
} from "./groups"

// This module owns how raw OS process rows aggregate into the groups the
// Process Diagnostics dialog surfaces, and the sort order that decides which
// rows a user reaches for when bulk-killing stale/leaked servers. These specs
// pin that behavior so a change to grouping/scoring can't silently retarget a
// destructive action.

type OsRow = Process.DiagnosticOsProcess

function osRow(over: Partial<OsRow> = {}): OsRow {
  return Process.DiagnosticOsProcess.parse({
    pid: over.pid ?? 100,
    ppid: 1,
    pgid: 1,
    state: "R",
    cpu_percent: 0,
    rss_kb: 0,
    elapsed: "00:10",
    kind: "process",
    command: "node server.js",
    command_short: "node",
    status: "active",
    reasons: [],
    ...over,
  })
}

describe("score", () => {
  test("orders stale > suspect > running > everything else", () => {
    expect(score("stale")).toBe(3)
    expect(score("suspect")).toBe(2)
    expect(score("running")).toBe(1)
    expect(score("idle")).toBe(0)
    expect(score("anything-unknown")).toBe(0)
  })
})

describe("groupScore", () => {
  test("orders stale > suspect > active (groups are never idle)", () => {
    expect(groupScore("stale")).toBe(3)
    expect(groupScore("suspect")).toBe(2)
    expect(groupScore("active")).toBe(1)
  })
})

describe("groupStatus", () => {
  test("a single stale child poisons the whole group to stale", () => {
    expect(groupStatus([osRow({ status: "active" }), osRow({ status: "stale" }), osRow({ status: "suspect" })])).toBe(
      "stale",
    )
  })

  test("suspect wins over active when no child is stale", () => {
    expect(groupStatus([osRow({ status: "active" }), osRow({ status: "suspect" })])).toBe("suspect")
  })

  test("all-active children yield an active group", () => {
    expect(groupStatus([osRow({ status: "active" }), osRow({ status: "active" })])).toBe("active")
  })

  test("an empty child list is active (nothing wrong found)", () => {
    expect(groupStatus([])).toBe("active")
  })
})

describe("externalTitle", () => {
  test("prefers the listening port when present", () => {
    expect(externalTitle(osRow({ port: 3000, pid: 42 }))).toBe("Server on :3000")
  })

  test("falls back to the pid when there is no port", () => {
    expect(externalTitle(osRow({ port: undefined, pid: 42 }))).toBe("Server 42")
  })

  test("treats port 0 as a real port, not absent", () => {
    expect(externalTitle(osRow({ port: 0, pid: 42 }))).toBe("Server on :0")
  })
})

describe("buildExternal", () => {
  test("ignores rows that are not external or lack an owner_key", () => {
    const rows = [
      osRow({ owner_kind: "managed_process", owner_key: "m1" }),
      osRow({ owner_kind: "external", owner_key: undefined }),
      osRow({ owner_kind: undefined, owner_key: "x" }),
    ]
    expect(buildExternal(rows)).toEqual([])
  })

  test("groups external rows by owner_key and sums cpu/rss across children", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "A", pid: 10, rss_kb: 100, cpu_percent: 1 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 11, rss_kb: 200, cpu_percent: 2, depth: 1 }),
      osRow({ owner_kind: "external", owner_key: "B", pid: 20, rss_kb: 50, cpu_percent: 5 }),
    ]
    const groups = buildExternal(rows)
    expect(groups.map((g) => g.key)).toEqual(["A", "B"])
    const a = groups.find((g) => g.key === "A")!
    expect(a.rss_kb).toBe(300)
    expect(a.cpu_percent).toBe(3)
    expect(a.children).toHaveLength(2)
  })

  test("picks the heaviest child (rss→cpu→pid) as the representative row for title/pid", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "A", pid: 10, rss_kb: 100, port: 8080 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 11, rss_kb: 500, port: undefined }),
    ]
    const [group] = buildExternal(rows)
    // heaviest by rss is pid 11 (rss 500), which has no port → title falls back to pid
    expect(group.pid).toBe(11)
    expect(group.title).toBe("Server 11")
  })

  test("de-duplicates and ascending-sorts ports across children", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "A", pid: 10, port: 9000 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 11, port: 3000 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 12, port: 3000 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 13, port: undefined }),
    ]
    const [group] = buildExternal(rows)
    expect(group.ports).toEqual([3000, 9000])
  })

  test("counts hidden_children and problem_children per group", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "A", pid: 10, depth: 0 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 11, depth: 1, hidden_by_default: true }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 12, depth: 2, hidden_by_default: false }),
    ]
    const [group] = buildExternal(rows)
    expect(group.hidden_children).toBe(1)
    // problem_children = depth>0 AND not hidden → only pid 12
    expect(group.problem_children).toBe(1)
  })

  test("derives group status from children and sorts worst-status groups first", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "healthy", pid: 10, rss_kb: 999, status: "active" }),
      osRow({ owner_kind: "external", owner_key: "broken", pid: 20, rss_kb: 1, status: "stale" }),
      osRow({ owner_kind: "external", owner_key: "iffy", pid: 30, rss_kb: 5, status: "suspect" }),
    ]
    const groups = buildExternal(rows)
    // stale first, then suspect, then active — despite "healthy" being heaviest
    expect(groups.map((g) => g.key)).toEqual(["broken", "iffy", "healthy"])
    expect(groups.map((g) => g.status)).toEqual(["stale", "suspect", "active"])
  })

  test("breaks same-status group ties by heaviest rss then cpu", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "light", pid: 10, rss_kb: 100, cpu_percent: 9, status: "active" }),
      osRow({ owner_kind: "external", owner_key: "heavy", pid: 20, rss_kb: 900, cpu_percent: 1, status: "active" }),
    ]
    expect(buildExternal(rows).map((g) => g.key)).toEqual(["heavy", "light"])
  })

  test("sorts children within a group by depth then rss/cpu/pid", () => {
    const rows = [
      osRow({ owner_kind: "external", owner_key: "A", pid: 12, depth: 1, rss_kb: 10 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 10, depth: 0, rss_kb: 5 }),
      osRow({ owner_kind: "external", owner_key: "A", pid: 11, depth: 1, rss_kb: 50 }),
    ]
    const [group] = buildExternal(rows)
    // depth 0 first, then within depth 1 the heavier rss (pid 11) before pid 12
    expect(group.children.map((c) => c.pid)).toEqual([10, 11, 12])
  })
})

describe("rooted", () => {
  test("returns root when there is no dir", () => {
    expect(rooted("/home/app", undefined)).toBe("/home/app")
  })

  test("absolute posix dir wins outright", () => {
    expect(rooted("/home/app", "/etc/thing")).toBe("/etc/thing")
  })

  test("absolute windows dir wins outright", () => {
    expect(rooted("C:/app", "D:\\other")).toBe("D:\\other")
  })

  test("joins a relative dir onto root, trimming trailing/leading separators", () => {
    expect(rooted("/home/app/", "./pkg")).toBe("/home/app/pkg")
  })

  test("returns dir when there is no root", () => {
    expect(rooted(undefined, "pkg")).toBe("pkg")
  })
})

describe("formatAge", () => {
  test("DD-HH:MM:SS collapses to days (and hours only when nonzero)", () => {
    expect(formatAge("02-03:04:05")).toBe("2d 3h")
    expect(formatAge("02-00:04:05")).toBe("2d")
  })

  test("HH:MM:SS collapses to hours (and minutes only when nonzero)", () => {
    expect(formatAge("03:04:05")).toBe("3h 4m")
    expect(formatAge("03:00:05")).toBe("3h")
  })

  test("MM:SS collapses to minutes/seconds", () => {
    expect(formatAge("04:05")).toBe("4m 5s")
    expect(formatAge("00:05")).toBe("5s")
  })

  test("unrecognized input passes through verbatim", () => {
    expect(formatAge("weird")).toBe("weird")
  })
})

describe("formatUptimeSeconds", () => {
  test("prefers the two coarsest nonzero units", () => {
    expect(formatUptimeSeconds(2 * 86400 + 3 * 3600)).toBe("2d 3h")
    expect(formatUptimeSeconds(2 * 86400)).toBe("2d")
    expect(formatUptimeSeconds(3 * 3600 + 4 * 60)).toBe("3h 4m")
    expect(formatUptimeSeconds(5 * 60)).toBe("5m")
    expect(formatUptimeSeconds(30)).toBe("0m")
  })
})

describe("reasonLabel", () => {
  test("maps known reason codes to sentences and passes unknowns through", () => {
    expect(reasonLabel("missing-pty")).toBe("Orphaned terminal")
    expect(reasonLabel("dead-port")).toBe("Port not listening")
    expect(reasonLabel("bad-state")).toBe("Unhealthy state")
    expect(reasonLabel("long-running")).toBe("Running 7+ days")
    expect(reasonLabel("custom-thing")).toBe("custom-thing")
  })
})

describe("kindLabel", () => {
  test("labels every owner kind", () => {
    expect(kindLabel("managed_process")).toBe("Managed")
    expect(kindLabel("mcp_server")).toBe("MCP")
    expect(kindLabel("leaked_server")).toBe("Stale")
    expect(kindLabel("external")).toBe("Other")
    expect(kindLabel("server")).toBe("Server")
    expect(kindLabel("app")).toBe("App")
    expect(kindLabel("tab")).toBe("Tab")
  })
})

describe("kindTone", () => {
  test("uses critical tone for leaked servers and warning for external", () => {
    expect(kindTone("leaked_server")).toContain("critical")
    expect(kindTone("external")).toContain("warning")
    expect(kindTone("mcp_server")).toContain("info")
    expect(kindTone("server")).toContain("text-weak")
  })
})

describe("clipped", () => {
  test("collapses whitespace and clips to the max length", () => {
    expect(clipped("a   b\n c", 100)).toBe("a b c")
    expect(clipped(undefined)).toBe("")
    // max 4 → slice(0, 1).trimEnd() + "..." ⇒ the ellipsis dominates a tiny budget
    expect(clipped("abcdefghij", 4)).toBe("a...")
  })
})
