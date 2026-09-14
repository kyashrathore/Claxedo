import { describe, expect, test } from "bun:test"
import { installService, launchdPlist, serviceKind, serviceUnitPath, systemdUnit, uninstallService, type ServiceDeps } from "./service"

function fakeDeps(platform: NodeJS.Platform, claxedoHome?: string) {
  const calls: string[] = []
  const files = new Map<string, string>()
  const deps: ServiceDeps = {
    platform,
    homedir: "/home/svc",
    command: ["/usr/local/bin/node", "/opt/claxedo/dist/index.mjs"],
    ...(claxedoHome ? { claxedoHome } : {}),
    run: async (file, args) => {
      calls.push([file, ...args].join(" "))
    },
    writeFile: async (file, text) => {
      files.set(file, text)
    },
    unlink: async (file) => {
      files.delete(file)
    },
    now: () => 42,
  }
  return { deps, calls, files }
}

describe("service units", () => {
  test("Linux gets a systemd --user unit that never restarts into a decision", async () => {
    const { deps, calls, files } = fakeDeps("linux", "/var/lib/claxedo")
    const installed = await installService(deps)
    const unit = "/home/svc/.config/systemd/user/claxedo-connect.service"
    expect(installed.service).toEqual({ kind: "systemd-user", unit, installed_at: 42 })
    expect(files.get(unit)).toBe(systemdUnit(deps))
    expect(files.get(unit)).toContain(`ExecStart="/usr/local/bin/node" "/opt/claxedo/dist/index.mjs" "connect" "--foreground"`)
    expect(files.get(unit)).toContain("Restart=on-failure\nRestartSec=5\nRestartPreventExitStatus=78")
    expect(files.get(unit)).toContain(`Environment=CLAXEDO_HOME="/var/lib/claxedo"`)
    expect(files.get(unit)).toContain("WantedBy=default.target")
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now claxedo-connect.service"])
    expect(installed.lines.some((line) => line.includes("loginctl enable-linger"))).toBe(true)
    expect(installed.lines.some((line) => line.includes("exit 78) is not retried"))).toBe(true)

    expect(await uninstallService(deps, installed.service)).toEqual([`Stopped and removed claxedo-connect.service (${unit}).`])
    expect(files.has(unit)).toBe(false)
    expect(calls.slice(2)).toEqual(["systemctl --user disable --now claxedo-connect.service", "systemctl --user daemon-reload"])
  })

  test("macOS gets a LaunchAgent whose wrapper boots the job out on exit 78", async () => {
    const { deps, calls, files } = fakeDeps("darwin")
    const installed = await installService(deps)
    const plist = "/home/svc/Library/LaunchAgents/dev.claxedo.connect.plist"
    expect(installed.service).toEqual({ kind: "launchd", unit: plist, installed_at: 42 })
    const text = files.get(plist)!
    expect(text).toBe(launchdPlist(deps))
    expect(text).toContain("<key>Label</key><string>dev.claxedo.connect</string>")
    expect(text).toContain("<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>")
    expect(text).toContain(
      `'/usr/local/bin/node' '/opt/claxedo/dist/index.mjs' 'connect' '--foreground'; status=$?; if [ &quot;$status&quot; -eq 78 ]; then launchctl bootout &quot;gui/$(id -u)/dev.claxedo.connect&quot;; fi; exit &quot;$status&quot;`.replace(/&quot;/g, '"'),
    )
    expect(text).not.toContain("CLAXEDO_HOME")
    expect(calls[0]).toMatch(/^launchctl bootout gui\/\d+\/dev\.claxedo\.connect$/)
    expect(calls[1]).toMatch(new RegExp(`^launchctl bootstrap gui/\\d+ ${plist}$`))
    expect(installed.lines.some((line) => line.includes("exit 78), which unloads it until the next login"))).toBe(true)

    await uninstallService(deps, undefined)
    expect(files.has(plist)).toBe(false)
  })

  test("other platforms are refused before anything is written", async () => {
    const { deps, files } = fakeDeps("win32")
    expect(() => serviceKind("win32")).toThrow("this is win32")
    await expect(installService(deps)).rejects.toThrow("supports Linux (systemd --user) and macOS (launchd)")
    expect(files.size).toBe(0)
    expect(serviceUnitPath({ platform: "linux", homedir: "/h" })).toBe("/h/.config/systemd/user/claxedo-connect.service")
  })
})
