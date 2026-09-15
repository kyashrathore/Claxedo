import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const matrixPath = path.resolve(appRoot, "../../docs/tech-docs/desktop-hosted-operation-matrix.md")

/**
 * Hosted-operation inventory gate.
 *
 * `docs/tech-docs/desktop-hosted-operation-matrix.md` is the closed set of
 * authenticated calls a signed desktop may make. A stale matrix would silently
 * narrow the desktop's capabilities, or silently widen its IPC surface, with
 * a green build either way.
 *
 * A prose document cannot notice a new `authFetch` call. This test can. It
 * scans the hosted-contribution candidate modules for authenticated transport
 * and requires every module it finds to be named as an owner in the matrix —
 * and requires every owner named there to still exist and still be
 * authenticated, so retired rows do not pile up unread.
 *
 * It deliberately does NOT try to resolve URLs statically. Paths here are built
 * through helpers (`documentsUrl({ id, path })`, `url("/commands")`), so a
 * regex that claimed to extract them would report a confident subset and miss
 * the rest — worse than not checking, because it would look like coverage.
 * Method/path fidelity is checked against the real hosted route table in
 * `hosted-shared/hosted-core-app.test.ts`.
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
 * Modules that reach authenticated transport but stay in `@claxedo/app`.
 *
 * Each needs a reason, because "it is exempt" is how an inventory rots: the
 * reason names the local route the module actually calls.
 */
const LOCAL_AUTHENTICATED_MODULES: Record<string, string> = {
  "app/routes/directory-layout.tsx":
    "Local route shell: resolves a directory route against the local server's `workspaceResolveUrl` through `platform.fetch` (authFetch only when the platform injects no transport); never calls Hosted Server.",
  "features/workspaces/ui/panel/workspace-panel.tsx":
    "Local workspace panel. Its api calls target local-server routes; hosted rows arrive through the injected port.",
  "features/workspaces/data/project-api.ts":
    "Projects live on servers with a filesystem (`/api/claxedo/projects` on the local and self-hosted servers); the hosted plane has no such route, so this is not a Hosted Server AccountPort surface.",
  "features/settings/ui/harness-providers-section.tsx":
    "Local provider settings. Credential list/disconnect uses local-server credential routes via claxedoCredentialRequest, and the harness auth entry is dropped through the local server's own `/auth/:providerId`; hosted account identity stays on account-section.",
  "features/settings/ui/sandbox-section.tsx":
    "Sandbox driver settings talk only to the local sidecar `/api/workspace/drivers*`; not a Hosted Server AccountPort surface.",
  "features/onboarding/sandbox-provider-query.ts":
    "Onboarding sandbox read path is local-sidecar drivers; credentials never leave the laptop via AccountPort.",
  "features/onboarding/sandbox-provider-api.ts":
    "Onboarding sandbox write path is local-sidecar drivers; Hosted Server does not own these credentials.",
  "features/settings/data/connected-apps-api.ts":
    "Connected applications read and revoke OAuth consents at the authorization server's own `/api/auth/oauth2/*` endpoints, which authenticate a BROWSER session (cookie, or the bearer plugin's session token). The desktop's AccountPort credential is an OAuth access token for the control-plane resource, which those endpoints do not accept, so this is not a Hosted Server AccountPort surface.",
  "features/workspaces/data/share-workspace.ts":
    "Desktop sharing goes through the machine remote-access port (Host Connector owns the machine key — the `workspace.assignHost` row in the matrix). The remaining authFetch is the self-hosted server's own local host-assignment route, which performs that flow server-side.",
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

const matrix = readFileSync(matrixPath, "utf8")

/** Owner modules named in the matrix's `Owner module` column. */
function matrixOwners() {
  return [...new Set([...matrix.matchAll(/`((?:app|features|platform)\/[^`]+\.tsx?)`/g)].map((match) => match[1]))]
    .toSorted()
}

/**
 * Control-plane routes a machine or the relay calls with no account credential.
 * They are not AccountPort operations, so the four-way guard does not see
 * them; this list is what keeps the matrix complete for them instead. A route
 * added to `routes/hosted/host-enrollment.ts` or the relay resolver lands here
 * and in the matrix in the same commit.
 */
const NON_ACCOUNT_ROUTES = [
  "POST /api/claxedo/host/enrollments/redeem",
  "POST /api/claxedo/host/enrollments/acquire",
  "POST /api/claxedo/host/enrollments/heartbeat",
  "PATCH /api/claxedo/host/enrollments/:id/scope",
  "GET /api/claxedo/host/enrollments",
  "POST /api/claxedo/host/invitations",
  "GET /api/claxedo/host/invitations",
  "DELETE /api/claxedo/host/invitations/:id",
  "GET /internal/relay/host-generation?enrollmentId=",
]

describe("hosted operation matrix", () => {
  test("records every machine-signed, invitation and relay-fence route outside the account operations", () => {
    for (const route of NON_ACCOUNT_ROUTES) {
      expect(matrix, `matrix must record ${route}`).toContain(`| \`${route}\``)
    }
    // A machine route must never be promoted into an AccountPort row by accident.
    const accountRows = matrix.split("\n").filter((line) => /^\| `[a-zA-Z][\w.]*\.[\w.]*` \|/.test(line))
    for (const forbidden of ["/redeem", "/acquire", "/host-generation", "/invitations"]) {
      expect(accountRows.filter((row) => row.includes(forbidden))).toEqual([])
    }
  })

  test("names an owner module for at least every hosted capability group", () => {
    for (const group of ["Documents", "Billing", "Connections", "Workspace authority", "Sessions"]) {
      expect(matrix, `matrix must cover ${group}`).toContain(`### ${group}`)
    }
  })

  test("never promises a direct laptop runtime target", () => {
    // A row returning `directRuntimeUrl` would make the laptop a direct client
    // target and bypass every Relay authorization gate; only the prose that
    // forbids it may mention the field.
    const rows = matrix.split("\n").filter((line) => line.trimStart().startsWith("| `"))
    expect(rows.filter((row) => row.includes("directRuntimeUrl"))).toEqual([])
  })

  test("declares no generic authenticated proxy operation", () => {
    // The confused-deputy shape this whole document exists to prevent.
    for (const forbidden of ["hostedFetch", "authenticatedRequest", "proxyRequest"]) {
      expect(matrix, `matrix must not offer a generic ${forbidden} operation`).not.toContain(`\`${forbidden}\``)
    }
  })
})

describe("hosted operation inventory", () => {
  test("every authenticated hosted-candidate module is declared", () => {
    const declared = new Set([...matrixOwners(), ...Object.keys(LOCAL_AUTHENTICATED_MODULES)])
    expect(authenticatedModules().filter((module) => !declared.has(module))).toEqual([])
  })

  test("every declared owner still exists", () => {
    expect(matrixOwners().filter((module) => !existsSync(path.join(srcRoot, module)))).toEqual([])
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
