import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HostState } from "@claxedo/host-connector/host-state"
import { doctor, doctorChecks, type DoctorDeps } from "./doctor"
import type { CommandResult, ServiceDeps } from "../connect/service"

const CONTROL_PLANE = "https://cp.example.test"
const RELAY = "https://cp.example.test/relay"
const UNIT = "/home/svc/.config/systemd/user/claxedo-connect.service"
const NOW = 1_000_000

function enrolled(overrides: Partial<HostState> = {}): HostState {
  return {
    host_id: "host_1",
    private_key_jwk: { kty: "EC", crv: "P-256", x: "AQ", y: "AQ" },
    created_at: 1,
    control_plane_url: CONTROL_PLANE,
    enrollment: { enrollment_id: "enr_1", owner_display: "Alice", org_id: "org_1", enrolled_via: "invitation", enrolled_at: 2, key_version: 1 },
    relay: { url: RELAY, jwksUrl: `${RELAY}/.well-known/jwks.json` },
    cli_roots: [],
    storage_root: "/var/lib/claxedo",
    service: { kind: "systemd-user", unit: UNIT, installed_at: 3 },
    run: { pid: 42, started_at: 4, generation: 1, last_beat_ok_at: NOW - 7_000, lease_expires_at: NOW + 60_000 },
    ...overrides,
  }
}

type Box = {
  state?: HostState
  files?: Record<string, string>
  answers?: Record<string, Response | Error>
  commands?: Record<string, CommandResult>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  nodeVersion?: string
  installed?: string[]
}

const healthyAnswers = () => ({
  [`${CONTROL_PLANE}/health`]: Response.json({ status: "ok", platformVersionId: "v1" }),
  [`${RELAY}/health`]: Response.json({ ok: true, service: "workspace-relay" }),
})

const runningSystemd: Record<string, CommandResult> = {
  "loginctl show-user svc --property=Linger --value": { code: 0, stdout: "yes\n" },
  "systemctl --user is-system-running": { code: 0, stdout: "running\n" },
  "systemctl --user is-active claxedo-connect.service": { code: 0, stdout: "active\n" },
  "git --version": { code: 0, stdout: "git version 2.43.0\n" },
}

