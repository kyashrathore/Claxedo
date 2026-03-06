import { describe, expect, test } from "vitest"
import { parseElapsed, parseDiagnosticPs, parseListeningPorts } from "./diagnostics"

describe("process diagnostics parsing", () => {
  test("marks dead claxedo ports as stale", () => {
    const rows = parseDiagnosticPs(
      [
        "34672 32404 32404 SN 0.1 120000 02-07:01:54 node /tmp/app CLAXEDO_TERMINAL_ID=pty_dead CLAXEDO_PORT=65122 OPENCODE_TERMINAL=1",
        "5142 1 5142 S 0.0 42000 17-17:33:14 bun run dev OPENCODE_PROCESS=bun OPENCODE_PROCESS_ID=proc_ok OPENCODE_TERMINAL=1 CLAXEDO_PORT=4096",
      ].join("\n"),
      {
        ptys: [],
        processes: [],
        listening: new Set([4096]),
      },
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]?.status).toBe("stale")
    expect(rows[0]?.reasons).toContain("dead-port")
    expect(rows[0]?.reasons).toContain("missing-pty")
    expect(rows[1]?.status).toBe("suspect")
    expect(rows[1]?.reasons).toContain("long-running")
  })

  test("marks bad process states as suspect", () => {
    const rows = parseDiagnosticPs(
      "1 0 1 Z 12.0 1000 00:10 foo OPENCODE_PROCESS_ID=proc_1 OPENCODE_TERMINAL=1",
      {
        ptys: [],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows[0]?.status).toBe("suspect")
    expect(rows[0]?.reasons).toContain("bad-state")
  })

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

  test("ignores rows without OpenCode or Claxedo linkage", () => {
    const rows = parseDiagnosticPs(
      [
        "100 1 100 S 0.0 1000 00:10 /usr/libexec/somedaemon",
        "101 1 101 S 0.1 2000 00:11 bun run dev OPENCODE_PROCESS_ID=proc_1 OPENCODE_TERMINAL=1",
      ].join("\n"),
      {
        ptys: [],
        processes: [],
        listening: new Set(),
      },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.pid).toBe(101)
  })

  test("parseElapsed handles all ps etime formats", () => {
    expect(parseElapsed("00:30")).toBe(30)
    expect(parseElapsed("14:09")).toBe(849)
    expect(parseElapsed("02:30:00")).toBe(9000)
    expect(parseElapsed("7-00:00:00")).toBe(604800)
    expect(parseElapsed("17-15:01:52")).toBe(1_522_912)
  })

  test("detects desktop app processes by binary path", () => {
    const rows = parseDiagnosticPs(
      [
        "66701 1 66701 S 0.5 80000 01:30:00 /Applications/Claxedo Dev.app/Contents/MacOS/OpenCode",
        "66702 1 66702 S 0.3 70000 00:50:00 /Applications/Claxedo.app/Contents/MacOS/OpenCode",
        "77001 1 77001 S 0.2 60000 00:45:00 /Applications/OpenCode.app/Contents/MacOS/OpenCode",
        "77002 1 77002 S 0.2 60000 00:45:00 /Applications/OpenCode Dev.app/Contents/MacOS/OpenCode",
        "88001 1 88001 S 0.1 50000 00:10:00 /Applications/OpenCode Beta.app/Contents/MacOS/OpenCode",
        "88002 1 88002 S 0.1 50000 00:10:00 /Applications/Claxedo.app/Contents/MacOS/Claxedo",
        "88003 1 88003 S 0.1 50000 00:10:00 /Applications/Claxedo Dev.app/Contents/MacOS/Claxedo",
      ].join("\n"),
      { ptys: [], processes: [], listening: new Set() },
    )

    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.kind === "desktop")).toBe(true)
  })

  test("terminals from another server instance are not flagged as missing-pty", () => {
    // Terminal has CLAXEDO_TERMINAL_ID and CLAXEDO_PORT=63928 (still listening),
    // but its terminal ID is NOT in our PTY list — it belongs to another server.
    const rows = parseDiagnosticPs(
      "75691 67501 75691 Ss 0.0 5000 00:44 /bin/zsh CLAXEDO_TERMINAL_ID=pty_other CLAXEDO_PORT=63928 OPENCODE_TERMINAL=1",
      {
        ptys: [],
        processes: [],
        listening: new Set([63928]),
        serverPid: 99999,
      },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("active")
    expect(rows[0]?.reasons).not.toContain("missing-pty")
  })

  test("terminals from our own server are flagged as missing-pty when untracked", () => {
    // Same scenario but CLAXEDO_PORT is dead (not listening) — the server that
    // owned this terminal is gone, so it's genuinely stale.
    const rows = parseDiagnosticPs(
      "75691 67501 75691 Ss 0.0 5000 00:44 /bin/zsh CLAXEDO_TERMINAL_ID=pty_orphan CLAXEDO_PORT=55555 OPENCODE_TERMINAL=1",
      {
        ptys: [],
        processes: [],
        listening: new Set([63928]),
        serverPid: 99999,
      },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("stale")
    expect(rows[0]?.reasons).toContain("missing-pty")
    expect(rows[0]?.reasons).toContain("dead-port")
  })

  test("processes running 7+ days are suspect with long-running reason", () => {
    const rows = parseDiagnosticPs(
      [
        "200 1 200 S 0.0 5000 6-23:59:59 bun run dev OPENCODE_PROCESS_ID=proc_6d OPENCODE_TERMINAL=1",
        "201 1 201 S 0.0 5000 7-00:00:00 bun run dev OPENCODE_PROCESS_ID=proc_7d OPENCODE_TERMINAL=1",
      ].join("\n"),
      { ptys: [], processes: [], listening: new Set() },
    )

    expect(rows[0]?.status).toBe("active")
    expect(rows[0]?.reasons).not.toContain("long-running")
    expect(rows[1]?.status).toBe("suspect")
    expect(rows[1]?.reasons).toContain("long-running")
  })
})
