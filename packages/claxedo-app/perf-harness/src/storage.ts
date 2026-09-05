import path from "node:path"

export const harnessRoot = path.resolve(import.meta.dirname, "..")
export const appRoot = path.resolve(harnessRoot, "..")
export const repoRoot = path.resolve(harnessRoot, "../../..")
export const dataRoot = path.join(harnessRoot, "data")
export const reportsRoot = path.join(harnessRoot, "reports")

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!(await Bun.file(file).exists())) return fallback
  return Bun.file(file).json() as Promise<T>
}

export async function writeJson(file: string, value: unknown) {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
}
