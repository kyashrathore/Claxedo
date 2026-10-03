import { expect, test } from "vitest"
import { backupIds, captureDirectories, deleteBackups, directoryRestore } from "./directory-backups"

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"

test("a capture set is distinct absolute directories, none inside another, kept in order", () => {
  expect(captureDirectories(["/workspace", "/home/claxedo"])).toEqual(["/workspace", "/home/claxedo"])
  for (const invalid of [[], ["/"], ["relative"], ["/a/../etc"], ["/a", "/a"], ["/a", "/a/b"], ["/a/"], [1], "/a"]) {
    expect(captureDirectories(invalid)).toBeUndefined()
  }
})

test("a restore pairs each backup id with its directory and refuses a count mismatch or a foreign id", () => {
  expect(directoryRestore({ backupId: `${A},${B}`, directories: ["/workspace", "/home/claxedo"] }))
    .toEqual([{ id: A, dir: "/workspace" }, { id: B, dir: "/home/claxedo" }])
  expect(directoryRestore({ backupId: A, directories: ["/workspace", "/home/claxedo"] })).toBeUndefined()
  expect(backupIds("../meta")).toBeUndefined()
})

test("deleting a checkpoint removes the archive and metadata of every backup it names", async () => {
  const deleted: string[] = []
  await deleteBackups({ delete: async (key) => { deleted.push(key) } }, [A, B])
  expect(deleted.sort()).toEqual([`backups/${A}/data.sqsh`, `backups/${A}/meta.json`, `backups/${B}/data.sqsh`, `backups/${B}/meta.json`])
})
