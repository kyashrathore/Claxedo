import fs from "node:fs/promises"
import path from "node:path"

export function object(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

export function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function number(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

export function boolean(input: unknown) {
  return typeof input === "boolean" ? input : undefined
}

export async function readJsonFile(pathname: string) {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf8")) as unknown
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  }
}

export async function writePrivateJson(pathname: string, value: unknown) {
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 })
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(pathname, 0o600)
}

export function errorMessage(input: unknown) {
  return input instanceof Error ? input.message : String(input)
}
