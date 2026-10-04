import fs from "node:fs"

import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"

type DependencySection = "dependencies" | "peerDependencies" | "optionalDependencies" | "devDependencies"

export type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  scripts?: Record<string, string>
} & Partial<Record<DependencySection, Record<string, string>>>

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

/**
 * Every field is preserved, because the publisher writes a manifest with
 * materialized pins back over the original before packing — dropping
 * `exports`, `files` or `engines` on the way through would publish a broken
 * package. Only the fields the publisher reads are given a type; the rest ride
 * along as the `unknown` they are.
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