function deps(box: Box = {}): { deps: DoctorDeps; printed: string[]; probed: string[] } {
  const printed: string[] = []
  const probed: string[] = []
  const commands = box.commands ?? runningSystemd
  const run = async (file: string, args: readonly string[]) => commands[[file, ...args].join(" ")] ?? { code: -1, stdout: "" }
  const env = box.env ?? { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000", CLAXEDO_CONTROL_PLANE_URL: CONTROL_PLANE }
  const service: ServiceDeps = {
    platform: box.platform ?? "linux",
    homedir: "/home/svc",
    username: "svc",
    command: ["/usr/bin/node", "/opt/claxedo/dist/index.mjs"],
    env,
    run,
    writeFile: async () => undefined,
    unlink: async () => undefined,
    now: () => NOW,
  }
  const answers: Record<string, Response | Error> = box.answers ?? healthyAnswers()
  return {
    printed,
    probed,
    deps: {
      platform: box.platform ?? "linux",
      env,
      home: "/home/svc",
      nodeVersion: box.nodeVersion ?? "24.3.0",
      stateFile: "/home/svc/.claxedo/connect/state.json",
      load: async () => box.state,
      readFile: async (file) => box.files?.[file],
      exists: (file) => (box.installed ?? []).includes(file),
      probe: async (url) => {
        probed.push(url)
        const answer = answers[url] ?? new Response("not found", { status: 404 })
        if (answer instanceof Error) throw answer
        const text = await answer.text()
        return { status: answer.status, body: text.startsWith("{") ? JSON.parse(text) : undefined }
      },
      service,
      pidAlive: (pid) => pid === 42,
      now: () => NOW,
      log: (line) => printed.push(line),
    },
  }
}

const systemdUnitWithPath = `[Service]\nExecStart="/usr/bin/node" "/opt/claxedo/dist/index.mjs" "connect" "--foreground"\nEnvironment=PATH="/home/svc/.local/bin:/usr/bin"\n`

describe("claxedo doctor", () => {
  test("a connected Linux machine whose service runs with the shell's PATH passes every check and exits 0", async () => {
    const { deps: doctorDeps, printed, probed } = deps({ state: enrolled(), files: { [UNIT]: systemdUnitWithPath } })
    expect(await doctor(doctorDeps)).toBe(0)
    expect(printed).toEqual([
      "ok    Node 24.3.0",
      `ok    Control plane ${CONTROL_PLANE} answers in 0 ms`,
      `ok    Relay ${RELAY} answers in 0 ms`,
      "ok    Connected; the last beat was 7 s ago",
      "ok    Service claxedo-connect.service is running",
      "ok    git version 2.43.0",
      "info  No Claude Code, Codex or Cursor CLI found; sessions here run on Pi",
    ])
    expect(probed.sort()).toEqual([`${CONTROL_PLANE}/health`, `${RELAY}/health`])
  })

  test("a machine not yet connected on an old Node fails on Node alone and probes the control plane connect would use", async () => {
    const { deps: doctorDeps, printed, probed } = deps({
      nodeVersion: "22.22.0",
      env: { PATH: "/usr/bin", CLAXEDO_CONTROL_PLANE_URL: `${CONTROL_PLANE}/` },
    })
    expect(await doctor(doctorDeps)).toBe(1)
    expect(printed).toEqual([
      "fail  Node 22.22.0 is older than the 24 claxedo needs; install Node 24, or rerun install.sh, which brings its own",
      `ok    Control plane ${CONTROL_PLANE} answers in 0 ms`,
      "info  Relay: this machine learns its relay when it enrolls",
      "info  Not connected yet: `claxedo connect <invitation>` enrolls this machine",
      "info  No service: connect runs only while its terminal is open; `claxedo connect --install-service` keeps it running",
      "ok    git version 2.43.0",
      "info  No Claude Code, Codex or Cursor CLI found; sessions here run on Pi",
    ])
    expect(probed).toEqual([`${CONTROL_PLANE}/health`])
  })

  test("an unreachable relay and a host that answers but is not Claxedo each fail with what was observed", async () => {
    const timeout = new Error("The operation was aborted due to timeout")
    timeout.name = "TimeoutError"
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.1:443") })
    const lines = async (answers: Record<string, Response | Error>) =>
      (await doctorChecks(deps({ state: enrolled(), files: { [UNIT]: systemdUnitWithPath }, answers }).deps)).map((check) => `${check.level} ${check.line}`)

    expect(await lines({ [`${CONTROL_PLANE}/health`]: Response.json({ hello: "captive portal" }), [`${RELAY}/health`]: timeout })).toEqual(expect.arrayContaining([
      `fail Control plane ${CONTROL_PLANE} cannot be reached (its health answer is not Claxedo's); check this machine's network or proxy`,
      `fail Relay ${RELAY} cannot be reached (no answer in 10 s); other devices cannot reach this machine's folders`,
    ]))
    expect(await lines({ [`${CONTROL_PLANE}/health`]: new Response("", { status: 502 }), [`${RELAY}/health`]: refused })).toEqual(expect.arrayContaining([
      `fail Control plane ${CONTROL_PLANE} cannot be reached (it answered 502); check this machine's network or proxy`,
      `fail Relay ${RELAY} cannot be reached (connect ECONNREFUSED 10.0.0.1:443); other devices cannot reach this machine's folders`,
    ]))
  })

  test("a machine enrolled with another control plane than `claxedo host` talks to is told how to manage it from here", async () => {
    const staging = "https://app.staging.example"
    const { deps: doctorDeps } = deps({
      state: enrolled({ control_plane_url: staging }),
      env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
      files: { [UNIT]: systemdUnitWithPath },
      answers: { ...healthyAnswers(), [`${staging}/health`]: Response.json({ status: "ok" }) },
    })
    const checks = await doctorChecks(doctorDeps)
    expect(checks).toContainEqual({ level: "ok", line: `Control plane ${staging} answers in 0 ms` })
    expect(checks).toContainEqual({
      level: "warn",
      line: `This machine is enrolled with ${staging}, but \`claxedo host\` here talks to https://app.claxedo.com; set CLAXEDO_CONTROL_PLANE_URL=${staging} to manage it from here`,
    })
  })

  test("a beat the control plane refused, or a connect that is not running, fails the enrollment line", async () => {
    const refused = enrolled({ run: { pid: 7, started_at: 4, generation: 1, last_beat_error: "This machine was revoked by its owner" } })
    const stopped = enrolled({ run: { pid: 7, started_at: 4, generation: 1 } })
    const paused = enrolled({ run: { pid: 42, started_at: 4, generation: 1, last_beat_ok_at: NOW - 7_000, lease_expires_at: NOW + 60_000, paused_at: NOW - 5_000 } })
    const pending = enrolled({ enrollment: undefined, bootstrap: { invitation_id: "inv_1", token_file: "/t" } })
    const neverEnrolled = enrolled({ enrollment: undefined, run: undefined })
    const line = async (state: HostState) =>
      (await doctorChecks(deps({ state, files: { [UNIT]: systemdUnitWithPath } }).deps)).find((check) => /^(Not serving|Connected|The invitation)/.test(check.line))
    expect(await line(refused)).toEqual({ level: "fail", line: "Not serving: This machine was revoked by its owner" })
    expect(await line(stopped)).toEqual({ level: "fail", line: "Not serving: connect is not running; start it with `claxedo connect` or its service" })
    expect((await doctorChecks(deps({ state: paused, files: { [UNIT]: systemdUnitWithPath } }).deps)).find((check) => /^(Paused|Connected)/.test(check.line)), "a paused machine's lease has not lapsed yet, but it serves nothing")
      .toEqual({ level: "info", line: "Paused by the owner: nothing is served until the owner resumes this machine in the app" })
    expect(await line(pending)).toEqual({ level: "fail", line: "The invitation was not redeemed to the end; run the same `claxedo connect <invitation>` again" })
    expect((await doctorChecks(deps({ state: neverEnrolled, files: { [UNIT]: systemdUnitWithPath } }).deps)).find((check) => check.line.startsWith("Not connected")))
      .toEqual({ level: "info", line: "Not connected yet: `claxedo connect <invitation>` enrolls this machine" })
  })

  describe("the service", () => {
    const serviceLines = async (box: Box) =>
      (await doctorChecks(deps({ state: enrolled(), ...box }).deps)).filter((check) => /[Ss]ervice/.test(check.line))

    test("a unit an older claxedo wrote without PATH is flagged for reinstalling", async () => {
      expect(await serviceLines({ files: { [UNIT]: "[Service]\nExecStart=/usr/bin/node\n" } })).toEqual([
        { level: "ok", line: "Service claxedo-connect.service is running" },
        { level: "warn", line: "The service runs without your shell's PATH, so it may not find codex or the tools agents run; `claxedo connect --install-service` writes it again" },
      ])
    })

    test("a unit file that is gone, a unit systemd reports failed, and a user manager that cannot run each fail with their remedy", async () => {
      expect(await serviceLines({ files: {} })).toEqual([
        { level: "fail", line: `The service file ${UNIT} is gone; \`claxedo connect --install-service\` writes it again` },
      ])
      expect(await serviceLines({
        files: { [UNIT]: systemdUnitWithPath },
        commands: { ...runningSystemd, "systemctl --user is-active claxedo-connect.service": { code: 3, stdout: "failed\n" } },
      })).toEqual([{ level: "fail", line: "Service claxedo-connect.service is failed; `journalctl --user -u claxedo-connect.service` says why" }])
      expect(await serviceLines({
        files: { [UNIT]: systemdUnitWithPath },
        commands: { ...runningSystemd, "loginctl show-user svc --property=Linger --value": { code: 0, stdout: "no\n" } },
      })).toEqual([{
        level: "fail",
        line: "claxedo-connect.service cannot run: lingering is off for svc, so no user manager runs outside a login session; run `sudo loginctl enable-linger svc`",
      }])
    })

    test("a LaunchAgent is read from launchctl's own state line", async () => {
      const plist = "/Users/svc/Library/LaunchAgents/dev.claxedo.connect.plist"
      const launchd = (stdout: string, code = 0) => serviceLines({
        platform: "darwin",
        state: enrolled({ service: { kind: "launchd", unit: plist, installed_at: 3 } }),
        files: { [plist]: "<dict><key>PATH</key><string>/usr/bin</string></dict>" },
        commands: { [`launchctl print gui/${process.getuid?.() ?? 501}/dev.claxedo.connect`]: { code, stdout } },
      })
      expect(await launchd("gui/501/dev.claxedo.connect = {\n\tstate = running\n")).toEqual([{ level: "ok", line: "Service dev.claxedo.connect is running" }])
      expect(await launchd("gui/501/dev.claxedo.connect = {\n\tstate = waiting\n")).toEqual([{ level: "warn", line: "Service dev.claxedo.connect is loaded but waiting" }])
      expect(await launchd("", 113)).toEqual([{
        level: "fail",
        line: `Service dev.claxedo.connect is not loaded; \`launchctl bootstrap gui/$(id -u) ${plist}\` loads it`,
      }])
    })
  })

  test("git missing from PATH fails, and the agent CLIs the runtime would find on PATH are named", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-bin-"))
    try {
      for (const name of ["codex", "cursor-agent"]) await fs.writeFile(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 })
      const { deps: doctorDeps } = deps({ state: enrolled(), files: { [UNIT]: systemdUnitWithPath }, commands: { ...runningSystemd, "git --version": { code: -1, stdout: "" } } })
      const checks = await doctorChecks({ ...doctorDeps, env: { PATH: bin }, home: path.join(bin, "home") })
      expect(checks).toContainEqual({ level: "fail", line: "git is not on PATH, so this machine cannot clone repositories or make worktrees" })
      expect(checks.find((check) => check.line.startsWith("Agent CLIs:"))?.line).toMatch(/^Agent CLIs: (Claude Code, )?Codex, Cursor$/)
    } finally {
      await fs.rm(bin, { recursive: true, force: true })
    }
  })

  describe("on Windows", () => {
    const programFiles = { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" }
    const bashLine = async (box: Box) =>
      (await doctorChecks(deps({ platform: "win32", env: programFiles, state: undefined, ...box }).deps)).find((check) => /bash/i.test(check.line))

    test("Pi's bash is Git Bash where Git for Windows installs it, or a bash on PATH that is not WSL's launcher", async () => {
      expect(await bashLine({ installed: ["C:\\Program Files\\Git\\bin\\bash.exe"] })).toEqual({ level: "ok", line: "Git Bash C:\\Program Files\\Git\\bin\\bash.exe" })
      expect(await bashLine({ commands: { "where.exe bash.exe": { code: 0, stdout: "D:\\msys64\\usr\\bin\\bash.exe\r\n" } } })).toEqual({ level: "ok", line: "bash D:\\msys64\\usr\\bin\\bash.exe" })
    })

    test("only WSL's launcher on PATH warns, and no bash at all fails", async () => {
      expect(await bashLine({ commands: { "where.exe bash.exe": { code: 0, stdout: "C:\\Windows\\System32\\bash.exe\r\n" } } })).toEqual({
        level: "warn",
        line: "Only WSL's bash is on PATH, so Pi would run its commands inside WSL; install Git for Windows",
      })
      expect(await bashLine({ commands: {} })).toEqual({ level: "fail", line: "Git Bash is not installed, so Pi cannot run commands; install Git for Windows" })
    })
  })
})
