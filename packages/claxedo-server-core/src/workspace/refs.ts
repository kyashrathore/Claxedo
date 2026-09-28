import { trimToUndefined } from "@claxedo/helpers/string"

/** The id a `workspace:<id>` reference names; a client sends one in place of a directory it cannot show. */
export function workspaceIdFromWorkspaceRef(input: string | undefined) {
  const reference = trimToUndefined(input)
  return reference?.startsWith("workspace:") ? trimToUndefined(reference.slice("workspace:".length)) : undefined
}
