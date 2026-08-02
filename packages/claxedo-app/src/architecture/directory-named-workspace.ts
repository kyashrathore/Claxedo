import { walkProdSources, walkTestSources, type SourceFile } from "./scanners"

/**
 * WP-D5 lock-in scanner. The disambiguation refactor renamed the four conflation
 * identifiers that named a directory path a "workspace(Id)" (VOCABULARY.md sense
 * 1) to their honest `directory` names:
 *
 *   activeWorkspaceId      -> activeDirectory
 *   routeWorkspaceId       -> routeDirectory
 *   resolveActiveWorkspaceId -> resolveActiveDirectory
 *   shellRouteWorkspaceKey -> shellRouteDirectory
 *
 * These names must never come back: a `workspaceId`-named symbol that holds a
 * directory is exactly the sense-1/sense-2 conflation the brands (`DirectoryRef`
 * / `WorkspaceId`) exist to prevent. This guard flags any reintroduction as a
 * whole-word identifier, in prod OR test sources.
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
