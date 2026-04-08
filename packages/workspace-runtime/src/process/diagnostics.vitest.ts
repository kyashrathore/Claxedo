import { afterEach, describe, expect, test, vi } from "vitest"
import { Process } from "./process"
import {
  buildDiagnosticSnapshot,
  groupDiagnostics,
  parseDiagnosticPs,
  parseElapsed,
  parseListeningPorts,
  terminateDiagnostic,
} from "./diagnostics"

const pty = (id: string, pid: number, title = id) => ({
  id,
  title,
  command: "/bin/zsh",
  args: ["-l"],
  cwd: "/tmp/ws",
  status: "running" as const,
  pid,
  subscribers: 1,
})

const cfg = (id: string, name = id) =>
  Process.ProcessConfig.parse({
    id,
    name,
    command: "bun",
    args: ["run", "dev"],
  })

const proc = (configId: string, ptyId?: string) =>
  Process.ManagedProcess.parse({
    configId,
    ptyId,
    status: "running",
    restartCount: 0,
  })

function grouped(input: {
  lines: string[]
  ptys?: Array<ReturnType<typeof pty>>
  configs?: Array<Process.ProcessConfig>
  processes?: Array<Process.ManagedProcess>
  listening?: number[]
  serverPid?: number
  mcp?: Array<{ name: string; pid: number }>
}) {
  const ptys = input.ptys ?? []
  const configs = input.configs ?? []
  const processes = input.processes ?? []
  const rows = parseDiagnosticPs(input.lines.join("\n"), {
    directory: "/tmp/ws",
    ptys,
    processes,
    listening: new Set(input.listening ?? []),
    serverPid: input.serverPid,
    mcp: input.mcp,
  })

  return groupDiagnostics({
    directory: "/tmp/ws",
    ptys,
    configs,
    processes,
    os: rows,
    server: {
      pid: input.serverPid ?? 99999,
      rss_kb: 100,
      heap_used_kb: 50,
      heap_total_kb: 90,
      uptime_s: 600,
    },
  })
}

