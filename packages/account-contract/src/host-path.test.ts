import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  hostPathBasename,
  hostPathEqual,
  hostPathJoin,
  hostPathKind,
  hostPathParent,
  hostPathWithin,
  hostPathWithinRoots,
  normalizeHostPath,
} from "./host-path"

describe("hostPathKind", () => {
  test.each([
    ["/srv", "posix"],
    ["//server/share", "windows"],
    ["//server/share/x", "windows"],
    ["//server", "posix"],
    ["///server/share", "posix"],
    ["C:\\work", "windows"],
    ["c:/work", "windows"],
    ["\\\\server\\share", "windows"],
    ["\\\\server\\share\\app", "windows"],
    ["C:", undefined],
    ["C:work", undefined],
    ["\\\\?\\C:\\work", undefined],
    ["\\\\.\\pipe\\x", undefined],
    ["\\work", undefined],
    ["work", undefined],
    ["~/work", undefined],
    ["", undefined],
  ])("%s → %s", (input, expected) => {
    expect(hostPathKind(input)).toBe(expected as ReturnType<typeof hostPathKind>)
  })
})

describe("normalizeHostPath", () => {
  test("POSIX: collapses dot segments, repeats and trailing slashes", () => {
    expect(normalizeHostPath("/srv/api/")).toBe("/srv/api")
    expect(normalizeHostPath("/srv//api/./v1/../v2")).toBe("/srv/api/v2")
    expect(normalizeHostPath("/")).toBe("/")
    expect(normalizeHostPath("///")).toBe("/")
    expect(normalizeHostPath("/srv/..")).toBe("/")
    expect(normalizeHostPath("/../../etc")).toBe("/etc")
    expect(normalizeHostPath("/Srv/API")).toBe("/Srv/API")
  })

  test("Windows: one separator, an upper-cased drive, a volume root with its trailing backslash", () => {
    expect(normalizeHostPath("C:\\work\\is")).toBe("C:\\work\\is")
    expect(normalizeHostPath("C:/work/is")).toBe("C:\\work\\is")
    expect(normalizeHostPath("c:\\work\\is\\")).toBe("C:\\work\\is")
    expect(normalizeHostPath("C:\\work\\.\\tmp\\..\\is")).toBe("C:\\work\\is")
    expect(normalizeHostPath("C:\\work\\..\\..\\Windows")).toBe("C:\\Windows")
    expect(normalizeHostPath("C:\\")).toBe("C:\\")
    expect(normalizeHostPath("C:/")).toBe("C:\\")
    expect(normalizeHostPath("C:\\work\\..")).toBe("C:\\")
    expect(normalizeHostPath("C:\\Work\\Is")).toBe("C:\\Work\\Is")
    expect(normalizeHostPath("\\\\server\\share")).toBe("\\\\server\\share\\")
    expect(normalizeHostPath("\\\\server\\share\\app\\")).toBe("\\\\server\\share\\app")
    expect(normalizeHostPath("\\\\server\\share\\app\\..\\..\\other")).toBe("\\\\server\\share\\other")
    expect(normalizeHostPath("//server/share/app/")).toBe("\\\\server\\share\\app")
    expect(normalizeHostPath("//server")).toBe("/server")
    expect(normalizeHostPath("///server/share")).toBe("/server/share")
  })

  test("agrees with path.win32 and path.posix where they overlap", () => {
    for (const input of ["C:\\work\\is\\", "C:/work/./is", "C:\\a\\..\\b", "\\\\server\\share\\x\\..\\y"]) {
      expect(normalizeHostPath(input)).toBe(path.win32.normalize(input).replace(/(?<=[^\\])\\$/, ""))
    }
    for (const input of ["/srv/api/", "/srv//api/./v1/../v2", "/"]) {
      expect(normalizeHostPath(input)).toBe(path.posix.normalize(input).replace(/(?<=.)\/$/, ""))
    }
  })

  test("refuses relative, drive-relative, device and empty paths", () => {
    for (const input of ["", "srv/api", "./srv", "~/srv", "C:", "C:work", "\\work", "\\\\?\\C:\\work", "\\\\server"]) {
      expect(normalizeHostPath(input), input).toBeUndefined()
    }
  })
})

