import { Hono } from "hono"
import os from "os"
import { sameSource } from "@claxedo/agent-extensions"
import { fanOutConfig } from "../config-fanout"
import {
  AgentExtensionConflictError,
  disableAgentExtension,
  enableAgentExtension,
  installGitHubAgentExtension,
  uninstallAgentExtension,
  updateAgentExtension,
} from "../agent-extensions/install"
import {
  detachDiscoveredAgentExtensionConfig,
  scanExistingAgentExtensionConfig,
  setDiscoveredAgentExtensionConfigState,
} from "../agent-extensions/scan"
import {
  mirrorWorkspaceAgentExtensionRecord,
  readMirroredWorkspaceAgentExtensions,
  resolveGitHubWorkspaceAgentExtension,
  workspaceAgentExtensionRecords,
} from "../agent-extensions/workspace"
import { syncWorkspaceRuntimeAgentExtensions } from "../workspace-supervisor"
import { errorBody } from "./http"
import { localAgentConfigAllowed } from "./agent-config-local-auth"
import {
  agentExtensionPolicyOverrides,
  captureAgentExtensionMutation,
  catalogSourceFor,
  extensionListBody,
  extensionScope,
  extensionSourceInput,
  extensionTargets,
  legacyWorkspaceExtensionRecord,
  legacyWorkspaceExtensionRecordId,
  localExtensionError,
  localExtensionListBody,
  mirroredWorkspaceExtensionListBody,
  syncWorkspaceRuntimeForSignedScope,
  withId,
  workspaceExtensionError,
  workspaceExtensionScope,
  type AgentConfigRouteOptions,
} from "./agent-config-extension-support"

function agentExtensionNotFound(err: unknown) {
  return err instanceof Error && err.message === "Agent Extension not found"
}

