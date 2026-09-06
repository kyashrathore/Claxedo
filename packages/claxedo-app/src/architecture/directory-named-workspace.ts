import { walkProdSources, walkTestSources, type SourceFile } from "./scanners"

/**
 * Retired identifiers that named a directory path a "workspace(Id)" (see
 * VOCABULARY.md), now `activeDirectory`, `routeDirectory`,
 * `resolveActiveDirectory`, `shellRouteDirectory`. A `workspaceId`-named symbol
 * holding a directory is the conflation the `DirectoryRef` / `WorkspaceId`
 * brands exist to prevent, so these may not reappear as whole-word identifiers
 * in prod or test sources.
 */
const RETIRED_CONFLATION_NAMES = [
  "activeWorkspaceId",
  "routeWorkspaceId",
  "resolveActiveWorkspaceId",
  "shellRouteWorkspaceKey",
] as const

const PATTERN = new RegExp(`\\b(?:${RETIRED_CONFLATION_NAMES.join("|")})\\b`)

/** Files (from a caller-provided list) that reference a retired conflation name, sorted. */
export function scanForDirectoryNamedWorkspace(files: SourceFile[]) {
  return files
    .filter((file) => PATTERN.test(file.text))
    .map((file) => file.path)
    .sort()
}

/** Every production or test file in the live tree that reintroduces a retired conflation name. */
export function directoryNamedWorkspaceOffenders(appRoot: string) {
  return scanForDirectoryNamedWorkspace([...walkProdSources(appRoot), ...walkTestSources(appRoot)])
}
