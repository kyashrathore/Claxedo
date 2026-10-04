import { describe, expect, test } from "bun:test"
import { convertWslPath, wslPath } from "./apps"

/**
 * The runner never executes anything: it records argv and answers the two
 * questions the converter is allowed to ask, so a payload that only fires
 * inside a shell is visible as recorded text instead of as a side effect.
 */
function recordingWsl(home = "/home/dev") {
  const calls: string[][] = []
  const run = (args: readonly string[]) => {
    calls.push([...args])
    if (args[1] === "wslpath") return `converted(${args[args.length - 1]})\n`
    return home
  }
  return { calls, run }
}

const METACHARACTERS = '/work/$(id)/`id`/"quoted"/a&b;c|d'

describe("wsl path conversion", () => {
  test("a tilde path resolves the Linux home on its own, then passes the whole path to wslpath as one argument", () => {
    const wsl = recordingWsl()

    expect(convertWslPath("~/work/repo", "windows", wsl.run)).toBe("converted(/home/dev/work/repo)")
    expect(wsl.calls).toEqual([
      ["-e", "sh", "-c", 'printf %s "$HOME"'],
      ["-e", "wslpath", "-w", "/home/dev/work/repo"],
    ])
  })

  test("shell metacharacters after the tilde reach wslpath as literal path text and never as command text", () => {
    const wsl = recordingWsl()

    expect(convertWslPath(`~${METACHARACTERS}`, "linux", wsl.run)).toBe(`converted(/home/dev${METACHARACTERS})`)
    expect(wsl.calls[1]).toEqual(["-e", "wslpath", "-u", `/home/dev${METACHARACTERS}`])

    const shellWords = wsl.calls.filter((args) => args[1] === "sh").flat()
    expect(shellWords).toEqual(["-e", "sh", "-c", 'printf %s "$HOME"'])
    expect(shellWords.some((word) => word.includes("$(id)") || word.includes("wslpath"))).toBe(false)
  })

  test("a plain path runs wslpath alone, with the flag the mode asks for", () => {
    const windows = recordingWsl()
    expect(convertWslPath("/home/dev/repo", "windows", windows.run)).toBe("converted(/home/dev/repo)")
    expect(windows.calls).toEqual([["-e", "wslpath", "-w", "/home/dev/repo"]])

    const linux = recordingWsl()
    expect(convertWslPath("C:\\repo", "linux", linux.run)).toBe("converted(C:\\repo)")
    expect(linux.calls).toEqual([["-e", "wslpath", "-u", "C:\\repo"]])

    const unset = recordingWsl()
    convertWslPath("C:\\repo", null, unset.run)
    expect(unset.calls[0]?.[2], "no mode converts toward Linux").toBe("-u")
  })

  test("home-directory whitespace is preserved as literal path data", () => {
    for (const home of ["/home/dev ", "/home/dev\n"]) {
      const wsl = recordingWsl(home)
      convertWslPath("~/repo", "linux", wsl.run)
      expect(wsl.calls[1]).toEqual(["-e", "wslpath", "-u", `${home}/repo`])
    }
  })

  test.skipIf(process.platform === "win32")("off Windows the entrypoint converts nothing", () => {
    expect(wslPath("~/work/repo", "windows")).toBe("~/work/repo")
  })
})