export function agentConfigExtensionRoutes(options: AgentConfigRouteOptions = {}) {
  const installExtension = options.installGitHubAgentExtension ?? installGitHubAgentExtension
  const updateExtension = options.updateAgentExtension ?? updateAgentExtension
  const resolveWorkspaceExtension = options.resolveGitHubWorkspaceAgentExtension ?? resolveGitHubWorkspaceAgentExtension
  return new Hono()
    .get("/extensions/catalog", async (c) => {
      const { loadAgentExtensionsCatalog } = await import("../agent-extensions/catalog")
      return c.json(loadAgentExtensionsCatalog())
    })

    .get("/extensions/machine-scan", async (c) => {
      const { scanMachineInstalledExtensions } = await import("../agent-extensions/machine-scan")
      return c.json(await scanMachineInstalledExtensions())
    })

    .get("/extensions/scan", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions scan",
      })
      if (localOnly) return localOnly
      const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
      if (!directory) return c.json(errorBody("agent_extension_directory_required", "directory is required"), 400)
      return c.json(await scanExistingAgentExtensionConfig(directory))
    })

    .post("/extensions/adopt", async (c) =>
      discoveredExtensionStateResponse(c, options, "adopted"))

    .post("/extensions/ignore", async (c) =>
      discoveredExtensionStateResponse(c, options, "ignored"))

    .post("/extensions/detach", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions scan",
      })
      if (localOnly) return localOnly
      const body = await c.req.json<{ directory?: string; path?: string }>().catch(() => null)
      const directory = body?.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
      if (!directory) return c.json(errorBody("agent_extension_directory_required", "directory is required"), 400)
      if (!body?.path) return c.json(errorBody("agent_extension_path_required", "path is required"), 400)
      try {
        return c.json(await detachDiscoveredAgentExtensionConfig({
          root: directory,
          path: body.path,
        }))
      } catch (err) {
        const mapped = localExtensionError(err)
        if (mapped) return mapped
        return c.json(errorBody("agent_extension_scan_update_failed", err instanceof Error ? err.message : String(err)), 400)
      }
    })

    .get("/extensions", async (c) => {
      const requestedScope = c.req.query("scope")
      if (requestedScope === "workspace") {
        return workspaceExtensionListResponse(c, options)
      }
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions",
      })
      if (localOnly) return localOnly
      const scope = extensionScope({
        scope: requestedScope,
        directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
        homeDir: options.homeDir,
      })
      if (scope instanceof Response) return scope
      return c.json(await localExtensionListBody(
        scope,
        await agentExtensionPolicyOverrides(options, {
          scope: scope.scope,
          ...(scope.projectDir ? { directory: scope.projectDir } : {}),
        }),
      ))
    })

    .post("/extensions", async (c) => {
      const body = await c.req.json<{
        source?: string
        scope?: string
        directory?: string
        id?: string
        targets?: unknown
        workspaceId?: string
      }>().catch(() => null)
      if (!body || typeof body.source !== "string" || !body.source.trim()) {
        return c.json(errorBody("agent_extension_source_required", "source is required"), 400)
      }
      const source = body.source
      const requestedScope = body.scope ?? c.req.query("scope")
      if (requestedScope === "workspace") {
        return workspaceExtensionInstallResponse(c, options, resolveWorkspaceExtension, { ...body, source })
      }
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions",
      })
      if (localOnly) return localOnly
      const scope = extensionScope({
        scope: requestedScope,
        directory: body.directory || c.req.query("directory") || c.req.header("x-opencode-directory"),
        homeDir: options.homeDir,
      })
      if (scope instanceof Response) return scope
      try {
        const targets = extensionTargets(body.targets)
        const result = await installExtension({
          source,
          scope: scope.scope,
          ...(scope.projectDir ? { projectDir: scope.projectDir } : {}),
          homeDir: scope.homeDir ?? os.homedir(),
          ...(body.id ? { id: body.id } : {}),
          ...(targets ? { targets } : {}),
        })
        await fanOutConfig().catch(() => {})
        captureAgentExtensionMutation({
          services: options.services,
          action: "install",
          scope: scope.scope,
          id: result.id,
            ...(scope.projectDir ? { directory: scope.projectDir } : {}),
            source,
          targets: result.materialized.targets,
        })
        return c.json(result, 201)
      } catch (err) {
        const mapped = localExtensionError(err)
        if (mapped) return mapped
        return c.json(errorBody("agent_extension_install_failed", err instanceof Error ? err.message : String(err)), 400)
      }
    })

    .post("/extensions/:id/enable", async (c) =>
      extensionEnabledResponse(c, options, true))

    .post("/extensions/:id/disable", async (c) =>
      extensionEnabledResponse(c, options, false))

    .post("/extensions/:id/update", async (c) => {
      if (c.req.query("scope") === "workspace") {
        return workspaceExtensionUpdateResponse(c, options, resolveWorkspaceExtension)
      }
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions",
      })
      if (localOnly) return localOnly
      const scope = extensionScope({
        scope: c.req.query("scope"),
        directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
        homeDir: options.homeDir,
      })
      if (scope instanceof Response) return scope
      try {
        const result = await updateExtension(withId(scope, c.req.param("id")))
        if (!result) return c.json(errorBody("agent_extension_not_found", "Not found"), 404)
        await fanOutConfig().catch(() => {})
        captureAgentExtensionMutation({
          services: options.services,
          action: "update",
          scope: scope.scope,
          id: c.req.param("id"),
          ...(scope.projectDir ? { directory: scope.projectDir } : {}),
          source: extensionSourceInput(result.materialized.source),
          targets: result.materialized.targets,
        })
        return c.json(result)
      } catch (err) {
        const mapped = localExtensionError(err)
        if (mapped) return mapped
        return c.json(errorBody("agent_extension_update_failed", err instanceof Error ? err.message : String(err)), 400)
      }
    })

    .delete("/extensions/:id", async (c) => {
      if (c.req.query("scope") === "workspace") {
        const scope = await workspaceExtensionScope({
          request: c.req.raw,
          workspaceId: c.req.query("workspaceId") || c.req.query("workspace"),
          services: options.services,
          authConfig: options.authConfig,
          verifier: options.verifier,
        })
        if (scope instanceof Response) return scope
        try {
          // Delete is silently idempotent, so a record persisted under a
          // legacy manifest-derived id must be resolved up front — there is
          // no not-found error to retry on.
          const extensionId = (await legacyWorkspaceExtensionRecordId(scope, c.req.param("id"))) ?? c.req.param("id")
          await scope.services.authority!.deleteWorkspaceAgentExtension(scope.auth, {
            workspaceId: scope.workspaceId,
            extensionId,
          })
          await syncWorkspaceRuntimeForSignedScope(scope)
          captureAgentExtensionMutation({
            services: scope.services,
            auth: scope.auth,
            action: "uninstall",
            scope: "workspace",
            id: c.req.param("id"),
            workspaceId: scope.workspaceId,
          })
          return c.json({ ok: true })
        } catch (err) {
          const mapped = workspaceExtensionError(err)
          if (mapped) return mapped
          throw err
        }
      }
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Extensions",
      })
      if (localOnly) return localOnly
      const scope = extensionScope({
        scope: c.req.query("scope"),
        directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
        homeDir: options.homeDir,
      })
      if (scope instanceof Response) return scope
      const result = await uninstallAgentExtension(withId(scope, c.req.param("id")))
      if (!result) return c.json(errorBody("agent_extension_not_found", "Not found"), 404)
      await fanOutConfig().catch(() => {})
      captureAgentExtensionMutation({
        services: options.services,
        action: "uninstall",
        scope: scope.scope,
        id: c.req.param("id"),
        ...(scope.projectDir ? { directory: scope.projectDir } : {}),
      })
      return c.json({ ok: true })
    })
}

