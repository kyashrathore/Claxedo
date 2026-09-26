import path from "node:path"

export const harnessRoot = path.resolve(import.meta.dirname, "..")
export const appRoot = path.resolve(harnessRoot, "..")
export const repoRoot = path.resolve(harnessRoot, "../../..")
export const dataRoot = path.join(harnessRoot, "data")
export const reportsRoot = path.join(harnessRoot, "reports")

/**
 * Read a JSON file the harness itself wrote.
 *
 * `read` is what turns the parsed value into `T`. Without it this asserted
 * whatever the caller named, so a baseline written by an older schema read as
 * the current one and failed later, in a comparison, as a missing field.
 */
export async function readJson<T>(file: string, fallback: T, read: (value: unknown) => T): Promise<T> {
  if (!(await Bun.file(file).exists())) return fallback
  return read(await Bun.file(file).json())
}

export async function writeJson(file: string, value: unknown) {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
}
