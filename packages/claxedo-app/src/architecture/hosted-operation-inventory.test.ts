import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { HOSTED_OPERATIONS } from "../platform/account/hosted-operations"

const srcRoot = path.resolve(import.meta.dir, "..")

/**
 * Hosted-operation inventory gate.
 *
 * A signed desktop may only make the closed set of authenticated calls in
 * `HOSTED_OPERATIONS`. A module that reaches authenticated transport without
 * going through that set would silently widen the desktop's IPC surface, or
 * silently lose its capability on desktop, with a green build either way.
 *
 * This scans the hosted-contribution candidate modules for authenticated
 * transport and requires every module it finds to be declared: either as the
 * owner of named hosted operations, or as a module whose authenticated calls
 * never reach Hosted Server's account surface. Every declaration must still
 * exist and still be authenticated, so retired entries do not pile up unread.
 *
 * It deliberately does NOT try to resolve URLs statically. Paths here are built
 * through helpers (`documentsUrl({ id, path })`, `url("/commands")`), so a
 * regex that claimed to extract them would report a confident subset and miss
 * the rest — worse than not checking, because it would look like coverage.
 */

/** Hosted feature roots scanned for authenticated transport. */
const HOSTED_CANDIDATE_ROOTS = [
  "features/documents",
  "platform/runtime/cloud",
  "features/workspaces",
  "features/settings",
  "features/onboarding",
  "app/routes",
]

/**
 * Modules that reach Hosted Server through named operations, and the
 * operations each one names. On desktop these calls cross the account port by
 * name; in the browser the same module calls the route directly.
 */
const HOSTED_OPERATION_OWNERS: Record<string, readonly string[]> = {
  "features/documents/data/documents-api.ts": [
    "documents.list",
    "documents.get",
    "documents.create",
    "documents.content.get",
    "documents.content.put",
    "documents.export",
    "documents.agentOpen",
    "documents.runtimeConflictResolve",
    "documents.moveToRepository",
    "documents.fromRepo",
    "documents.snapshots",
    "documents.snapshots.restore",
    "documents.statuses",
  ],
  "features/settings/data/org-team-api.ts": [
    "org.list",
    "org.create",
    "org.teams.list",
    "org.teams.create",
    "org.ensureDefaultTeam",
    "team.members.list",
    "team.members.add",
    "team.members.remove",
    "team.projects.grant",
  ],
  "features/workspaces/actions/project-actions.tsx": ["workspace.resolve"],
  "features/workspaces/data/workspace-catalog.ts": ["workspace.list.provisioner", "workspace.list.machine"],
  "features/workspaces/data/workspace-create-api.ts": ["workspace.create"],
}

/**
 * Modules that reach authenticated transport but stay in `@claxedo/app`.
 *
 * Each needs a reason, because "it is exempt" is how an inventory rots: the
 * reason names the local route the module actually calls.
 */
const LOCAL_AUTHENTICATED_MODULES: Record<string, string> = {
  "app/routes/bootstrap-owner.tsx":
    "The one-time user-deployed owner claim sends a transient password to `POST /api/claxedo/auth/bootstrap-owner` on the browser's own signed session. Desktop is not an owner-provisioning surface, and Electron main must never receive or retain this one-use secret, so it is deliberately not an AccountPort operation.",
  "platform/runtime/cloud/workspace-runtime-store.ts":
    "Default request for `createTransport` Workspace Runtime calls (`/api/wr/health`, `/api/wr/worktrees`) over the relay or loopback. Workspace Runtime traffic is data plane and never crosses the account port.",
  "app/routes/directory-layout.tsx":
    "Local route shell: resolves a directory route against the local server's `workspaceResolveUrl` through `platform.fetch` (authFetch only when the platform injects no transport); never calls Hosted Server.",
  "features/workspaces/ui/panel/workspace-panel.tsx":
    "Workspace panel: `hostedControlCall` runs the injected hosted operation when the account bridge is signed and otherwise its `api` calls against the attached server's own checkpoint and lifecycle routes at `getDefaultBaseUrl()`; neither is a Hosted Server AccountPort surface.",
  "features/workspaces/data/project-api.ts":
    "Projects live on servers with a filesystem (`/api/claxedo/projects` on the local and self-hosted servers); the hosted plane has no such route, so this is not a Hosted Server AccountPort surface.",
  "app/integrations/settings/settings-sections-registry.tsx":
    "The section registry reads the local server's harness-connection catalog (`createHarnessConnectionsCatalog` on `getClaxedoServerUrl()`) to decide whether the Connections section exists; every hosted account operation belongs to the section it renders, not to the registry.",
  "features/settings/ui/harness-providers-section.tsx":
    "Local provider settings. Credential list/disconnect uses local-server credential routes via claxedoCredentialRequest, and the harness auth entry is dropped through the local server's own `/auth/:providerId`; hosted account identity stays on account-section.",
  "features/settings/ui/sandbox-section.tsx":
    "Sandbox driver settings talk only to the local sidecar `/api/workspace/drivers*`; not a Hosted Server AccountPort surface.",
  "features/onboarding/sandbox-provider-api.ts":
    "Onboarding sandbox write path is local-sidecar drivers; Hosted Server does not own these credentials.",
  "features/settings/data/connected-apps-api.ts":
    "Connected applications read and revoke OAuth consents at the authorization server's own `/api/auth/oauth2/*` endpoints, which authenticate a BROWSER session (cookie, or the bearer plugin's session token). The desktop's AccountPort credential is an OAuth access token for the control-plane resource, which those endpoints do not accept, so this is not a Hosted Server AccountPort surface.",
  "features/workspaces/data/share-workspace.ts":
    "Desktop sharing goes through the machine remote-access port (Host Connector owns the machine key — the `workspace.assignHost` operation). The remaining authFetch is the self-hosted server's own local host-assignment route, which performs that flow server-side.",
  "features/settings/data/agent-settings-api.ts":
    "Agent settings read and write `/api/account/agent-settings` on the local or self-hosted server; the hosted plane has no such route, so this is not a Hosted Server AccountPort surface.",
}

