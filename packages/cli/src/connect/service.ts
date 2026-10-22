import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { HostState } from "@claxedo/host-connector/host-state"
import { EXIT_TIMEOUT_S } from "./paths"
import { WINDOWS_TASK, windowsScriptPath, windowsTaskStatus, windowsTaskXml, windowsTaskXmlPath, windowsWrapperScript, xmlTextNode } from "./service-windows"

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
  /** UTF-8 unless `encoding` says otherwise; the Windows task definition is written UTF-16LE. */
  writeFile: (file: string, text: string, options?: { encoding: "utf16le" }) => Promise<void>
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
        const failed = typeof error === "object" && error !== null ? error : {}
        return {
          code: "code" in failed && typeof failed.code === "number" ? failed.code : -1,
          stdout: "stdout" in failed && typeof failed.stdout === "string" ? failed.stdout : "",
        }
      }
    },
    writeFile: async (file, text, options) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text, { mode: 0o644, encoding: options?.encoding ?? "utf8" })
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
  if (platform === "win32") return "windows-task"
  throw new Error(`--install-service supports Linux (systemd --user), macOS (launchd) and Windows (a scheduled task); this is ${platform}`)
}

/** The file the service manager is pointed at, on the platform `deps` names, wherever it is computed. */
export function serviceUnitPath(deps: Pick<ServiceDeps, "platform" | "homedir" | "env">) {
  const kind = serviceKind(deps.platform)
  if (kind === "systemd-user") return path.posix.join(deps.homedir, ".config", "systemd", "user", SYSTEMD_UNIT)
  if (kind === "launchd") return path.posix.join(deps.homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
  return windowsScriptPath(deps)
}

// systemd expands % specifiers and $ variables even inside double quotes;
// %% and $$ are the literal forms.
const SYSTEMD_ESCAPES: Record<string, string> = { "%": "%%", $: "$$", '"': '\\"', "\\": "\\\\" }

function systemdQuote(value: string) {
  return `"${value.replace(/[%$"\\]/g, (c) => SYSTEMD_ESCAPES[c] ?? c)}"`
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
    `TimeoutStopSec=${EXIT_TIMEOUT_S}`,
    ...(deps.claxedoHome ? [`Environment=CLAXEDO_HOME=${systemdQuote(deps.claxedoHome)}`] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

function singleQuoted(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The shell wrapper launchd runs. Two things `sh -c '<connect>; ...'` alone
 * gets wrong:
 *
 * `SuccessfulExit=false` restarts the job on EVERY non-zero exit and knows
 * no exempt status, so a decision (78) would relaunch every 10 s and beat
 * against a refusal forever. The wrapper therefore boots the job out on 78:
 * the plist stays, and the next login (or `launchctl bootstrap`) loads it
 * again — a deliberate re-run after the operator changed something.
 *
 * launchd's SIGTERM reaches the shell, not the command it is waiting on; a
 * non-interactive shell dies on it, and launchd then SIGKILLs the orphaned
 * process group — connect never saw a signal and never drained. The wrapper
 * runs connect in the background, forwards TERM and INT, and waits again
 * after the interrupted `wait` (which answers 128+signal, not the child's
 * status) so the exit status is connect's own.
 *
 * A signal can land before `child=$!` has run, when the trap has no pid to
 * forward to; it is forwarded as soon as the pid exists. A signal that lands
 * after connect already exited makes the next `wait` answer 127 for a child
 * that was reaped, so that answer keeps the status already read.
 */
export function launchdWrapperScript(connect: string, bootout: string) {
  return [
    `child= signalled= forwarded=`,
    `trap 'signalled=1; if [ -n "$child" ]; then forwarded=1; kill -TERM "$child" 2>/dev/null; fi' TERM INT`,
    `${connect} & child=$!`,
    `if [ -n "$signalled" ] && [ -z "$forwarded" ]; then kill -TERM "$child" 2>/dev/null; fi`,
    `wait "$child"; status=$?`,
    `while [ -n "$signalled" ]; do signalled=; wait "$child"; next=$?; if [ "$next" -ne 127 ]; then status=$next; fi; done`,
    `if [ "$status" -eq 78 ]; then ${bootout}; fi`,
    `exit "$status"`,
  ].join("\n")
}

export function launchdPlist(deps: Pick<ServiceDeps, "command" | "claxedoHome">, options: ServiceUnitOptions) {
  const connect = [...deps.command, ...connectArgs(options)].map(singleQuoted).join(" ")
  const script = launchdWrapperScript(connect, `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}"`)
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
    `    <string>${xmlTextNode(script)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict><key>SuccessfulExit</key><false/></dict>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    `  <key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_S}</integer>`,
    ...(deps.claxedoHome
      ? [
          `  <key>EnvironmentVariables</key>`,
          `  <dict><key>CLAXEDO_HOME</key><string>${xmlTextNode(deps.claxedoHome)}</string></dict>`,
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
  const text =
    kind === "systemd-user" ? systemdUnit(deps, options) : kind === "launchd" ? launchdPlist(deps, options) : windowsWrapperScript(deps, options)
  await deps.writeFile(unit, text)
  return { kind, unit, installed_at: deps.now() }
}

async function must(deps: ServiceDeps, file: string, args: readonly string[]) {
  const result = await deps.run(file, args)
  if (result.code !== 0) throw new Error(`${[file, ...args].join(" ")} exited with ${result.code}`)
  return result
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
  if (service.kind === "launchd") {
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
  // `USERDOMAIN` reads WORKGROUP on a workgroup machine, where the account's
  // domain is the computer's name; whoami answers the form the task takes.
  const whoami = await deps.run("whoami.exe", [])
  const userId = whoami.stdout.trim()
  if (whoami.code !== 0 || !userId) throw new Error("whoami.exe did not answer this user's account name")
  // The XML is the registration's input only; the task holds its own copy.
  const taskXml = windowsTaskXmlPath(deps)
  await deps.writeFile(taskXml, windowsTaskXml(deps, userId), { encoding: "utf16le" })
  try {
    await must(deps, "schtasks.exe", ["/Create", "/TN", WINDOWS_TASK, "/XML", taskXml, "/F"])
  } finally {
    await deps.unlink(taskXml)
  }
  // `/Run` answers success for an InteractiveToken task whether or not its
  // user has a session to run in; the task's own status says what happened.
  await must(deps, "schtasks.exe", ["/Run", "/TN", WINDOWS_TASK])
  const status = windowsTaskStatus((await must(deps, "schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/FO", "CSV", "/NH"])).stdout)
  const restarts = `It runs at each logon of ${deps.username} and restarts connect after any failure except a control-plane decision (exit 78), which disables the task until \`schtasks /Change /TN ${WINDOWS_TASK} /Enable\` and \`schtasks /Run /TN ${WINDOWS_TASK}\`.`
  if (status !== "Running") {
    return {
      started: false,
      lines: [
        `Installed the scheduled task ${WINDOWS_TASK} (${service.unit}) but it is ${status}: it runs in ${deps.username}'s desktop session, so it starts at that user's next logon.`,
        restarts,
      ],
    }
  }
  return { started: true, lines: [`Installed and started the scheduled task ${WINDOWS_TASK} (${service.unit}).`, restarts] }
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
  if (kind === "launchd") {
    await deps.run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`])
    await deps.unlink(unit)
    return [`Stopped and removed ${LAUNCHD_LABEL} (${unit}).`]
  }
  await deps.run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK])
  await deps.run("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"])
  await deps.unlink(unit)
  return [`Stopped and removed the scheduled task ${WINDOWS_TASK} (${unit}).`]
}
