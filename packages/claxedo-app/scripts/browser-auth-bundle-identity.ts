import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { BrowserAuthAdapterId } from "../src/platform/auth/browser-auth"

export type BrowserAuthBundleFile = { path: string; content: string }

export function browserAuthBundleFailures(selected: BrowserAuthAdapterId, files: readonly BrowserAuthBundleFile[]) {
  const other = selected === "better-auth" ? "clerk" : "better-auth"
  const all = files.map((file) => `${file.path}\n${file.content}`).join("\n")
  const failures: string[] = []
  if (!all.includes(`claxedo-browser-auth:${selected}`))
    failures.push(`missing selected ${selected} implementation marker`)
  if (all.includes(`claxedo-browser-auth:${other}`)) failures.push(`contains unselected ${other} implementation`)
  if (!files.some((file) => file.path.includes(`vendor-${selected}`)))
    failures.push(`missing selected vendor-${selected} chunk`)
  if (files.some((file) => file.path.includes(`vendor-${other}`)))
    failures.push(`contains unselected vendor-${other} chunk`)
  if (all.includes("test-bypass-token")) failures.push("contains the test-only browser auth bypass")
  return failures
}

function filesBelow(directory: string): BrowserAuthBundleFile[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".html")))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return { path: path.relative(directory, file), content: readFileSync(file, "utf8") }
    })
}

if (import.meta.main) {
  const selected = process.argv[2]
  const directory = process.argv[3]
  if ((selected !== "better-auth" && selected !== "clerk") || !directory || !existsSync(directory)) {
    throw new Error("usage: browser-auth-bundle-identity.ts <better-auth|clerk> <build-directory>")
  }
  const failures = browserAuthBundleFailures(selected, filesBelow(path.resolve(directory)))
  if (failures.length) throw new Error(`browser auth bundle closure failed:\n- ${failures.join("\n- ")}`)
  console.log(`${selected} browser auth bundle closure passed`)
}
