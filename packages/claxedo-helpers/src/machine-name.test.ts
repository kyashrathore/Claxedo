import { describe, expect, test } from "bun:test"
import { machineDisplayName, systemMachineNameSources } from "./machine-name"

function sources(computerName?: string, accountName?: string) {
  return { computerName: () => computerName, accountName: () => accountName }
}

describe("machineDisplayName", () => {
  test("a default macOS computer name reads back as the possessive the OS squashed", () => {
    expect(machineDisplayName("darwin", sources("Yashvardhans-MacBook-Pro-3.local", "yashvardhansingh")))
      .toBe("Yashvardhan's MacBook Pro 3")
  })

  test("the account's given name is enough to restore the possessive", () => {
    expect(machineDisplayName("darwin", sources("Anns-iMac.local", "ann.hughes"))).toBe("Ann's iMac")
  })

  test("the OS full name restores a possessive a shortened login could not", () => {
    expect(machineDisplayName("darwin", sources("Yashvardhans-MacBook-Pro", "Yashvardhan Singh")))
      .toBe("Yashvardhan's MacBook Pro")
    expect(machineDisplayName("darwin", sources("Bobs-MacBook-Air", "Bob Smith"))).toBe("Bob's MacBook Air")
  })

  test("an account that never named this machine leaves its name alone", () => {
    expect(machineDisplayName("darwin", sources("Bobs-MacBook-Air", "Robert Tanner"))).toBe("Bobs MacBook Air")
  })

  test("a name whose tail is not an Apple model keeps its s, however well the account matches", () => {
    expect(machineDisplayName("darwin", sources("Docs-Server", "docsadmin"))).toBe("Docs Server")
    expect(machineDisplayName("linux", sources("Docs-Server", "docsadmin"))).toBe("Docs Server")
    expect(machineDisplayName("linux", sources("news-box", "newton"))).toBe("news box")
    expect(machineDisplayName("linux", sources("jobs-runner", "jobsmith"))).toBe("jobs runner")
  })

  test("a computer the user named themselves is shown as they named it", () => {
    expect(machineDisplayName("linux", sources("build-box", "ci"))).toBe("build box")
    expect(machineDisplayName("win32", sources("STUDIO-PC", "renee"))).toBe("STUDIO PC")
  })

  test("a first word ending in s that has nothing to do with the account keeps its s", () => {
    expect(machineDisplayName("linux", sources("metrics-01", "deploy"))).toBe("metrics 01")
  })

  test("an address is not a name, so the account names the machine instead", () => {
    expect(machineDisplayName("linux", sources("192.168.1.5", "root"))).toBe("Root's Linux machine")
    expect(machineDisplayName("darwin", sources("fe80::1c2d", "Ada Lovelace"))).toBe("Ada's Mac")
    expect(machineDisplayName("linux", sources("10-build-box", "ci"))).toBe("Ci's Linux machine")
  })

  test("with no readable computer name the account names the machine with a platform word", () => {
    expect(machineDisplayName("darwin", sources(undefined, "yashvardhan"))).toBe("Yashvardhan's Mac")
    expect(machineDisplayName("win32", sources("", "renee"))).toBe("Renee's PC")
    expect(machineDisplayName("linux", sources("localhost.localdomain", "sam"))).toBe("Sam's Linux machine")
  })

  test("with neither readable the platform word stands alone, and an unknown platform says machine", () => {
    expect(machineDisplayName("darwin", sources(undefined, undefined))).toBe("Mac")
    expect(machineDisplayName("freebsd", sources(undefined, undefined))).toBe("machine")
  })

  test("the real OS readers name this machine without help", () => {
    expect(machineDisplayName(process.platform, systemMachineNameSources).trim()).not.toBe("")
  })

  test("the name fits the enrollment route's 120-character limit", () => {
    const long = `${"a".repeat(200)}-box`
    expect(machineDisplayName("linux", sources(long, "someone")).length).toBe(120)
  })
})
