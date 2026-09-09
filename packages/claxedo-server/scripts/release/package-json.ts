import fs from "node:fs"

import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"

/**
 * The `package.json` shape both publishers read, and the reader that produces it.
 *
 * `publish-claxedo-packages.ts` and `publish-runtime-packages.ts` each declared
 * their own `PackageJson`, their own `CommandRunner`, and their own
 * `readPackageJson` that asserted `JSON.parse(...) as PackageJson`. The two
 * types listed the same four dependency sections in a different order and
 * disagreed on `private`, so a field one publisher relied on was invisible to
 * the other.
 */
export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number]

export type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  scripts?: Record<string, string>
} & Partial<Record<DependencySection, Record<string, string>>>

export type CommandRunner = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => string

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

/**
 * Every field is preserved, because `publish-runtime-packages.ts` reads a
 * manifest, rewrites its versions, and writes it back — dropping `exports`,
 * `files` or `engines` on the way through would publish a broken package. Only
 * the fields the publishers actually read are given a type; the rest ride along
 * as the `unknown` they are.
 */
export function readPackageJson(file: string): PackageJson {
  const parsed = asRecord(parseJson(fs.readFileSync(file, "utf8")))
  if (!parsed) throw new Error(`${file} is not a JSON object`)
  const {
    name, version, private: isPrivate, scripts,
    dependencies, peerDependencies, optionalDependencies, devDependencies,
    ...rest
  } = parsed
  const scriptMap = stringMap(scripts)
  const deps = stringMap(dependencies)
  const peers = stringMap(peerDependencies)
  const optionals = stringMap(optionalDependencies)
  const devs = stringMap(devDependencies)
  return {
    ...rest,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof isPrivate === "boolean" ? { private: isPrivate } : {}),
    ...(scriptMap ? { scripts: scriptMap } : {}),
    ...(deps ? { dependencies: deps } : {}),
    ...(peers ? { peerDependencies: peers } : {}),
    ...(optionals ? { optionalDependencies: optionals } : {}),
    ...(devs ? { devDependencies: devs } : {}),
  }
}

export function writePackageJson(file: string, pkg: PackageJson) {
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