async function discoveredExtensionStateResponse(
  c: { req: { raw: Request; query: (name: string) => string | undefined; header: (name: string) => string | undefined; json: <T>() => Promise<T> }; json: (body: unknown, status?: number) => Response },
  options: AgentConfigRouteOptions,
  state: "adopted" | "ignored",
) {
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local Agent Extensions scan",
  })
  if (localOnly) return localOnly
  const body = await c.req.json<{ directory?: string; path?: string }>().catch(() => null)
  const directory = body?.directory || c.req.query("directory") || c.req.header("x-opencode-directory")
  if (!directory) return c.json(errorBody("agent_extension_directory_required", "directory is required"), 400)
  if (!body?.path) return c.json(errorBody("agent_extension_path_required", "path is required"), 400)
  try {
    return c.json(await setDiscoveredAgentExtensionConfigState({
      root: directory,
      path: body.path,
      state,
    }))
  } catch (err) {
    const mapped = localExtensionError(err)
    if (mapped) return mapped
    return c.json(errorBody("agent_extension_scan_update_failed", err instanceof Error ? err.message : String(err)), 400)
  }
}

async function workspaceExtensionListResponse(
  c: { req: { raw: Request; query: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response },
  options: AgentConfigRouteOptions,
) {
  const workspaceId = c.req.query("workspaceId") || c.req.query("workspace")
  if (!workspaceId) return c.json(errorBody("agent_extension_workspace_id_required", "workspaceId is required for workspace Agent Extensions"), 400)
  if (!options.services?.authority) {
    return c.json(await mirroredWorkspaceExtensionListBody(options, workspaceId))
  }
  const scope = await workspaceExtensionScope({
    request: c.req.raw,
    workspaceId,
    services: options.services,
    authConfig: options.authConfig,
    verifier: options.verifier,
  })
  if (scope instanceof Response) return scope
  if (!scope.services?.authority) {
    return c.json(await mirroredWorkspaceExtensionListBody(options, workspaceId))
  }
  try {
    const installs = workspaceAgentExtensionRecords(await scope.services.authority!.listWorkspaceAgentExtensions(scope.auth, {
      workspaceId: scope.workspaceId,
    }))
    return c.json(extensionListBody(
      {
        version: 1 as const,
        installs: installs.map((item) => item.desired),
      },
      { version: 1, packages: {} },
      await agentExtensionPolicyOverrides(options, {
        scope: "workspace",
        workspaceId: scope.workspaceId,
        auth: scope.auth,
      }),
    ))
  } catch (err) {
    const mapped = workspaceExtensionError(err)
    if (mapped) return mapped
    throw err
  }
}

async function workspaceExtensionInstallResponse(
  c: { req: { raw: Request; query: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response },
  options: AgentConfigRouteOptions,
  resolveWorkspaceExtension: typeof resolveGitHubWorkspaceAgentExtension,
  body: {
    source: string
    id?: string
    targets?: unknown
    workspaceId?: string
  },
) {
  const workspaceId = body.workspaceId || c.req.query("workspaceId") || c.req.query("workspace")
  if (!workspaceId) return c.json(errorBody("agent_extension_workspace_id_required", "workspaceId is required for workspace Agent Extensions"), 400)
  if (!options.services?.authority) {
    return mirroredWorkspaceExtensionInstallResponse(c, resolveWorkspaceExtension, body, workspaceId)
  }
  const scope = await workspaceExtensionScope({
    request: c.req.raw,
    workspaceId,
    services: options.services,
    authConfig: options.authConfig,
    verifier: options.verifier,
  })
  if (scope instanceof Response) return scope
  if (!scope.services?.authority) {
    return mirroredWorkspaceExtensionInstallResponse(c, resolveWorkspaceExtension, body, workspaceId)
  }
  try {
    await scope.services.authority!.authorizeWorkspaceAgentExtensionsAdmin(scope.auth, {
      workspaceId: scope.workspaceId,
    })
    const targets = extensionTargets(body.targets)
    const result = await resolveWorkspaceExtension({
      source: body.source,
      workspaceId: scope.workspaceId,
      ...(body.id ? { id: body.id } : {}),
      ...(targets ? { targets } : {}),
    })
    const records = workspaceAgentExtensionRecords(await scope.services.authority!.listWorkspaceAgentExtensions(scope.auth, {
      workspaceId: scope.workspaceId,
    }))
    // Guard on "same id OR same source", not the id alone: a record persisted
    // before installs were pinned to the catalog id sits under the fetched
    // package's own name and would otherwise coexist with the pinned row.
    const legacy = legacyWorkspaceExtensionRecord(records, { id: result.id, source: result.record.desired.source })
    const existing = records.find((item) => item.desired.id === result.id) ?? legacy
    if (existing && !sameSource(existing.desired.source, result.record.desired.source)) {
      throw new AgentExtensionConflictError(
        "agent_extension_source_conflict",
        `Agent Extension ${result.id} is already installed from a different source`,
        {
          id: result.id,
          existingSource: existing.desired.source,
          requestedSource: result.record.desired.source,
        },
      )
    }
    const desired = {
      ...result.record.desired,
      enabled: existing?.desired.enabled ?? result.record.desired.enabled,
      installed_at: existing?.desired.installed_at ?? result.record.desired.installed_at,
    }
    await scope.services.authority!.upsertWorkspaceAgentExtension(scope.auth, {
      workspaceId: scope.workspaceId,
      extensionId: result.id,
      packageName: desired.package_name,
      desired,
      lock: result.record.lock,
    })
    // Absorb the legacy row only after the pinned row is written: failing
    // between the calls leaves today's two-row state, which the next install
    // heals, instead of dropping the only record of the install.
    if (legacy) {
      await scope.services.authority!.deleteWorkspaceAgentExtension(scope.auth, {
        workspaceId: scope.workspaceId,
        extensionId: legacy.desired.id,
      })
    }
    await syncWorkspaceRuntimeForSignedScope(scope)
    captureAgentExtensionMutation({
      services: scope.services,
      auth: scope.auth,
      action: "install",
      scope: "workspace",
      id: result.id,
      workspaceId: scope.workspaceId,
      source: body.source,
      targets: desired.targets,
    })
    return c.json({
      id: result.id,
      package: result.package,
      cache: result.cache,
      desired,
      lock: result.record.lock,
    }, 201)
  } catch (err) {
    const mapped = workspaceExtensionError(err)
    if (mapped) return mapped
    return c.json(errorBody("agent_extension_install_failed", err instanceof Error ? err.message : String(err)), 400)
  }
}

async function mirroredWorkspaceExtensionInstallResponse(
  c: { json: (body: unknown, status?: number) => Response },
  resolveWorkspaceExtension: typeof resolveGitHubWorkspaceAgentExtension,
  body: {
    source: string
    id?: string
    targets?: unknown
  },
  workspaceId: string,
) {
  try {
    const targets = extensionTargets(body.targets)
    const result = await resolveWorkspaceExtension({
      source: body.source,
      workspaceId,
      ...(body.id ? { id: body.id } : {}),
      ...(targets ? { targets } : {}),
    })
    const records = await readMirroredWorkspaceAgentExtensions({ workspaceId })
    // Same "same id OR same source" guard as the authority path above.
    const legacy = legacyWorkspaceExtensionRecord(records, { id: result.id, source: result.record.desired.source })
    const existing = records.find((item) => item.desired.id === result.id) ?? legacy
    if (existing && !sameSource(existing.desired.source, result.record.desired.source)) {
      throw new AgentExtensionConflictError(
        "agent_extension_source_conflict",
        `Agent Extension ${result.id} is already installed from a different source`,
        {
          id: result.id,
          existingSource: existing.desired.source,
          requestedSource: result.record.desired.source,
        },
      )
    }
    const record = {
      desired: {
        ...result.record.desired,
        enabled: existing?.desired.enabled ?? result.record.desired.enabled,
        installed_at: existing?.desired.installed_at ?? result.record.desired.installed_at,
      },
      lock: result.record.lock,
    }
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId,
      record,
      ...(legacy ? { replaces: legacy.desired.id } : {}),
    })
    await syncWorkspaceRuntimeAgentExtensions(workspaceId, await readMirroredWorkspaceAgentExtensions({ workspaceId }))
    return c.json({
      id: result.id,
      package: result.package,
      cache: result.cache,
      desired: record.desired,
      lock: record.lock,
    }, 201)
  } catch (err) {
    const mapped = workspaceExtensionError(err)
    if (mapped) return mapped
    return c.json(errorBody("agent_extension_install_failed", err instanceof Error ? err.message : String(err)), 400)
  }
}

