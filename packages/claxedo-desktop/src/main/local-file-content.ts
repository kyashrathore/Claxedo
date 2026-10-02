import { stat } from "node:fs/promises"
import { readFileContent } from "@claxedo/workspace-runtime/file-content"
import { openInPathVerdict } from "./open-in-guard"

export async function readLocalFileContent(path: string) {
  const verdict = openInPathVerdict(path, process.platform)
  if (!verdict.allowed) throw new Error(verdict.reason)
  if (!(await stat(path)).isFile()) throw new Error("The path is not a file.")
  return readFileContent(path)
}
