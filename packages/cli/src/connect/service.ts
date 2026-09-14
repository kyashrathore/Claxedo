import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { HostState } from "@claxedo/host-connector/host-state"

const execFileAsync = promisify(execFile)

export type ServiceKind = NonNullable<HostState["service"]>["kind"]

export type CommandResult = { code: number; stdout: string }

export type ServiceDeps = {
  platform: NodeJS.Platform
  homedir: string
  /** Named in the linger hint; `loginctl` is asked about this user. */
  username: string
  /** The interpreter and script the unit re-runs; `[process.execPath, process.argv[1]]` for a real install. */
  command: readonly string[]
  /** Passed to the unit so the service reads the same state dir this install did. */
  claxedoHome?: string
  /** `XDG_RUNTIME_DIR` is what `systemctl --user` needs to find the user manager's bus. */
  env: NodeJS.ProcessEnv
  /** Resolves for every exit, including a command that could not be spawned (`code` -1); never rejects. */
  run: (file: string, args: readonly string[]) => Promise<CommandResult>
  writeFile: (file: string, text: string) => Promise<void>
  unlink: (file: string) => Promise<void>
  now: () => number
}

export const SYSTEMD_UNIT = "claxedo-connect.service"
export const LAUNCHD_LABEL = "dev.claxedo.connect"

export function defaultServiceDeps(): ServiceDeps {
  const script = process.argv[1]
  if (!script) throw new Error("cannot install a service: the running script path is unknown")
  return {
    platform: process.platform,
    homedir: os.homedir(),
    username: os.userInfo().username,
    command: [process.execPath, path.resolve(script)],
    ...(process.env.CLAXEDO_HOME ? { claxedoHome: process.env.CLAXEDO_HOME } : {}),
    env: process.env,
    run: async (file, args) => {
      try {
        const { stdout } = await execFileAsync(file, [...args])
        return { code: 0, stdout }
      } catch (error) {
        const failed = error as { code?: unknown; stdout?: unknown }
        return {
          code: typeof failed.code === "number" ? failed.code : -1,
          stdout: typeof failed.stdout === "string" ? failed.stdout : "",
        }
      }
    },
    writeFile: async (file, text) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text, { mode: 0o644 })
    },
    unlink: async (file) => {
      await fs.rm(file, { force: true })
    },
    now: () => Date.now(),
  }
}

export function serviceKind(platform: NodeJS.Platform): ServiceKind {
  if (platform === "linux") return "systemd-user"
  if (platform === "darwin") return "launchd"
  throw new Error(`--install-service supports Linux (systemd --user) and macOS (launchd); this is ${platform}`)
}