function sourceFiles(root: string) {
  const dir = path.join(srcRoot, root)
  if (!existsSync(dir)) return []
  const files: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const file = path.join(current, entry)
      if (statSync(file).isDirectory()) {
        walk(file)
        continue
      }
      if (!/\.tsx?$/.test(file)) continue
      if (/\.(test|vitest)\.tsx?$/.test(file)) continue
      files.push(canonicalRelativePath(path.relative(srcRoot, file)))
    }
  }
  walk(dir)
  return files
}

function canonicalRelativePath(value: string) {
  return value.replaceAll("\\", "/")
}

/**
 * Whether a module reaches the account-bearing transport.
 *
 * `authFetch` attaches the bearer; `getAuthToken` obtains it directly; the
 * `api` helper wraps `authFetch`. Injecting a transport (`request: authFetch`)
 * counts too — that is exactly how a hosted feature gets its credential today.
 */
function authenticatedMarkers(text: string) {
  const markers: string[] = []
  if (/\bauthFetch\b/.test(text)) markers.push("authFetch")
  if (/\bgetAuthToken\b/.test(text)) markers.push("getAuthToken")
  if (/from ["']@\/platform\/api\/api["']/.test(text) && /\bapi\.(get|post|put|patch|del|delete)\b/.test(text)) {
    markers.push("api")
  }
  return markers
}

function authenticatedModules() {
  return HOSTED_CANDIDATE_ROOTS.flatMap(sourceFiles)
    .filter((rel) => authenticatedMarkers(readFileSync(path.join(srcRoot, rel), "utf8")).length > 0)
    .toSorted()
}

describe("hosted operation inventory", () => {
  test("every authenticated hosted-candidate module is declared", () => {
    const declared = new Set([...Object.keys(HOSTED_OPERATION_OWNERS), ...Object.keys(LOCAL_AUTHENTICATED_MODULES)])
    expect(authenticatedModules().filter((module) => !declared.has(module))).toEqual([])
  })

  test("every hosted operation owner still exists, is still authenticated, and names only real operations", () => {
    const problems = Object.entries(HOSTED_OPERATION_OWNERS).flatMap(([module, operations]) => {
      const file = path.join(srcRoot, module)
      if (!existsSync(file)) return [`${module}: missing`]
      const text = readFileSync(file, "utf8")
      return [
        ...(authenticatedMarkers(text).length === 0 ? [`${module}: no longer authenticated`] : []),
        ...operations.filter((name) => !Object.hasOwn(HOSTED_OPERATIONS, name)).map((name) => `${module}: ${name} is not a hosted operation`),
        ...operations.filter((name) => !text.includes(`"${name}"`)).map((name) => `${module}: no longer names ${name}`),
      ]
    })
    expect(problems).toEqual([])
  })

  test("every locally exempted module still exists and is still authenticated", () => {
    const stale = Object.keys(LOCAL_AUTHENTICATED_MODULES).filter((module) => {
      const file = path.join(srcRoot, module)
      if (!existsSync(file)) return true
      return authenticatedMarkers(readFileSync(file, "utf8")).length === 0
    })
    expect(stale).toEqual([])
  })

  test("every local exemption carries a reason", () => {
    for (const [module, reason] of Object.entries(LOCAL_AUTHENTICATED_MODULES)) {
      expect(reason.trim(), `${module} needs a reason`).not.toBe("")
    }
  })

  test("detects a newly introduced authenticated call site", () => {
    // Mutation check: the scanner must react to the thing it claims to watch.
    expect(authenticatedMarkers(`import { authFetch } from "@/platform/api/api"`)).toEqual(["authFetch"])
    expect(
      authenticatedMarkers(`import { api } from "@/platform/api/api"\nawait api.post("/x", {})`),
    ).toEqual(["api"])
    expect(authenticatedMarkers(`import { fetchLocal } from "@/platform/api/local"`)).toEqual([])
  })

  test("module inventory keys use one platform-independent path shape", () => {
    expect(canonicalRelativePath("features\\workspaces\\data\\share-workspace.ts")).toBe(
      "features/workspaces/data/share-workspace.ts",
    )
    expect(canonicalRelativePath("features/workspaces/data/share-workspace.ts")).toBe(
      "features/workspaces/data/share-workspace.ts",
    )
  })
})