describe("process diagnostics parsing", () => {
  test("parses listening ports from lsof output", () => {
    const ports = parseListeningPorts(
      [
        "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
        "bun     63774 user   12u  IPv4 0x0      0t0  TCP 127.0.0.1:4096 (LISTEN)",
        "node    10000 user   13u  IPv6 0x0      0t0  TCP *:65122 (LISTEN)",
      ].join("\n"),
    )

    expect([...ports]).toEqual([4096, 65122])
  })

  test("parseElapsed handles all ps etime formats", () => {
    expect(parseElapsed("00:30")).toBe(30)
    expect(parseElapsed("14:09")).toBe(849)
    expect(parseElapsed("02:30:00")).toBe(9000)
    expect(parseElapsed("7-00:00:00")).toBe(604800)
    expect(parseElapsed("17-15:01:52")).toBe(1_522_912)
  })

  test("ignores rows without OpenCode or Claxedo linkage", () => {
    const rows = parseDiagnosticPs(
      [
        "100 1 100 S 0.0 1000 00:10 /usr/libexec/somedaemon",
        "101 1 101 S 0.1 2000 00:11 bun run dev OPENCODE_PROCESS_ID=proc_1 OPENCODE_TERMINAL=1",
      ].join("\n"),
      {
        directory: "/tmp/ws",
        ptys: [],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.pid).toBe(101)
  })

  test("ignores dev launchers whose repo path happens to contain opencode", () => {
    const rows = parseDiagnosticPs(
      "102 1 102 S 0.1 2000 00:11 bun run dev --cwd /Users/yashvardhansingh/test/opencode/packages/claxedo-app",
      {
        directory: "/tmp/ws",
        ptys: [],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows).toHaveLength(0)
  })

  test("ignores Cursor helper rows whose window title happens to contain opencode", () => {
    const rows = parseDiagnosticPs(
      "103 1 103 S 0.1 2000 00:11 Cursor Helper (Plugin): extension-host (user) opencode [1-4]",
      {
        directory: "/tmp/ws",
        ptys: [],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows).toHaveLength(0)
  })

  test("ignores foreign app helpers even if they inherit Claxedo terminal markers", () => {
    const rows = parseDiagnosticPs(
      "104 1 104 S 0.1 2000 00:11 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper --type=utility CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
      {
        directory: "/tmp/ws",
        ptys: [pty("pty_tab", 100, "Agent 1")],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows).toHaveLength(0)
  })

  test("classifies a current tab tree as one owner with grouped descendants", () => {
    const result = grouped({
      lines: [
        "100 1 100 Ss 0.1 10000 00:10 /bin/zsh CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
        "101 100 100 S 0.2 8000 00:08 /usr/bin/gitstatusd CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
        "102 100 100 S 0.3 7000 00:07 /usr/bin/esbuild CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
      ],
      ptys: [pty("pty_tab", 100, "Agent 1")],
      serverPid: 99999,
    })

    expect(result.owners).toHaveLength(1)
    expect(result.owners[0]?.kind).toBe("tab")
    expect(result.owners[0]?.children).toHaveLength(3)
    expect(result.owners[0]?.hidden_children).toBe(2)
    expect(result.owners[0]?.children.filter((row) => row.depth === 0)).toHaveLength(1)
  })

  test("classifies a managed process with PTY as one managed owner", () => {
    const result = grouped({
      lines: [
        "200 1 200 S 0.4 20000 00:20 bun run dev OPENCODE_PROCESS=web OPENCODE_PROCESS_ID=proc_web CLAXEDO_TERMINAL_ID=pty_proc OPENCODE_TERMINAL=1",
        "201 200 200 S 0.3 5000 00:19 node worker OPENCODE_PROCESS=web OPENCODE_PROCESS_ID=proc_web CLAXEDO_TERMINAL_ID=pty_proc OPENCODE_TERMINAL=1",
      ],
      ptys: [pty("pty_proc", 200, "web")],
      configs: [cfg("proc_web", "web")],
      processes: [proc("proc_web", "pty_proc")],
      serverPid: 99999,
    })

    expect(result.owners).toHaveLength(1)
    expect(result.owners[0]?.kind).toBe("managed_process")
    expect(result.owners[0]?.process_id).toBe("proc_web")
    expect(result.owners[0]?.children).toHaveLength(2)
  })

  test("classifies current server and current app as dedicated owners", () => {
    const result = grouped({
      lines: [
        "400 1 400 S 1.2 64000 00:12 bun /tmp/opencode/dist-serve/serve-entry.js",
        "500 1 500 S 0.8 96000 00:20 /Applications/Claxedo.app/Contents/MacOS/OpenCode",
      ],
      serverPid: 400,
    })

    expect(result.owners.map((item) => item.kind)).toEqual(["server", "app"])
  })

  test("classifies current MCP transports as first-class current owners", () => {
    const result = grouped({
      lines: [
        "400 1 400 S 1.2 64000 00:12 bun /tmp/opencode/dist-serve/serve-entry.js",
        "401 400 400 S 0.5 12000 00:11 opencode /tmp/claxedo-mcp.js",
        "402 401 400 S 0.2 8000 00:10 /usr/bin/python3 worker.py",
      ],
      serverPid: 400,
      mcp: [{ name: "claxedo-mcp", pid: 401 }],
    })

    expect(result.leaks).toHaveLength(0)
    expect(result.owners.map((item) => item.kind)).toEqual(["mcp_server", "server"])
    expect(result.owners[0]?.title).toBe("claxedo-mcp")
    expect(result.owners[0]?.children).toHaveLength(2)
    expect(result.owners[0]?.children.every((item) => item.owner_kind === "mcp_server")).toBe(true)
  })

  test("classifies an old detached server as a leaked group", () => {
    const result = grouped({
      lines: [
        "700 1 700 S 0.4 50000 00:55 bun /tmp/opencode/dist-serve/serve-entry.js CLAXEDO_PORT=5400",
        "701 700 700 S 0.1 8000 00:54 /bin/zsh CLAXEDO_TERMINAL_ID=pty_old CLAXEDO_PORT=5400 OPENCODE_TERMINAL=1",
      ],
      listening: [],
      serverPid: 99999,
    })

    expect(result.leaks).toHaveLength(1)
    expect(result.leaks[0]?.kind).toBe("leaked_server")
    expect(result.leaks[0]?.children).toHaveLength(2)
    expect(result.leaks[0]?.target?.scope).toBe("pid")
    expect(result.summary.leaked.groups).toBe(1)
  })

  test("classifies another alive server as external instead of leaked", () => {
    const result = grouped({
      lines: [
        "800 1 800 S 0.4 50000 00:55 /bin/zsh CLAXEDO_TERMINAL_ID=pty_other CLAXEDO_PORT=63928 OPENCODE_TERMINAL=1",
      ],
      listening: [63928],
      serverPid: 99999,
    })

    expect(result.leaks).toHaveLength(0)
    expect(result.summary.external.groups).toBe(1)
    expect(result.os[0]?.owner_kind).toBe("external")
  })

  test("keeps problematic descendants visible inside their owner", () => {
    const result = grouped({
      lines: [
        "900 1 900 Ss 0.1 10000 00:10 /bin/zsh CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
        "901 900 900 Z 0.2 8000 00:08 /usr/bin/gitstatusd CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
      ],
      ptys: [pty("pty_tab", 900, "Agent 1")],
      serverPid: 99999,
    })

    expect(result.owners[0]?.problem_children).toBe(1)
    expect(result.owners[0]?.children[1]?.hidden_by_default).toBe(false)
  })

  test("buildDiagnosticSnapshot returns grouped owners, leaks, summary, and legacy os", () => {
    const rows = parseDiagnosticPs(
      "100 1 100 Ss 0.1 10000 00:10 /bin/zsh CLAXEDO_TERMINAL_ID=pty_tab CLAXEDO_TAB_ID=tab_1 OPENCODE_TERMINAL=1",
      {
        directory: "/tmp/ws",
        ptys: [pty("pty_tab", 100, "Agent 1")],
        processes: [],
        listening: new Set(),
        serverPid: 99999,
      },
    )

    const snapshot = buildDiagnosticSnapshot({
      directory: "/tmp/ws",
      listening: new Set(),
      server: {
        pid: 99999,
        rss_kb: 10,
        heap_used_kb: 5,
        heap_total_kb: 8,
        uptime_s: 120,
      },
      ptys: [pty("pty_tab", 100, "Agent 1")],
      configs: [],
      processes: [],
      os: rows,
    })

    expect(snapshot.owners).toHaveLength(1)
    expect(snapshot.leaks).toHaveLength(0)
    expect(snapshot.summary.current.groups).toBe(1)
    expect(snapshot.os).toHaveLength(1)
  })

  test("treats a sibling workspace process as external even with the same process id", () => {
    const result = grouped({
      lines: [
        "300 1 300 S 0.4 20000 00:20 bun run dev OPENCODE_PROCESS=web OPENCODE_PROCESS_ID=proc_web CLAXEDO_TERMINAL_ID=pty_other CLAXEDO_WORKSPACE_ID=/tmp/ws-other OPENCODE_TERMINAL=1",
      ],
      ptys: [pty("pty_proc", 200, "web")],
      configs: [cfg("proc_web", "web")],
      processes: [proc("proc_web", "pty_proc")],
      listening: [4100],
      serverPid: 99999,
    })

    expect(result.owners).toHaveLength(0)
    expect(result.leaks).toHaveLength(0)
    expect(result.summary.external.groups).toBe(1)
    expect(result.os[0]?.owner_kind).toBe("external")
  })
})

describe("diagnostic termination", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("terminates a leaked group member-by-member by default", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const ok = await terminateDiagnostic(
      { group_key: "leak:5400" },
      {
        owners: [],
        leaks: [
          Process.DiagnosticGroup.parse({
            key: "leak:5400",
            kind: "leaked_server",
            title: "Leaked server on :5400",
            status: "stale",
            cpu_percent: 1,
            rss_kb: 10,
            ports: [5400],
            pid: 700,
            current: false,
            leaked: true,
            hidden_children: 0,
            problem_children: 0,
            children: [
              Process.DiagnosticOsProcess.parse({
                pid: 700,
                ppid: 1,
                pgid: 700,
                state: "S",
                cpu_percent: 1,
                rss_kb: 10,
                elapsed: "00:10",
                kind: "terminal",
                command: "bun serve",
                command_short: "bun serve",
                status: "stale",
                reasons: ["dead-port"],
                owner_key: "leak:5400",
                owner_kind: "leaked_server",
                leaked: true,
              }),
            ],
            target: {
              group_key: "leak:5400",
              pid: 700,
              scope: "pid",
            },
          }),
        ],
      },
    )

    expect(ok).toBe(true)
    expect(kill).toHaveBeenCalledWith(700, "SIGTERM")
    expect(kill).not.toHaveBeenCalledWith(-700, "SIGTERM")
  })

  test("ignores group scope for grouped cleanup and only kills listed members", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const ok = await terminateDiagnostic(
      { group_key: "leak:5400", scope: "group" },
      {
        owners: [],
        leaks: [
          Process.DiagnosticGroup.parse({
            key: "leak:5400",
            kind: "leaked_server",
            title: "Leaked server on :5400",
            status: "stale",
            cpu_percent: 1,
            rss_kb: 10,
            ports: [5400],
            pid: 700,
            current: false,
            leaked: true,
            hidden_children: 0,
            problem_children: 0,
            children: [
              Process.DiagnosticOsProcess.parse({
                pid: 700,
                ppid: 1,
                pgid: 700,
                state: "S",
                cpu_percent: 1,
                rss_kb: 10,
                elapsed: "00:10",
                kind: "terminal",
                command: "bun serve",
                command_short: "bun serve",
                status: "stale",
                reasons: ["dead-port"],
                owner_key: "leak:5400",
                owner_kind: "leaked_server",
                leaked: true,
              }),
              Process.DiagnosticOsProcess.parse({
                pid: 701,
                ppid: 700,
                pgid: 700,
                state: "S",
                cpu_percent: 1,
                rss_kb: 10,
                elapsed: "00:10",
                kind: "terminal",
                command: "/bin/zsh",
                command_short: "/bin/zsh",
                status: "active",
                reasons: [],
                owner_key: "leak:5400",
                owner_kind: "leaked_server",
                leaked: true,
              }),
            ],
            target: {
              group_key: "leak:5400",
              pid: 700,
              scope: "pid",
            },
          }),
        ],
      },
    )

    expect(ok).toBe(true)
    expect(kill).toHaveBeenCalledWith(700, "SIGTERM")
    expect(kill).toHaveBeenCalledWith(701, "SIGTERM")
    expect(kill).not.toHaveBeenCalledWith(-700, "SIGTERM")
  })
})
