import path from "node:path"

export type ConnectArgs = {
  tokenFile?: string
  /** A pairing code from Claxedo's "Connect a machine…"; the folder the command runs in is the one it asks to share. */
  pair?: string
  roots: string[]
  name?: string
  installService: boolean
  uninstallService: boolean
  foreground: boolean
  alongsideDesktop: boolean
  reset: boolean
  resetRoots: boolean
  direct?: boolean
}

export const connectUsage = `claxedo connect [--pair CODE | --token-file F] [--root DIR]... [--name N] [--direct on|off] [--install-service] [--uninstall-service] [--foreground] [--alongside-desktop] [--reset] [--reset-roots]`

/** `--flag value` and `--flag=value` both read; a flag with no value is an error, not an empty string. */
export function takeValue(args: string[], index: number, flag: string): { value: string; next: number } {
  const arg = args[index] ?? ""
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: index }
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`)
  return { value, next: index + 1 }
}

export function parseConnectArgs(args: string[]): ConnectArgs {
  const parsed: ConnectArgs = {
    roots: [],
    installService: false,
    uninstallService: false,
    foreground: false,
    alongsideDesktop: false,
    reset: false,
    resetRoots: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ""
    if (arg === "--token-file" || arg.startsWith("--token-file=")) {
      const taken = takeValue(args, i, "--token-file")
      parsed.tokenFile = path.resolve(taken.value)
      i = taken.next
      continue
    }
    if (arg === "--pair" || arg.startsWith("--pair=")) {
      const taken = takeValue(args, i, "--pair")
      parsed.pair = taken.value
      i = taken.next
      continue
    }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const taken = takeValue(args, i, "--root")
      if (!path.isAbsolute(taken.value)) throw new Error(`--root must be an absolute path: ${taken.value}`)
      parsed.roots.push(path.resolve(taken.value))
      i = taken.next
      continue
    }
    if (arg === "--name" || arg.startsWith("--name=")) {
      const taken = takeValue(args, i, "--name")
      parsed.name = taken.value
      i = taken.next
      continue
    }
    if (arg === "--direct" || arg.startsWith("--direct=")) {
      const taken = takeValue(args, i, "--direct")
      if (taken.value !== "on" && taken.value !== "off") throw new Error(`--direct takes on or off: ${taken.value}`)
      parsed.direct = taken.value === "on"
      i = taken.next
      continue
    }
    if (arg === "--install-service") {
      parsed.installService = true
      continue
    }
    if (arg === "--uninstall-service") {
      parsed.uninstallService = true
      continue
    }
    if (arg === "--foreground") {
      parsed.foreground = true
      continue
    }
    if (arg === "--alongside-desktop") {
      parsed.alongsideDesktop = true
      continue
    }
    if (arg === "--reset") {
      parsed.reset = true
      continue
    }
    if (arg === "--reset-roots") {
      parsed.resetRoots = true
      continue
    }
    throw new Error(`Unknown connect option: ${arg}\n${connectUsage}`)
  }
  if (parsed.installService && parsed.uninstallService) {
    throw new Error("--install-service and --uninstall-service cannot be combined")
  }
  if (parsed.pair !== undefined && (parsed.tokenFile || parsed.roots.length > 0)) {
    throw new Error("--pair shares the folder it runs in; it takes no --token-file or --root")
  }
  const others = parsed.pair !== undefined || parsed.tokenFile || parsed.roots.length > 0 || parsed.installService || parsed.uninstallService || parsed.foreground || parsed.alongsideDesktop || parsed.direct !== undefined
  if (parsed.reset && (others || parsed.resetRoots)) throw new Error("--reset takes no other options")
  if (parsed.resetRoots && others) throw new Error("--reset-roots takes no other options")
  return parsed
}
