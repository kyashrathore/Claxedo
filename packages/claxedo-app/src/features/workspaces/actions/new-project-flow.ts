/**
 * Which flow New Project opens, from two facts about the server.
 *
 * The server's mode decides the product, not the client's platform or URL:
 *
 * - A server that runs workspaces on its own filesystem (the self-host
 *   binary, which is also the desktop's server) makes "a folder on this
 *   machine" a project there, signed in or not — in a browser tab exactly as
 *   in the desktop.
 * - A signed server adds cloud projects: the hosted plane, or the self-host
 *   binary with accounts on (on a VM, or on a laptop for development).
 *
 * Both → the user chooses. One → that flow opens directly. A server that
 * reports nothing about its filesystem (an older build, or a failed health
 * read) is taken as the local product when unsigned and the hosted product
 * when signed, which is what those two have always been.
 */
export type NewProjectFlow = "folder" | "cloud" | "choose"

export function newProjectFlow(input: { localExecution: boolean | undefined; signed: boolean }): NewProjectFlow {
  const folder = input.localExecution ?? !input.signed
  if (folder && input.signed) return "choose"
  return folder ? "folder" : "cloud"
}
