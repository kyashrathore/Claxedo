import { callDocuments, DocumentToolError } from "./documents-tools"

type Request = <Result>(requestPath: string, init?: RequestInit) => Promise<Result>

type IO = {
  stdout(value: string): void
  stderr(value: string): void
}

const usage = [
  "claxedo-mcp documents list [--directory <path> | --project <id>]",
  "claxedo-mcp documents open <claxedo://document/id | id | name> [--session <id>] [--directory <path> | --project <id>]",
].join("\n")

export async function runDocumentsCli(
  argv: string[],
  request: Request,
  io: IO,
  defaults?: { directory?: string; sessionId?: string },
) {
  try {
    const [command, ...args] = argv
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(usage)
      return 0
    }
    const flags = parseFlags(args)
    const scope = flags.project
      ? { project_id: flags.project }
      : { directory: flags.directory ?? defaults?.directory }
    if (command === "list") {
      io.stdout((await callDocuments(request, "documents_list", scope)).content[0]!.text)
      return 0
    }
    if (command !== "open") throw new Error(`Unknown documents command '${command}'`)
    const reference = flags.positionals[0]
    if (!reference) throw new Error("documents open requires a document reference")
    const sessionId = flags.session ?? defaults?.sessionId
    if (!sessionId) throw new Error("documents open requires --session <id> or CLAXEDO_SESSION_ID")
    io.stdout((await callDocuments(request, "documents_open", {
      ...scope,
      id_or_name: reference,
      session_id: sessionId,
    })).content[0]!.text)
    return 0
  } catch (error) {
    io.stderr(error instanceof DocumentToolError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error))
    io.stderr(usage)
    return 1
  }
}

function parseFlags(args: string[]) {
  const values = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
    values.set(arg, value)
    index += 1
  }
  if (values.has("--directory") && values.has("--project")) {
    throw new Error("Use --directory or --project, not both")
  }
  return {
    positionals,
    directory: values.get("--directory"),
    project: values.get("--project"),
    session: values.get("--session") ?? values.get("--session-id"),
  }
}
