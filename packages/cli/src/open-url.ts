import { spawn } from "node:child_process"

/**
 * Handing a URL to the OS browser without handing it to a command interpreter.
 *
 * `cmd /c start "" <url>` is the usual Windows recipe and is unsafe here:
 * cmd.exe re-parses its command line, so `&`, `|` and `^` in a URL become
 * command separators, and Node only quotes an argument that contains spaces or
 * quotes. `rundll32 url.dll,FileProtocolHandler` opens the same default browser
 * and reads its target as one argument.
 */

export type UrlLaunch = { command: string; args: string[] }

export function urlLaunchCommand(platform: NodeJS.Platform, target: string): UrlLaunch {
  const protocol = (() => {
    try {
      return new URL(target).protocol
    } catch {
      return undefined
    }
  })()
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Refusing to open ${target}: only http and https URLs open in the browser`)
  }
  if (platform === "darwin") return { command: "open", args: ["--", target] }
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", target] }
  return { command: "xdg-open", args: [target] }
}

export function openUrl(target: string) {
  const launch = urlLaunchCommand(process.platform, target)
  const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}
