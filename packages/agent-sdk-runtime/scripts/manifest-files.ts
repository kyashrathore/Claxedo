import fs from "fs"
import path from "path"

/**
 * Readers for the package's own metadata files.
 *
 * Every publish script parses the same two JSON files. They are read once here
 * and validated, so a malformed manifest fails at the read with the file named
 * rather than as a confusing failure further down a script.
 */
export type PackageJson = {
  name: string
  version: string
  files?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  exports: Record<string, Record<string, string>>
}

export type ApiManifest = {
  package: string
  version: string
  entrypoints: Record<string, unknown>
  valueExports: Record<string, string[]>
  declarationHashes: Record<string, string>
  symbols: Record<string, { import: string; kind: string; purpose: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`)
  return parsed
}

function requireString(row: Record<string, unknown>, key: string, file: string): string {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`${file} is missing a string ${key}`)
  return value
}

function requireRecord(row: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const value = row[key]
  if (!isRecord(value)) throw new Error(`${file} is missing an object ${key}`)
  return value
}

function stringMapMap(row: Record<string, unknown>): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]) =>
      isRecord(value) ? [[key, stringMap(value)]] : []),
  )
}

function stringMap(row: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function stringListMap(row: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    ]),
  )
}

export function readPackageJson(root: string): PackageJson {
  const file = path.join(root, "package.json")
  const row = readJson(file)
  const files = row.files
  return {
    name: requireString(row, "name", file),
    version: requireString(row, "version", file),
    ...(Array.isArray(files) ? { files: files.filter((item): item is string => typeof item === "string") } : {}),
    ...(row.dependencies ? { dependencies: stringMap(requireRecord(row, "dependencies", file)) } : {}),
    ...(row.optionalDependencies ? { optionalDependencies: stringMap(requireRecord(row, "optionalDependencies", file)) } : {}),
    ...(row.peerDependencies ? { peerDependencies: stringMap(requireRecord(row, "peerDependencies", file)) } : {}),
    exports: stringMapMap(requireRecord(row, "exports", file)),
  }
}

export function readApiManifest(root: string): ApiManifest {
  const file = path.join(root, "docs/api-manifest.json")
  const row = readJson(file)
  const symbols = row.symbols ? requireRecord(row, "symbols", file) : {}
  return {
    package: requireString(row, "package", file),
    version: requireString(row, "version", file),
    entrypoints: requireRecord(row, "entrypoints", file),
    valueExports: row.valueExports ? stringListMap(requireRecord(row, "valueExports", file)) : {},
    declarationHashes: row.declarationHashes ? stringMap(requireRecord(row, "declarationHashes", file)) : {},
    symbols: Object.fromEntries(Object.entries(symbols).flatMap(([name, value]) => {
      if (!isRecord(value)) return []
      const { import: from, kind, purpose } = value
      return typeof from === "string" && typeof kind === "string" && typeof purpose === "string"
        ? [[name, { import: from, kind, purpose }]]
        : []
    })),
  }
}