async function extensionEnabledResponse(
  c: { req: { raw: Request; query: (name: string) => string | undefined; header: (name: string) => string | undefined; param: (name: string) => string }; json: (body: unknown, status?: number) => Response },
  options: AgentConfigRouteOptions,
  enabled: boolean,
) {
  if (c.req.query("scope") === "workspace") {
    const scope = await workspaceExtensionScope({
      request: c.req.raw,
      workspaceId: c.req.query("workspaceId") || c.req.query("workspace"),
      services: options.services,
      authConfig: options.authConfig,
      verifier: options.verifier,
    })
    if (scope instanceof Response) return scope
    try {
      try {
        await scope.services.authority!.setWorkspaceAgentExtensionEnabled(scope.auth, {
          workspaceId: scope.workspaceId,
          extensionId: c.req.param("id"),
          enabled,
        })
      } catch (err) {
        // A record persisted under a legacy manifest-derived id still answers
        // to the catalog id (`resolveInstallId` on the local path): on a miss,
        // retry against the same-source legacy record before reporting it.
        const legacyId = agentExtensionNotFound(err)
          ? await legacyWorkspaceExtensionRecordId(scope, c.req.param("id"))
          : undefined
        if (!legacyId) throw err
        await scope.services.authority!.setWorkspaceAgentExtensionEnabled(scope.auth, {
          workspaceId: scope.workspaceId,
          extensionId: legacyId,
          enabled,
        })
      }
      await syncWorkspaceRuntimeForSignedScope(scope)
      captureAgentExtensionMutation({
        services: scope.services,
        auth: scope.auth,
        action: enabled ? "enable" : "disable",
        scope: "workspace",
        id: c.req.param("id"),
        workspaceId: scope.workspaceId,
      })
      return c.json({ ok: true, enabled })
    } catch (err) {
      const mapped = workspaceExtensionError(err)
      if (mapped) return mapped
      throw err
    }
  }
  const localOnly = await localAgentConfigAllowed({
    request: c.req.raw,
    authConfig: options.authConfig,
    verifier: options.verifier,
    label: "Local Agent Extensions",
  })
  if (localOnly) return localOnly
  const scope = extensionScope({
    scope: c.req.query("scope"),
    directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
    homeDir: options.homeDir,
  })
  if (scope instanceof Response) return scope
  const result = await (enabled ? enableAgentExtension : disableAgentExtension)(withId(scope, c.req.param("id")))
  if (!result) return c.json(errorBody("agent_extension_not_found", "Not found"), 404)
  await fanOutConfig().catch(() => {})
  captureAgentExtensionMutation({
    services: options.services,
    action: enabled ? "enable" : "disable",
    scope: scope.scope,
    id: c.req.param("id"),
    ...(scope.projectDir ? { directory: scope.projectDir } : {}),
  })
  return c.json(result)
}

