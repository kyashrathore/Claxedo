import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { hostname, userInfo } from "node:os"

/**
 * What the machine can tell us about itself.
 *
 * Injected so the derivation is testable on any platform, and because neither
 * reader is reliable: `hostname()` throws on a host with no name configured and
 * `userInfo()` throws when the process runs under a uid with no passwd entry
 * (containers, some CI images).
 */
export type MachineNameSources = {
  computerName: () => string | undefined
  /**
   * The account holder's name as the OS records it — the FULL name where the
   * platform keeps one, because that is what macOS builds its default computer
   * name from. A login name shortened at setup ("bob" for "Robert") cannot
   * explain a computer named `Roberts-MacBook-Air`.
   */
  accountName: () => string | undefined
}

/**
 * What binds is the ROUTE: `enrollBody` and `renameBody` both cap a machine
 * name at 120, while the stores behind them accept the 200 they accept for
 * every display name.
 */
const MAX_LENGTH = 120

/** A directory bound over the network answers slowly; this runs before a window opens. */
const FULL_NAME_TIMEOUT_MS = 2000

const PLACEHOLDER_COMPUTER_NAMES = new Set(["localhost", "localhost.localdomain", "unknown", "computer"])

/**
 * The rest of a default macOS computer name, after the owner's possessive.
 *
 * Only these restore an apostrophe, so a self-named `Docs-Server` keeps its
 * `s` however well it matches the account.
 */
const APPLE_MODELS = [
  "macbook pro",
  "macbook air",
  "macbook",
  "imac pro",
  "imac",
  "mac mini",
  "mac studio",
  "mac pro",
  "mac",
]

/**
 * `os.userInfo()` carries no full name on macOS — the directory service holds
 * it — so `dscl` is the only reader. It prints the value on the line after
 * `RealName:` when it contains a space and on the same line when it does not.
 */
function darwinRealName(login: string): string | undefined {
  try {
    const output = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${login}`, "RealName"], {
      encoding: "utf8",
      timeout: FULL_NAME_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output.replace(/^RealName:/, "").replace(/\s+/g, " ").trim() || undefined
  } catch {
    return undefined
  }
}

/** The GECOS field's first comma-separated part is the full name; the rest is office/phone. */
function gecosName(login: string): string | undefined {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":")
      if (fields[0] !== login) continue
      return fields[4]?.split(",")[0]?.trim() || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

let readAccountName: { value: string | undefined } | undefined

/** Read once per process: the darwin reader spawns, and the answer cannot change under us. */
function accountName(): string | undefined {
  if (readAccountName) return readAccountName.value
  let login: string | undefined
  try {
    login = userInfo().username
  } catch {
    readAccountName = { value: undefined }
    return undefined
  }
  const full = !login
    ? undefined
    : process.platform === "darwin"
      ? darwinRealName(login)
      : process.platform === "linux"
        ? gecosName(login)
        : undefined
  readAccountName = { value: full ?? login ?? undefined }
  return readAccountName.value
}

export const systemMachineNameSources: MachineNameSources = {
  computerName: () => {
    try {
      return hostname()
    } catch {
      return undefined
    }
  },
  accountName,
}

function deviceWord(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Mac"
  if (platform === "win32") return "PC"
  if (platform === "linux") return "Linux machine"
  return "machine"
}

/**
 * The computer's name as a person would write it.
 *
 * The DNS tail goes because mDNS appends `.local` to every name on the network
 * and it is not part of what the user typed in Sharing preferences. An address
 * has that same shape and no name inside it: splitting `192.168.1.5` on the
 * first dot leaves `192`, so an address and a leading all-digit segment are
 * unreadable rather than truncated.
 */
function readableComputerName(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return undefined
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(":")) return undefined
  const withoutDomain = trimmed.split(".")[0] ?? ""
  const spaced = withoutDomain.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
  if (!spaced) return undefined
  if (PLACEHOLDER_COMPUTER_NAMES.has(spaced.toLowerCase())) return undefined
  if (/^\d+$/.test(spaced.split(" ")[0] ?? "")) return undefined
  return spaced
}

function givenName(raw: string | undefined): string | undefined {
  const cleaned = (raw ?? "").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim()
  return cleaned.split(" ")[0] || undefined
}

function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A trailing integer disambiguates two Macs of the same model on one network. */
function isAppleModel(words: readonly string[]): boolean {
  const last = words.at(-1)
  const model = last !== undefined && /^\d+$/.test(last) ? words.slice(0, -1) : words
  return model.length > 0 && APPLE_MODELS.includes(model.join(" ").toLowerCase())
}

/**
 * macOS composes its default computer name from the account holder's full name
 * by dropping the apostrophe — "Yashvardhan" becomes `Yashvardhans-MacBook-Pro`
 * — so the account name is the only thing that can tell us where the
 * possessive went. No other OS does this, and a name whose tail is not an Apple
 * model was typed by someone: `Docs-Server` on the account `docsadmin` passes
 * every other test here and must still read `Docs Server`.
 */
function withPossessiveRestored(
  platform: NodeJS.Platform,
  computer: string,
  account: string | undefined,
): string {
  if (platform !== "darwin" || !account) return computer
  const [first, ...rest] = computer.split(" ")
  if (!first || !/s$/i.test(first)) return computer
  if (!isAppleModel(rest)) return computer
  const stem = first.slice(0, -1)
  if (stem.length < 3) return computer
  if (!account.toLowerCase().startsWith(stem.toLowerCase())) return computer
  return [`${stem}'s`, ...rest].join(" ")
}

/**
 * The name this machine is known by, on every device the account reaches.
 *
 * Derived on the machine itself rather than sent from a renderer or a second
 * device: whoever signs the enrollment is the machine, and a browser asked to
 * name it can only describe the browser.
 */
export function machineDisplayName(
  platform: NodeJS.Platform,
  sources: MachineNameSources = systemMachineNameSources,
): string {
  const account = givenName(sources.accountName())
  const computer = readableComputerName(sources.computerName())
  const name = computer
    ? withPossessiveRestored(platform, computer, account)
    : account
      ? `${capitalized(account)}'s ${deviceWord(platform)}`
      : deviceWord(platform)
  return name.slice(0, MAX_LENGTH)
}
