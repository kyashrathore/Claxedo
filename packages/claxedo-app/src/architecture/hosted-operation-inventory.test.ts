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
 * authenticated calls a signed desktop may make. Unit 9 turns it into typed
 * schemas, Unit 10 generates the requirement manifest from it, and Unit 11
 * implements it as an exhaustive Electron handler map. All three inherit
 * whatever the matrix says, which makes a stale matrix worse than none: it
 * would silently narrow the desktop's capabilities, or silently widen its IPC
 * surface, with a green build either way.
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
 * `hosted-product-contract.test.ts`, and again by Unit 10's parity test.
 */

/** Source roots whose modules are candidates to move into `@claxedo/cloud-app`. */
const HOSTED_CANDIDATE_ROOTS = [
  "features/workgraph",
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
 * Each needs a reason, because "it is exempt" is how an inventory rots. The
 * unit that removes each exemption is named.
 */
const LOCAL_AUTHENTICATED_MODULES: Record<string, string> = {
  "app/routes/directory-layout.tsx":
    "Local route shell. Unit 9 replaces its authFetch use with the injected local transport; it never calls Hosted Server.",
  "features/workspaces/ui/panel/workspace-panel.tsx":
    "Local workspace panel. Its api calls target local-server routes; hosted rows arrive through the injected port.",
  "features/workspaces/ui/dialogs/create-cloud-project.tsx":
    "Cloud create goes through workspace-create-api (AccountPort). Remaining api use is local driver listing on the sidecar.",
  "features/settings/ui/providers.tsx":
    "Local provider settings. Credential list/disconnect uses local-server credential routes via claxedoCredentialRequest; hosted account identity stays on account-section.",
  "features/settings/ui/sandbox-section.tsx":
    "Sandbox driver settings talk only to the local sidecar `/api/workspace/drivers*`; not a Hosted Server AccountPort surface.",
  "features/onboarding/sandbox-provider-query.ts":
    "Onboarding sandbox read path is local-sidecar drivers; credentials never leave the laptop via AccountPort.",
  "features/onboarding/sandbox-provider-api.ts":
    "Onboarding sandbox write path is local-sidecar drivers; Hosted Server does not own these credentials.",
  "features/workspaces/data/share-workspace.ts":
    "Desktop sharing goes through the machine remote-access port (Host Connector signs the link challenge — `hostLink.*` rows in the matrix). The remaining authFetch is the self-hosted server's own local register route, which performs that flow server-side.",
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
 * counts too — that is exactly how WorkGraph gets its credential today.
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

describe("hosted operation matrix", () => {
  test("exists and declares itself enforced by this test", () => {
    expect(existsSync(matrixPath)).toBe(true)
    expect(matrix).toContain("hosted-operation-inventory.test.ts")
  })

  test("names an owner module for at least every hosted capability group", () => {
    for (const group of ["WorkGraph", "Documents", "Billing", "Connections", "Workspace authority", "Sessions"]) {
      expect(matrix, `matrix must cover ${group}`).toContain(`### ${group}`)
    }
  })

  test("never promises a direct laptop runtime target", () => {
    // U8-R22. A row returning `directRuntimeUrl` would make the laptop a direct
    // client target and bypass every Relay authorization gate. The matrix may
    // only MENTION the field in the prose that forbids it.
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
      expect(reason.length, `${module} needs a reason`).toBeGreaterThan(40)
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
