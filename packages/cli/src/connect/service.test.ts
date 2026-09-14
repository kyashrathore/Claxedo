import { describe, expect, test } from "bun:test"
import {
  launchdPlist,
  linuxUserManager,
  serviceKind,
  serviceUnitPath,
  startService,
  systemdUnit,
  uninstallService,
  writeServiceUnit,
  type CommandResult,
  type ServiceDeps,
} from "./service"

type Box = {
  linger?: CommandResult
  runtimeDir?: string
  manager?: CommandResult
}

/** Defaults to a box whose user manager is reachable. */
function fakeDeps(platform: NodeJS.Platform, claxedoHome?: string, box: Box = {}) {
  const calls: string[] = []
  const files = new Map<string, string>()
  const deps: ServiceDeps = {
    platform,
    homedir: "/home/svc",
    username: "svc",
    command: ["/usr/local/bin/node", "/opt/claxedo/dist/index.mjs"],
    ...(claxedoHome ? { claxedoHome } : {}),
    env: { XDG_RUNTIME_DIR: box.runtimeDir ?? (Object.hasOwn(box, "runtimeDir") ? undefined : "/run/user/1000") },
    run: async (file, args) => {
      calls.push([file, ...args].join(" "))
      if (file === "loginctl") return box.linger ?? { code: 0, stdout: "yes\n" }
      if (args.includes("is-system-running")) return box.manager ?? { code: 0, stdout: "running\n" }
      return { code: 0, stdout: "" }
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
    const service = await writeServiceUnit(deps, { alongsideDesktop: false })
    const unit = "/home/svc/.config/systemd/user/claxedo-connect.service"
    expect(service).toEqual({ kind: "systemd-user", unit, installed_at: 42 })
    expect(calls, "writing the unit starts nothing").toEqual([])
    const { started, lines } = await startService(deps, service)
    expect(started).toBe(true)
    expect(files.get(unit)).toBe(systemdUnit(deps, { alongsideDesktop: false }))
    expect(systemdUnit(deps, { alongsideDesktop: true })).toContain(`"connect" "--foreground" "--alongside-desktop"`)
    expect(files.get(unit)).toContain(`ExecStart="/usr/local/bin/node" "/opt/claxedo/dist/index.mjs" "connect" "--foreground"`)
    expect(files.get(unit)).toContain("Restart=on-failure\nRestartSec=5\nRestartPreventExitStatus=78")
    expect(files.get(unit)).toContain(`Environment=CLAXEDO_HOME="/var/lib/claxedo"`)
    expect(files.get(unit)).toContain("WantedBy=default.target")
    expect(calls).toEqual([
      "loginctl show-user svc --property=Linger --value",
      "systemctl --user is-system-running",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now claxedo-connect.service",
    ])
    expect(lines[0]).toBe(`Installed and started claxedo-connect.service (${unit}).`)
    expect(lines.some((line) => line.includes("exit 78) is not retried"))).toBe(true)

    expect(await uninstallService(deps, service)).toEqual([`Stopped and removed claxedo-connect.service (${unit}).`])
    expect(files.has(unit)).toBe(false)
    expect(calls.slice(4)).toEqual(["systemctl --user disable --now claxedo-connect.service", "systemctl --user daemon-reload"])
  })

  test("a degraded user manager still counts as reachable; a failed enable surfaces as an error", async () => {
    const { deps, calls } = fakeDeps("linux", undefined, { manager: { code: 1, stdout: "degraded\n" } })
    const service = await writeServiceUnit(deps, { alongsideDesktop: false })
    expect((await startService(deps, service)).started).toBe(true)
    expect(calls).toContain("systemctl --user enable --now claxedo-connect.service")

    const failing = fakeDeps("linux")
    failing.deps.run = async (file, args) => {
      if (args.includes("enable")) return { code: 1, stdout: "" }
      return deps.run(file, args)
    }
    await expect(startService(failing.deps, service)).rejects.toThrow(
      "systemctl --user enable --now claxedo-connect.service exited with 1",
    )
  })

  describe("a Linux box without a user manager", () => {
    const unit = "/home/svc/.config/systemd/user/claxedo-connect.service"

    test("lingering off (cloud-init, no login session): unit written, nothing started, the linger command printed", async () => {
      const { deps, calls, files } = fakeDeps("linux", "/var/lib/claxedo", { linger: { code: 1, stdout: "" } })
      const service = await writeServiceUnit(deps, { alongsideDesktop: false })
      const { started, lines } = await startService(deps, service)
      expect(started).toBe(false)
      expect(files.get(unit)).toContain("RestartPreventExitStatus=78")
      expect(calls, "systemctl is never asked to start what it cannot reach").toEqual([
        "loginctl show-user svc --property=Linger --value",
      ])
      expect(lines).toEqual([
        `Wrote claxedo-connect.service (${unit}) but did not start it: lingering is off for svc, so no user manager runs outside a login session.`,
        "Run, as svc:",
        "  sudo loginctl enable-linger svc",
        "  claxedo connect --install-service",
      ])
    })

    test("loginctl answers no", async () => {
      const { deps } = fakeDeps("linux", undefined, { linger: { code: 0, stdout: "no\n" } })
      expect(await linuxUserManager(deps)).toMatchObject({ reachable: false, reason: expect.stringContaining("lingering is off") })
    })

    test("lingering on but XDG_RUNTIME_DIR unset (sudo -u without a session)", async () => {
      const { deps, calls } = fakeDeps("linux", undefined, { runtimeDir: undefined })
      const check = await linuxUserManager(deps)
      expect(check).toEqual({
        reachable: false,
        reason: "XDG_RUNTIME_DIR is unset, so systemctl --user cannot find the user manager's bus",
        remedy: ["export XDG_RUNTIME_DIR=/run/user/$(id -u svc)", "claxedo connect --install-service"],
      })
      expect(calls).toEqual(["loginctl show-user svc --property=Linger --value"])
    })

    test("a runtime dir that reaches no bus", async () => {
      const { deps } = fakeDeps("linux", undefined, { manager: { code: 1, stdout: "" } })
      const check = await linuxUserManager(deps)
      expect(check).toMatchObject({ reachable: false, reason: expect.stringContaining("reached no user manager for svc") })
      if (check.reachable) throw new Error("unreachable")
      expect(check.remedy).toEqual([
        "sudo loginctl enable-linger svc",
        "export XDG_RUNTIME_DIR=/run/user/$(id -u svc)",
        "claxedo connect --install-service",
      ])
    })
  })

  test("macOS gets a LaunchAgent whose wrapper boots the job out on exit 78", async () => {
    const { deps, calls, files } = fakeDeps("darwin")
    const service = await writeServiceUnit(deps, { alongsideDesktop: true })
    const plist = "/home/svc/Library/LaunchAgents/dev.claxedo.connect.plist"
    expect(service).toEqual({ kind: "launchd", unit: plist, installed_at: 42 })
    const { started, lines } = await startService(deps, service)
    expect(started).toBe(true)
    const text = files.get(plist)!
    expect(text).toBe(launchdPlist(deps, { alongsideDesktop: true }))
    expect(text).toContain("<key>Label</key><string>dev.claxedo.connect</string>")
    expect(text).toContain("<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>")
    expect(text).toContain(
      `'/usr/local/bin/node' '/opt/claxedo/dist/index.mjs' 'connect' '--foreground' '--alongside-desktop'; status=$?; if [ &quot;$status&quot; -eq 78 ]; then launchctl bootout &quot;gui/$(id -u)/dev.claxedo.connect&quot;; fi; exit &quot;$status&quot;`.replace(/&quot;/g, '"'),
    )
    expect(text).not.toContain("CLAXEDO_HOME")
    expect(calls[0]).toMatch(/^launchctl bootout gui\/\d+\/dev\.claxedo\.connect$/)
    expect(calls[1]).toMatch(new RegExp(`^launchctl bootstrap gui/\\d+ ${plist}$`))
    expect(lines.some((line) => line.includes("exit 78), which unloads it until the next login"))).toBe(true)

    await uninstallService(deps, undefined)
    expect(files.has(plist)).toBe(false)
  })

  test("other platforms are refused before anything is written", async () => {
    const { deps, files } = fakeDeps("win32")
    expect(() => serviceKind("win32")).toThrow("this is win32")
    await expect(writeServiceUnit(deps, { alongsideDesktop: false })).rejects.toThrow("supports Linux (systemd --user) and macOS (launchd)")
    expect(files.size).toBe(0)
    expect(serviceUnitPath({ platform: "linux", homedir: "/h" })).toBe("/h/.config/systemd/user/claxedo-connect.service")
  })
})