async function workspaceExtensionUpdateResponse(
  c: { req: { raw: Request; query: (name: string) => string | undefined; param: (name: string) => string }; json: (body: unknown, status?: number) => Response },
  options: AgentConfigRouteOptions,
  resolveWorkspaceExtension: typeof resolveGitHubWorkspaceAgentExtension,
) {
  const scope = await workspaceExtensionScope({
    request: c.req.raw,
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace"),
    services: options.services,
    authConfig: options.authConfig,
    verifier: options.verifier,
  })
  if (scope instanceof Response) return scope
  try {
    await scope.services.authority!.authorizeWorkspaceAgentExtensionsAdmin(scope.auth, {
      workspaceId: scope.workspaceId,
    })
    const current = workspaceAgentExtensionRecords(await scope.services.authority!.listWorkspaceAgentExtensions(scope.auth, {
      workspaceId: scope.workspaceId,
    }))
    const requestedId = c.req.param("id")
    const desiredItems = current.map((item) => item.desired)
    // Read a legacy same-source record via the catalog, but reinstall under
    // the *requested* id: updating by the curated id is also what normalizes
    // the record onto it (same shape as updateAgentExtension on the local
    // path). An exact record always wins.
    const catalogSource = catalogSourceFor(requestedId)
    const hit = desiredItems.find((item) => item?.id === requestedId)
      ?? (catalogSource
        ? desiredItems.find((item) => item && sameSource(item.source, catalogSource))
        : undefined)
    if (!hit) return c.json(errorBody("agent_extension_not_found", "Not found"), 404)
    const result = await resolveWorkspaceExtension({
      source: extensionSourceInput(hit.source),
      workspaceId: scope.workspaceId,
      id: requestedId,
      targets: hit.targets,
      now: Date.now(),
    })
    const desired = {
      ...result.record.desired,
      enabled: hit.enabled,
      installed_at: hit.installed_at,
    }
    await scope.services.authority!.upsertWorkspaceAgentExtension(scope.auth, {
      workspaceId: scope.workspaceId,
      extensionId: result.id,
      packageName: desired.package_name,
      desired,
      lock: result.record.lock,
    })
    if (hit.id !== result.id) {
      await scope.services.authority!.deleteWorkspaceAgentExtension(scope.auth, {
        workspaceId: scope.workspaceId,
        extensionId: hit.id,
      })
    }
    await syncWorkspaceRuntimeForSignedScope(scope)
    captureAgentExtensionMutation({
      services: scope.services,
      auth: scope.auth,
      action: "update",
      scope: "workspace",
      id: result.id,
      workspaceId: scope.workspaceId,
      source: extensionSourceInput(hit.source),
      targets: desired.targets,
    })
    return c.json({ id: result.id, desired, lock: result.record.lock })
  } catch (err) {
    const mapped = workspaceExtensionError(err)
    if (mapped) return mapped
    throw err
  }
}
