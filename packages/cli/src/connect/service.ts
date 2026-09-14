import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { HostState } from "@claxedo/host-connector/host-state"

const execFileAsync = promisify(execFile)

export type ServiceKind = NonNullable<HostState["service"]>["kind"]

export type ServiceDeps = {
  platform: NodeJS.Platform
  homedir: string
  /** The interpreter and script the unit re-runs; `[process.execPath, process.argv[1]]` for a real install. */
  command: readonly string[]
  /** Passed to the unit so the service reads the same state dir this install did. */
  claxedoHome?: string
  run: (file: string, args: readonly string[]) => Promise<void>
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
    command: [process.execPath, path.resolve(script)],
    ...(process.env.CLAXEDO_HOME ? { claxedoHome: process.env.CLAXEDO_HOME } : {}),
    run: async (file, args) => {
      await execFileAsync(file, [...args])
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

export function systemdUnit(deps: Pick<ServiceDeps, "command" | "claxedoHome">) {
  const exec = [...deps.command, "connect", "--foreground"].map(systemdQuote).join(" ")
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
export function launchdPlist(deps: Pick<ServiceDeps, "command" | "claxedoHome">) {
  const connect = [...deps.command, "connect", "--foreground"].map(singleQuoted).join(" ")
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
export async function writeServiceUnit(deps: ServiceDeps): Promise<InstalledService> {
  const kind = serviceKind(deps.platform)
  const unit = serviceUnitPath(deps)
  await deps.writeFile(unit, kind === "systemd-user" ? systemdUnit(deps) : launchdPlist(deps))
  return { kind, unit, installed_at: deps.now() }
}

export async function startService(deps: ServiceDeps, service: InstalledService): Promise<string[]> {
  if (service.kind === "systemd-user") {
    await deps.run("systemctl", ["--user", "daemon-reload"])
    await deps.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT])
    return [
      `Installed and started ${SYSTEMD_UNIT} (${service.unit}).`,
      `A user service stops at logout unless lingering is on: run \`loginctl enable-linger ${os.userInfo().username}\`.`,
      `Restart=on-failure with RestartPreventExitStatus=78: a control-plane decision (exit 78) is not retried; fix the cause, then \`systemctl --user start ${SYSTEMD_UNIT}\`.`,
    ]
  }
  await deps.run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]).catch(() => undefined)
  await deps.run("launchctl", ["bootstrap", launchdDomain(), service.unit])
  return [
    `Installed and started ${LAUNCHD_LABEL} (${service.unit}).`,
    `KeepAlive/SuccessfulExit=false restarts the job after any failure except a control-plane decision (exit 78), which unloads it until the next login or \`launchctl bootstrap ${launchdDomain()} ${service.unit}\`.`,
  ]
}

export async function uninstallService(deps: ServiceDeps, installed: InstalledService | undefined): Promise<string[]> {
  const kind = installed?.kind ?? serviceKind(deps.platform)
  const unit = installed?.unit ?? serviceUnitPath(deps)
  if (kind === "systemd-user") {
    await deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).catch(() => undefined)
    await deps.unlink(unit)
    await deps.run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined)
    return [`Stopped and removed ${SYSTEMD_UNIT} (${unit}).`]
  }
  await deps.run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]).catch(() => undefined)
  await deps.unlink(unit)
  return [`Stopped and removed ${LAUNCHD_LABEL} (${unit}).`]
}