export function serviceUnitPath(deps: Pick<ServiceDeps, "platform" | "homedir">) {
  return serviceKind(deps.platform) === "systemd-user"
    ? path.join(deps.homedir, ".config", "systemd", "user", SYSTEMD_UNIT)
    : path.join(deps.homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
}

function systemdQuote(value: string) {
  return `"${value.replace(/["\\]/g, "\\$&")}"`
}

export type ServiceUnitOptions = { alongsideDesktop: boolean }

function connectArgs(options: ServiceUnitOptions) {
  return ["connect", "--foreground", ...(options.alongsideDesktop ? ["--alongside-desktop"] : [])]
}

export function systemdUnit(deps: Pick<ServiceDeps, "command" | "claxedoHome">, options: ServiceUnitOptions) {
  const exec = [...deps.command, ...connectArgs(options)].map(systemdQuote).join(" ")
  return [
    "[Unit]",
    "Description=Claxedo connect host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    ...(deps.claxedoHome ? [`Environment=CLAXEDO_HOME=${systemdQuote(deps.claxedoHome)}`] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function singleQuoted(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * launchd's `SuccessfulExit=false` restarts the job on EVERY non-zero exit
 * and knows no exempt status, so a decision (78) would relaunch every 10 s
 * and beat against a refusal forever. The job therefore boots itself out on
 * 78: the plist stays, and the next login (or `launchctl bootstrap`) loads it
 * again — a deliberate re-run after the operator changed something.
 */
export function launchdPlist(deps: Pick<ServiceDeps, "command" | "claxedoHome">, options: ServiceUnitOptions) {
  const connect = [...deps.command, ...connectArgs(options)].map(singleQuoted).join(" ")
  const script = `${connect}; status=$?; if [ "$status" -eq 78 ]; then launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}"; fi; exit "$status"`
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>/bin/sh</string>`,
    `    <string>-c</string>`,
    `    <string>${xml(script)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict><key>SuccessfulExit</key><false/></dict>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    ...(deps.claxedoHome
      ? [
          `  <key>EnvironmentVariables</key>`,
          `  <dict><key>CLAXEDO_HOME</key><string>${xml(deps.claxedoHome)}</string></dict>`,
        ]
      : []),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? 501}`
}

export type InstalledService = NonNullable<HostState["service"]>

/**
 * Write the unit file and describe it; nothing runs yet. The caller records
 * the returned service in the host state BEFORE `startService`, because the
 * unit's process loads that file on its own and rewrites it on every beat —
 * a record saved after the start is overwritten by the child's copy, which
 * never had it.
 */
export async function writeServiceUnit(deps: ServiceDeps, options: ServiceUnitOptions): Promise<InstalledService> {
  const kind = serviceKind(deps.platform)
  const unit = serviceUnitPath(deps)
  await deps.writeFile(unit, kind === "systemd-user" ? systemdUnit(deps, options) : launchdPlist(deps, options))
  return { kind, unit, installed_at: deps.now() }
}

async function must(deps: ServiceDeps, file: string, args: readonly string[]) {
  const result = await deps.run(file, args)
  if (result.code !== 0) throw new Error(`${[file, ...args].join(" ")} exited with ${result.code}`)
}

export type UserManagerCheck = { reachable: true } | { reachable: false; reason: string; remedy: string[] }

/**
 * Whether `systemctl --user` can start anything for this user right now.
 *
 * A user manager exists only while the user has a login session or lingering
 * is on, and `systemctl --user` finds it through `XDG_RUNTIME_DIR`. A cloud-init
 * script runs as the service user with neither, so `enable --now` fails after
 * the unit is written; the check runs first so the install stops with the
 * exact commands instead.
 */
export async function linuxUserManager(deps: ServiceDeps): Promise<UserManagerCheck> {
  const linger = await deps.run("loginctl", ["show-user", deps.username, "--property=Linger", "--value"])
  const enableLinger = `sudo loginctl enable-linger ${deps.username}`
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
    return {
      reachable: false,
      reason: `lingering is off for ${deps.username}, so no user manager runs outside a login session`,
      remedy: [enableLinger, `claxedo connect --install-service`],
    }
  }
  const runtimeDir = deps.env.XDG_RUNTIME_DIR?.trim()
  const exportRuntimeDir = `export XDG_RUNTIME_DIR=/run/user/$(id -u ${deps.username})`
  if (!runtimeDir) {
    return {
      reachable: false,
      reason: "XDG_RUNTIME_DIR is unset, so systemctl --user cannot find the user manager's bus",
      remedy: [exportRuntimeDir, `claxedo connect --install-service`],
    }
  }
  const manager = await deps.run("systemctl", ["--user", "is-system-running"])
  // `is-system-running` exits non-zero for a degraded manager too; only an
  // empty answer means nothing answered on the bus.
  if (manager.stdout.trim() === "") {
    return {
      reachable: false,
      reason: `systemctl --user reached no user manager for ${deps.username} (XDG_RUNTIME_DIR=${runtimeDir})`,
      remedy: [enableLinger, exportRuntimeDir, `claxedo connect --install-service`],
    }
  }
  return { reachable: true }
}

export type StartServiceResult = { started: boolean; lines: string[] }

export async function startService(deps: ServiceDeps, service: InstalledService): Promise<StartServiceResult> {
  if (service.kind === "systemd-user") {
    const manager = await linuxUserManager(deps)
    if (!manager.reachable) {
      return {
        started: false,
        lines: [
          `Wrote ${SYSTEMD_UNIT} (${service.unit}) but did not start it: ${manager.reason}.`,
          `Run, as ${deps.username}:`,
          ...manager.remedy.map((line) => `  ${line}`),
        ],
      }
    }
    await must(deps, "systemctl", ["--user", "daemon-reload"])
    await must(deps, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT])
    return {
      started: true,
      lines: [
        `Installed and started ${SYSTEMD_UNIT} (${service.unit}).`,
        `Restart=on-failure with RestartPreventExitStatus=78: a control-plane decision (exit 78) is not retried; fix the cause, then \`systemctl --user start ${SYSTEMD_UNIT}\`.`,
      ],
    }
  }
  await deps.run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`])
  await must(deps, "launchctl", ["bootstrap", launchdDomain(), service.unit])
  return {
    started: true,
    lines: [
      `Installed and started ${LAUNCHD_LABEL} (${service.unit}).`,
      `KeepAlive/SuccessfulExit=false restarts the job after any failure except a control-plane decision (exit 78), which unloads it until the next login or \`launchctl bootstrap ${launchdDomain()} ${service.unit}\`.`,
    ],
  }
}

export async function uninstallService(deps: ServiceDeps, installed: InstalledService | undefined): Promise<string[]> {
  const kind = installed?.kind ?? serviceKind(deps.platform)
  const unit = installed?.unit ?? serviceUnitPath(deps)
  if (kind === "systemd-user") {
    await deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT])
    await deps.unlink(unit)
    await deps.run("systemctl", ["--user", "daemon-reload"])
    return [`Stopped and removed ${SYSTEMD_UNIT} (${unit}).`]
  }
  await deps.run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`])
  await deps.unlink(unit)
  return [`Stopped and removed ${LAUNCHD_LABEL} (${unit}).`]
}
