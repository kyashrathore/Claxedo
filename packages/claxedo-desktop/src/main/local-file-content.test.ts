import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { desktopPrivateLocations, readLocalFileContent, type PrivateLocations } from "./local-file-content"

let directory: string
let locations: PrivateLocations
let credentialsFile: string
let userData: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "local-file-content-"))
  const home = path.join(directory, "claxedo-home")
  userData = path.join(directory, "user-data")
  await mkdir(home)
  await mkdir(userData)
  locations = desktopPrivateLocations(userData, { CLAXEDO_HOME: home })
  credentialsFile = locations.credentialsFile
  await writeFile(credentialsFile, JSON.stringify({ accessToken: "at", refreshToken: "rt" }))
  await writeFile(path.join(home, ".credentials.json.42.0b1c.tmp"), "rt")
  await writeFile(path.join(home, "workspace-notes.md"), "Public.")
  await writeFile(path.join(userData, "claxedo.settings.json"), "{}")
  await mkdir(path.join(userData, "Logs"))
  await writeFile(path.join(userData, "Logs", "main.log"), "log")
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

test("a local document and image use the canonical file-content contract", async () => {
  const document = path.join(directory, "verification details.md")
  await writeFile(document, "Verified artifact.\n")
  expect(await readLocalFileContent(document, locations)).toEqual({ type: "text", content: "Verified artifact." })
  const image = path.join(directory, "preview.png")
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
  await writeFile(image, bytes)
  expect(await readLocalFileContent(image, locations)).toEqual({ type: "binary", content: bytes.toString("base64"), encoding: "base64", mimeType: "image/png" })
})

test("relative paths, traversal and directories are refused", async () => {
  await expect(readLocalFileContent("README.md", locations)).rejects.toThrow("not absolute")
  await expect(readLocalFileContent(path.join(directory, "folder") + "/../secret.txt", locations)).rejects.toThrow("leaves the directory")
  await expect(readLocalFileContent(directory, locations)).rejects.toThrow("not a file")
})

test("a missing artifact is reported as missing and can be read once restored", async () => {
  const document = path.join(directory, "restored.md")
  await expect(readLocalFileContent(document, locations)).rejects.toThrow("does not exist")
  await writeFile(document, "Restored")
  expect(await readLocalFileContent(document, locations)).toEqual({ type: "text", content: "Restored" })
})

describe("locations private to the desktop", () => {
  test("the CLI credential file and its staging files are refused", async () => {
    await expect(readLocalFileContent(credentialsFile, locations)).rejects.toThrow("private to the desktop")
    await expect(readLocalFileContent(path.join(path.dirname(credentialsFile), ".credentials.json.42.0b1c.tmp"), locations)).rejects.toThrow("private to the desktop")
  })

  test("everything under Electron's userData directory is refused", async () => {
    await expect(readLocalFileContent(path.join(userData, "claxedo.settings.json"), locations)).rejects.toThrow("private to the desktop")
    await expect(readLocalFileContent(path.join(userData, "Logs", "main.log"), locations)).rejects.toThrow("private to the desktop")
  })

  test("a symlink, a symlinked parent or a hard link cannot stand in for a private file", async () => {
    const linked = path.join(directory, "notes.md")
    await symlink(credentialsFile, linked)
    await expect(readLocalFileContent(linked, locations)).rejects.toThrow("private to the desktop")

    const linkedParent = path.join(directory, "linked-user-data")
    await symlink(userData, linkedParent)
    await expect(readLocalFileContent(path.join(linkedParent, "claxedo.settings.json"), locations)).rejects.toThrow("private to the desktop")

    const hardLinked = path.join(directory, "copy.json")
    await link(credentialsFile, hardLinked)
    await expect(readLocalFileContent(hardLinked, locations)).rejects.toThrow("private to the desktop")
  })

  test("other files beside the credential file stay readable", async () => {
    expect(await readLocalFileContent(path.join(path.dirname(credentialsFile), "workspace-notes.md"), locations)).toEqual({ type: "text", content: "Public." })
  })

  test("on case-insensitive platforms a recased spelling is refused too", async () => {
    // The verdict reads the path's shape by platform, so a Windows path is judged as win32, itself case-insensitive.
    const caseInsensitive: NodeJS.Platform = process.platform === "win32" ? "win32" : "darwin"
    const recased = path.join(path.dirname(credentialsFile), "CREDENTIALS.JSON")
    await expect(readLocalFileContent(recased, locations, caseInsensitive)).rejects.toThrow("private to the desktop")
    const recasedLocations = { ...locations, directories: [userData.toUpperCase()] }
    await expect(readLocalFileContent(path.join(userData, "Logs", "main.log"), recasedLocations, caseInsensitive)).rejects.toThrow("private to the desktop")
  })
})
