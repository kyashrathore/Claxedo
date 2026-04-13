import path from "path"

export function shell(input: string) {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`
}

export function file(...parts: string[]) {
  return shell(path.posix.join(...parts))
}

export function env(input: Record<string, string>) {
  return Object.entries(input)
    .map(([k, v]) => `export ${k}=${shell(v)}`)
    .join(" && ")
}
