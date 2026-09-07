import { claxedoDocumentReferenceId } from "@claxedo/helpers/claxedo-document"
import { config, url } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { requireAccessToken } from "../auth/token-store"

export const documentsUsage = [
  "claxedo documents list [--project <id> | --directory <path>]",
  "claxedo documents open <claxedo://document/id | id | name> [--session <id>] [--project <id> | --directory <path>]",
].join("\n")

type Flags = { positionals: string[]; project?: string; directory?: string; session?: string }

export async function documents(argv: string[]) {
  const [command, ...args] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(documentsUsage)
    return
  }
  const flags = parseFlags(args)
  const scope = documentIndexQuery(flags)
  const token = await requireAccessToken()

  if (command === "list") {
    console.log(JSON.stringify(await readDocumentIndex(token, scope, "active"), null, 2))
    return
  }
  if (command !== "open") throw new Error(`Unknown documents command '${command}'`)

  const reference = flags.positionals[0]
  if (!reference) throw new Error("documents open needs a document reference")
  const sessionId = flags.session ?? process.env.CLAXEDO_SESSION_ID?.trim()
  if (!sessionId) throw new Error("documents open needs --session <id> or CLAXEDO_SESSION_ID")

  const wanted = claxedoDocumentReferenceId(reference)
  const documentId = resolveDocumentId(await readDocumentIndex(token, scope, "all"), wanted)
  const opened = object(
    await requestJson({
      url: url(config().controlPlaneUrl, `/documents/${encodeURIComponent(documentId)}/agent-open`),
      method: "POST",
      token,
      body: { session_id: sessionId },
    }),
  )
  if (typeof opened.path !== "string") throw new Error("The documents service opened the document without a path")
  console.log(opened.path)
}

/** The scope the documents index takes; without either flag it is this directory. */
function documentIndexQuery(flags: Flags): Record<string, string> {
  if (flags.project && flags.directory) throw new Error("Use --project or --directory, not both")
  return flags.project ? { project_id: flags.project } : { directory: flags.directory ?? process.cwd() }
}

async function readDocumentIndex(token: string, scope: Record<string, string>, archived: "active" | "all") {
  const query = new URLSearchParams({ ...scope, archived })
  const listed = await requestJson({ url: url(config().controlPlaneUrl, `/documents?${query}`), token })
  if (!Array.isArray(listed)) throw new Error("The documents index did not answer with a list of documents")
  return listed.map((row: unknown) => object(row))
}

function resolveDocumentId(rows: readonly Record<string, unknown>[], reference: string) {
  const exact = rows.find((row) => row.id === reference)
  const matches = exact
    ? [exact]
    : rows.filter((row) => typeof row.display_name === "string" && row.display_name.toLocaleLowerCase() === reference.toLocaleLowerCase())
  if (matches.length === 0) throw new Error(`No document '${reference}' is in this project`)
  if (matches.length > 1) throw new Error(`More than one document is named '${reference}'; open it by id`)
  if (matches[0].archived_at) throw new Error(`Document '${reference}' is archived`)
  const id = matches[0].id
  if (typeof id !== "string") throw new Error("The documents index answered with an entry that has no id")
  return id
}

function parseFlags(args: string[]): Flags {
  const values = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`)
    values.set(arg, value)
    index += 1
  }
  return {
    positionals,
    ...(values.has("--project") ? { project: values.get("--project") } : {}),
    ...(values.has("--directory") ? { directory: values.get("--directory") } : {}),
    ...(values.has("--session") ? { session: values.get("--session") } : {}),
  }
}
