import { createHash } from "node:crypto"

const LINE_BYTES = 64

export type WorkspaceLoad = {
  readonly directoryCount: number
  readonly sourceFileCount: number
  readonly sourceFileBytes: number
  readonly changedFileCount: number
  readonly diffHunksPerFile: number
  readonly diffLinesPerHunk: number
}

type Hunk = { readonly startLine: number; readonly lineCount: number }
export type WorkspaceFile = { readonly path: string; readonly byteLength: number; readonly changed: boolean; readonly hunks: readonly Hunk[] }

export function buildWorkspaceFixture(load: WorkspaceLoad, seed: string) {
  const directories = Array.from({ length: load.directoryCount }, (_, index) => `src/section-${String(index).padStart(3, "0")}`)
  const changed = new Set(
    Array.from({ length: load.sourceFileCount }, (_, index) => ({ index, score: createHash("sha256").update(`${seed}|changed|${index}`).digest("hex") }))
      .toSorted((left, right) => left.score.localeCompare(right.score))
      .slice(0, load.changedFileCount)
      .map((item) => item.index),
  )
  const files: WorkspaceFile[] = Array.from({ length: load.sourceFileCount }, (_, index) => ({
    path: `${directories[index % directories.length]}/file-${String(index).padStart(5, "0")}.ts`,
    byteLength: load.sourceFileBytes,
    changed: changed.has(index),
    hunks: changed.has(index) ? fixtureHunks(load) : [],
  }))
  return { files, changedFilePaths: files.filter((file) => file.changed).map((file) => file.path) }
}

export function generateWorkspaceFileBytes(seed: string, file: WorkspaceFile, revision: "initial" | "current") {
  const changedLines = new Set(
    file.changed && revision === "current" ? file.hunks.flatMap((hunk) => Array.from({ length: hunk.lineCount }, (_, offset) => hunk.startLine + offset)) : [],
  )
  const chunks: string[] = []
  for (let line = 0; line < Math.ceil(file.byteLength / LINE_BYTES); line += 1) {
    const phase = changedLines.has(line) ? "current" : "initial"
    const prefix = `// ${String(line).padStart(6, "0")} `
    const hash = createHash("sha256").update(`${seed}|${file.path}|${line}|${phase}`).digest("hex")
    chunks.push(`${prefix}${hash.repeat(2).slice(0, LINE_BYTES - prefix.length - 1)}\n`)
  }
  return Buffer.from(chunks.join(""), "utf8").subarray(0, file.byteLength)
}

function fixtureHunks(load: WorkspaceLoad): Hunk[] {
  const stride = Math.floor(Math.floor(load.sourceFileBytes / LINE_BYTES) / (load.diffHunksPerFile + 1))
  return Array.from({ length: load.diffHunksPerFile }, (_, index) => ({
    startLine: (index + 1) * stride - Math.floor(load.diffLinesPerHunk / 2),
    lineCount: load.diffLinesPerHunk,
  }))
}
