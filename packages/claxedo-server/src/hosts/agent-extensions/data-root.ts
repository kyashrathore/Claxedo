import { dataDir } from "../../lib/paths"

/**
 * Default `dataRoot` to the server's data dir.
 *
 * The @claxedo/agent-extensions package takes an explicit `dataRoot` rather
 * than reading env itself (the kit stays host-agnostic); supplying the default
 * is this host's job. Both wrapper modules in this directory need it, and each
 * had its own byte-identical private copy before this file.
 */
export function withDataRoot<T extends { dataRoot?: string }>(input: T): T & { dataRoot: string } {
  return {
    ...input,
    dataRoot: input.dataRoot ?? dataDir(),
  }
}
