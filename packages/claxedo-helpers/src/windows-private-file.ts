import { spawn } from "node:child_process"
import { join } from "node:path"
import { cmdletFreeCommand, RUNNER_COMMAND, RUNNER_SOURCE, SOURCE_VARIABLE } from "./windows-private-file-program"
import { createPrivateFileRunner, RunnerRefusal, type PrivateStagingReport } from "./windows-private-file-runner"

export type { PrivateStagingReport } from "./windows-private-file-runner"

/**
 * Creating a private file on Windows.
 *
 * Windows has no POSIX mode: `open`'s `mode` only toggles the read-only
 * attribute, `chmod` cannot narrow a DACL, and `stat().mode` reports a
 * synthesized 0o666 that never reflects one. A file's protection is its
 * security descriptor, and a secret under a parent that grants `Users` read is
 * readable by every local account.
 *
 * Applying the descriptor after the file exists does not fix that. Windows
 * checks access when a handle is opened and never again, so a handle opened
 * while the file was still broad keeps reading it after the descriptor
 * narrows — the secret is written into a file someone already holds. Resolving
 * the name a second time is the other half: between the create and the apply,
 * the name can be moved aside and a decoy left in its place, which is what then
 * gets the descriptor, the verification, and the publish.
 *
 * So the descriptor exists at creation, the staging file is opened with no
 * sharing at all, and its name is never resolved again: it is filled through
 * that first handle and published through it too. Node does not open the file
 * on this platform; a PowerShell runner hosting `ClaxedoPrivateFile` owns its
 * whole life.
 *
 * Cleanup is armed on that same handle rather than performed afterwards.
 * Delete-on-close cannot be used, because it is the one disposition
 * `FILE_DISPOSITION_INFO` cannot later clear, and clearing it is exactly what
 * publishing requires. So the classic disposition is set the moment the file
 * exists and cleared before the rename. What that buys, and what it does not,
 * is written out at {@link writeWindowsPrivateFile}.
 *
 * Starting PowerShell and compiling the runner took 300 to 400 ms on a 4-vCPU
 * machine and a write through a running one 3 to 5 ms, so one runner per
 * process serves every write; see {@link createPrivateFileRunner}.
 */

/** Thrown instead of returning: a file that cannot be made private must not receive secret bytes. */
export class PrivateFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrivateFileError"
  }
}

const TARGET_VARIABLE = "CLAXEDO_PRIVATE_FILE_TARGET"

/** Absolute, so `PATH` cannot decide which interpreter enforces the permissions. */
export function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export type WindowsDescriptor = {
  owner: string
  inheritanceBlocked: boolean
  /** Each ACE as SDDL spells it, e.g. `A;;FA;;;S-1-5-21-...`. */
  entries: string[]
}

/**
 * Owner, protection flag and entries read out of SDDL text. Windows renders
 * the descriptor it stored, not the one requested: a DACL set as `D:P` reads
 * back as `D:PAI`, so the flag is tested for `P` rather than compared as text.
 */
export function parseSddl(sddl: string): WindowsDescriptor {
  const parsed = /^O:(\S+?)D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl)
  if (!parsed) throw new Error(`no descriptor could be read from ${sddl}`)
  return {
    owner: parsed[1]!,
    inheritanceBlocked: parsed[2]!.includes("P"),
    entries: [...parsed[3]!.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]!),
  }
}

/**
 * The shape {@link writeWindowsPrivateFile} creates: `user` owns the file and is
 * the only principal granted anything. `user` must be spelled the way the
 * descriptor's SDDL spells it, which is not always the SID: SDDL abbreviates
 * well-known accounts, so SYSTEM reads back as `SY` and a machine's built-in
 * Administrator (RID 500) as `LA`.
 */
export function isOwnerOnlyDescriptor(descriptor: WindowsDescriptor, user: string) {
  return descriptor.owner === user
    && descriptor.inheritanceBlocked
    && descriptor.entries.length === 1
    && descriptor.entries[0] === `A;;FA;;;${user}`
}

/**
 * The current user as SDDL spells it and a file's stored descriptor, from one
 * interpreter run. The path travels in the environment so no quoting rule of
 * PowerShell's can turn it into code.
 */