describe("hostPathWithin", () => {
  test.each([
    ["/srv/api", "/srv", true],
    ["/srv", "/srv", true],
    ["/srv/", "/srv", true],
    ["/srvx", "/srv", false],
    ["/srv/../etc", "/srv", false],
    ["/srv/./api/", "/srv/", true],
    ["/anything", "/", true],
    ["/SRV/api", "/srv", false],
    ["relative/api", "/srv", false],
    ["/srv/api", "srv", false],
    ["C:\\work\\is", "C:\\work", true],
    ["C:/work/is", "c:\\Work", true],
    ["C:\\WORK", "c:\\work", true],
    ["C:\\workx", "C:\\work", false],
    ["C:\\other", "C:\\work", false],
    ["C:\\work\\..\\other", "C:\\work", false],
    ["D:\\work\\is", "C:\\work", false],
    ["C:\\anything\\deep", "C:\\", true],
    ["C:\\", "C:\\", true],
    ["\\\\server\\share\\app\\x", "\\\\SERVER\\Share\\app", true],
    ["\\\\server\\share\\app", "\\\\server\\share", true],
    ["//server/share/app", "\\\\SERVER\\share", true],
    ["//server/share/app", "/server", false],
    ["\\\\server\\other\\app", "\\\\server\\share", false],
    ["C:\\work\\is", "/work", false],
    ["/work/is", "C:\\work", false],
    ["C:work", "C:\\", false],
  ])("%s within %s → %s", (inner, outer, expected) => {
    expect(hostPathWithin(inner, outer)).toBe(expected)
  })

  test("any of several roots, of either kind", () => {
    const roots = ["/srv", "C:\\work"]
    expect(hostPathWithinRoots("/srv/api", roots)).toBe(true)
    expect(hostPathWithinRoots("c:\\work\\is", roots)).toBe(true)
    expect(hostPathWithinRoots("/home", roots)).toBe(false)
    expect(hostPathWithinRoots("C:\\other", roots)).toBe(false)
    expect(hostPathWithinRoots("/srv", [])).toBe(false)
  })
})

describe("hostPathEqual", () => {
  test("case-insensitive for Windows paths only", () => {
    expect(hostPathEqual("C:\\Work", "c:\\work")).toBe(true)
    expect(hostPathEqual("C:\\Work", "C:\\Work\\is")).toBe(false)
    expect(hostPathEqual("/Srv", "/srv")).toBe(false)
    expect(hostPathEqual("/srv", "/srv")).toBe(true)
    expect(hostPathEqual("/srv", "C:\\srv")).toBe(false)
  })
})

describe("parent, join and basename", () => {
  test("walk up to the volume root and stop", () => {
    expect(hostPathParent("/srv/api")).toBe("/srv")
    expect(hostPathParent("/srv")).toBe("/")
    expect(hostPathParent("/")).toBeUndefined()
    expect(hostPathParent("C:\\work\\is")).toBe("C:\\work")
    expect(hostPathParent("C:\\work")).toBe("C:\\")
    expect(hostPathParent("C:\\")).toBeUndefined()
    expect(hostPathParent("\\\\server\\share\\app\\x")).toBe("\\\\server\\share\\app")
    expect(hostPathParent("\\\\server\\share\\app")).toBe("\\\\server\\share\\")
    expect(hostPathParent("\\\\server\\share\\")).toBeUndefined()
    expect(hostPathParent("relative")).toBeUndefined()
  })

  test("join appends in the base's own separator and normalizes", () => {
    expect(hostPathJoin("/private/data", ["new", "deeper"])).toBe("/private/data/new/deeper")
    expect(hostPathJoin("/", ["srv"])).toBe("/srv")
    expect(hostPathJoin("C:\\real", ["new", "deeper"])).toBe("C:\\real\\new\\deeper")
    expect(hostPathJoin("C:\\", ["work"])).toBe("C:\\work")
    expect(hostPathJoin("\\\\server\\share\\", ["app"])).toBe("\\\\server\\share\\app")
    expect(hostPathJoin("C:\\real", [])).toBe("C:\\real")
    expect(hostPathJoin("relative", ["x"])).toBeUndefined()
    expect(hostPathJoin("C:\\real", ["new"])).toBe(path.win32.join("C:\\real", "new"))
  })

  test("basename is the last segment, empty at a volume root", () => {
    expect(hostPathBasename("/srv/api")).toBe("api")
    expect(hostPathBasename("/")).toBe("")
    expect(hostPathBasename("C:\\work\\is")).toBe("is")
    expect(hostPathBasename("C:\\")).toBe("")
    expect(hostPathBasename("\\\\server\\share\\app")).toBe("app")
    expect(hostPathBasename("relative")).toBe("")
    expect(hostPathBasename("C:\\work\\is")).toBe(path.win32.basename("C:\\work\\is"))
  })
})
