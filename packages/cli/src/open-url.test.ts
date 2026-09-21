import { describe, expect, test } from "bun:test"
import { urlLaunchCommand } from "./open-url"

/** An ordinary device-login URL: its query separator is also cmd.exe's command separator. */
const DEVICE_URL = "https://app.example.test/device?user_code=ABCD-EFGH&next=%26whoami"

describe("urlLaunchCommand", () => {
  test("Windows opens the URL through the protocol handler, with the URL as its own argument", () => {
    const launch = urlLaunchCommand("win32", DEVICE_URL)

    expect(launch).toEqual({ command: "rundll32", args: ["url.dll,FileProtocolHandler", DEVICE_URL] })
    expect(launch.command, "cmd.exe would re-parse & and | out of the URL").not.toBe("cmd")
    expect(launch.args.filter((argument) => argument.includes("user_code"))).toEqual([DEVICE_URL])
  })

  test("macOS and Linux pass the URL to the platform opener as argv", () => {
    expect(urlLaunchCommand("darwin", DEVICE_URL)).toEqual({ command: "open", args: ["--", DEVICE_URL] })
    expect(urlLaunchCommand("linux", DEVICE_URL)).toEqual({ command: "xdg-open", args: [DEVICE_URL] })
  })

  test("only http and https become a launch", () => {
    for (const target of ["file:///Applications/Calculator.app", "javascript:alert(1)", "vscode://file/etc", "ms-settings:", "device?user_code=A"]) {
      expect(() => urlLaunchCommand("win32", target)).toThrow("only http and https URLs open in the browser")
    }
  })
})