export function readWindowsFileProtection(file: string): Promise<{ user: string; descriptor: WindowsDescriptor }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        cmdletFreeCommand(
          "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
          "[Console]::Out.WriteLine([System.Security.AccessControl.RawSecurityDescriptor]::new('O:' + $user).GetSddlForm('Owner')); " +
          `$file = [Environment]::GetEnvironmentVariable('${TARGET_VARIABLE}'); ` +
          "[Console]::Out.WriteLine([System.IO.File]::GetAccessControl($file).GetSecurityDescriptorSddlForm('Access, Owner'))",
        ),
      ],
      { env: environment({ [TARGET_VARIABLE]: file }), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let out = ""
    let diagnostics = ""
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString()}`.slice(0, 2_000) })
    child.on("error", (error) => reject(new Error(`Could not read the protection of ${file}: ${error.message}`, { cause: error })))
    child.on("close", (code) => {
      const [owner, sddl] = out.trim().split(/\r?\n/)
      const user = owner?.startsWith("O:") ? owner.slice("O:".length).trim() : undefined
      if (code !== 0 || !user || !sddl) {
        return reject(new Error(`Could not read the protection of ${file}: ${diagnostics.trim() || `the interpreter exited with ${code}`}`))
      }
      try {
        resolve({ user, descriptor: parseSddl(sddl.trim()) })
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * A minimal environment, not this process's own: the control plane's
 * environment holds the signing keys and service tokens `harnessSpawnEnv`
 * exists to keep out of child processes. The secret is not among them — it
 * travels on stdin and appears in no argument, variable or diagnostic.
 */
function environment(variables: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...variables }
  for (const name of ["SystemRoot", "windir", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC"]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Bounded, so a wedged interpreter fails the write rather than hanging a
 * sign-in. The first write includes the runner's startup.
 */
const ANSWER_TIMEOUT_MS = 60_000

/** How long a cancelled request is given to delete its own staging file before the runner is killed. */
const ABORT_GRACE_MS = 5_000

const runPrivateWrite = createPrivateFileRunner({
  launch: () =>
    spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RUNNER_COMMAND],
      { env: environment({ [SOURCE_VARIABLE]: RUNNER_SOURCE }), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    ),
  answerTimeoutMs: ANSWER_TIMEOUT_MS,
  abortGraceMs: ABORT_GRACE_MS,
})

export type WindowsPrivateFileInput = {
  target: string
  /** A name nothing else knows; it is created exclusively and never resolved again. */
  staging: string
  contents: Uint8Array
  /**
   * Runs once the staging file exists and its descriptor has been verified, and
   * before any byte of `contents` is written. Nothing in the product passes it —
   * it is how a test occupies the moment an attacker would have to win, instead
   * of racing it. A throw cancels the write.
   */
  beforeWrite?: (report: PrivateStagingReport) => void | Promise<void>
}

/**
 * What survives what.
 *
 * Before receiving secret bytes, the runner marks the staging file for
 * deletion when its handle closes. The mark remains armed during the write,
 * including process termination. Publication clears it before attempting the
 * rename; a process failure during that attempt or its retry wait can leave
 * an owner-only staging file. Power-loss cleanup is not guaranteed.
 *
 * Cancellation before sending the payload asks the runner not to publish.
 * Discarding the runner is the backstop if it will not answer. Once a complete
 * payload has been sent, a timeout can race publication and its outcome is
 * ambiguous.
 *
 * Success is only ever the runner's `PUBLISHED` answer for this request. A
 * runner that stops, wedges, or dies part-way through an answer fails the
 * request in flight, and the next write starts a fresh runner.
 */
export async function writeWindowsPrivateFile(input: WindowsPrivateFileInput): Promise<void> {
  const refusal = (reason: string) =>
    new PrivateFileError(`Could not create ${input.target} as a private file on Windows: ${reason}`)
  // A NUL ends the name `CreateFileW` sees, so the file created would not be the one asked for.
  if (input.staging.includes("\0") || input.target.includes("\0")) throw refusal("a path contains a NUL character")
  try {
    await runPrivateWrite(input)
  } catch (error) {
    // The caller's own failure from `beforeWrite` passes through unchanged.
    throw error instanceof RunnerRefusal ? refusal(error.message) : error
  }
}
