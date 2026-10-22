import path from "node:path"
import type { ServiceDeps, ServiceUnitOptions } from "./service"

export const WINDOWS_TASK = "ClaxedoConnect"

/**
 * The task's files live in the user's roaming profile, where no other user
 * can rewrite the script the task runs as this one.
 */
export function windowsServiceDir(deps: Pick<ServiceDeps, "homedir" | "env">) {
  const appData = deps.env.APPDATA?.trim() || path.win32.join(deps.homedir, "AppData", "Roaming")
  return path.win32.join(appData, "Claxedo")
}

export function windowsScriptPath(deps: Pick<ServiceDeps, "homedir" | "env">) {
  return path.win32.join(windowsServiceDir(deps), "claxedo-connect.ps1")
}

export function windowsTaskXmlPath(deps: Pick<ServiceDeps, "homedir" | "env">) {
  return path.win32.join(windowsServiceDir(deps), "claxedo-connect.xml")
}

/** `DOMAIN\user`, the form a task's `UserId` takes; a workgroup machine's domain is its own name. */
export function windowsUserId(deps: Pick<ServiceDeps, "username" | "env">) {
  const domain = deps.env.USERDOMAIN?.trim() || deps.env.COMPUTERNAME?.trim()
  return domain ? `${domain}\\${deps.username}` : deps.username
}

function powershellQuoted(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * The script the task runs. Task Scheduler's own restart-on-failure knows no
 * exempt exit status and gives up after a count, so the loop is here: any
 * failure is retried after 5 s, a clean exit ends the run as Restart=on-failure
 * would, and a control-plane decision (78) disables the task so it is not
 * beaten against until the operator enables it again. Windows delivers no
 * SIGTERM, so an ended task is killed where it stands and never drains; the
 * lease then lapses at the control plane.
 */
export function windowsWrapperScript(
  deps: Pick<ServiceDeps, "command" | "claxedoHome" | "homedir" | "env">,
  options: ServiceUnitOptions,
) {
  const connect = [...deps.command, "connect", "--foreground", ...(options.alongsideDesktop ? ["--alongside-desktop"] : [])]
  const log = path.win32.join(windowsServiceDir(deps), "claxedo-connect.log")
  return [
    `$ErrorActionPreference = 'Continue'`,
    ...(deps.claxedoHome ? [`$env:CLAXEDO_HOME = ${powershellQuoted(deps.claxedoHome)}`] : []),
    `while ($true) {`,
    `  & ${connect.map(powershellQuoted).join(" ")} *>> ${powershellQuoted(log)}`,
    `  $code = $LASTEXITCODE`,
    `  if ($code -eq 78) { schtasks.exe /Change /TN ${WINDOWS_TASK} /Disable | Out-Null; exit 78 }`,
    `  if ($code -eq 0) { exit 0 }`,
    `  Start-Sleep -Seconds 5`,
    `}`,
    ``,
  ].join("\r\n")
}

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Registered with `schtasks /Create /XML`, which takes no `/RU` password and
 * no administrator: the task runs as this user, in this user's session, at
 * this user's logon (`InteractiveToken`), and so only while someone is
 * logged on. `ExecutionTimeLimit` PT0S lifts the three-day default that
 * would otherwise kill the host mid-serve.
 */
export function windowsTaskXml(deps: Pick<ServiceDeps, "username" | "homedir" | "env">) {
  const userId = xml(windowsUserId(deps))
  const script = xml(windowsScriptPath(deps))
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo><Description>Claxedo connect host</Description></RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${userId}</UserId></LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author"><UserId>${userId}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>powershell.exe</Command>`,
    `      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;${script}&quot;</Arguments>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n")
}
