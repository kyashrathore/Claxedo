import { asRecord } from "@/lib/record"
import { createMemo, createResource, createRoot, createSignal, getOwner, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AgentPermission as PermissionRequest, AgentPermissionReply } from "@claxedo/agent-runtime-contract"
import { Persist, persisted } from "@/platform/persistence/persist"
import { useGlobalSDK } from "@/features/session/app-ports"
import { applyDirectoryEventToShellQueries } from "@/features/session/data/sync/directory-event-projector"
import { directorySessions } from "@/features/session/data/sync/directory-session-cache"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  autoResponseOwnsPermission,
  permissionRequestPolicyReady,
  reconcileAutoPermissionRequests,
  type PermissionAutoReconciliationState,
} from "@/features/session/providers/permission-auto-respond"
import {
  bumpPermissionAutoAcceptVersion,
  clearPermissionAutoResponded,
  markPermissionAutoResponded,
  permissionAutoAcceptVersion,
} from "@/features/session/providers/permission-auto-response-cache"
import { permissionDecidedProperties } from "@/features/session/permission/modes"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: AgentPermissionReply
  directory: PermissionDirectory
}) => Promise<void>
type PermissionDirectory = string

const permissionContextInput = {
  name: "Permission", gate: true,
  init: () => {
    const globalSDK = useGlobalSDK()
    const permissionClient = (target: string) => globalSDK.createClient({ directory: target }).permission

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("permission", ["permission.v3"]),
        migrate(value) {
          const data = asRecord(value)
          if (!data) return value

          if (data.autoAccept) return value

          return {
            ...data,
            autoAccept:
              typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
                ? data.autoAcceptEdits
                : {},
          }
        },
      },
      createStore({
        autoAccept: {} as Record<string, boolean>,
      }),
    )
    const [failedAutoResponses, setFailedAutoResponses] = createStore<Record<string, boolean>>({})

    const respond: PermissionRespondFn = async (input) => {
      try {
        const target = input.directory
        if (!target) throw new Error("Permission response requires an explicit workspace directory")
        const result = await permissionClient(target).respond({
          sessionID: input.sessionID, permissionID: input.permissionID, directory: target,
          ...(typeof input.response === "string" ? { response: input.response } : input.response),
        })
        for (const event of result.data?.events ?? []) {
          applyDirectoryEventToShellQueries({ directory: target, event })
        }
        if (input.response === "always") enable(input.sessionID, target)
      } catch (err) {
        clearPermissionAutoResponded(input.permissionID)
        throw err
      }
    }

    function respondOnce(permission: PermissionRequest, directory: PermissionDirectory) {
      const hit = markPermissionAutoResponded(permission.id)
      if (hit) return
      setFailedAutoResponses(
        produce((draft) => {
          delete draft[permission.id]
        }),
      )
      // Claxedo answering on the user's behalf — "Approve for me" / directory
      // auto-accept — is always a grant; there is no auto-deny path.
      phCapture("permission_decided", {
        ...identityProps(),
        surface: "session",
        ...permissionDecidedProperties({ response: "once", toolKind: permission.permission, mode: "auto" }),
      })
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "once",
        directory,
      }).catch(() => {
        setFailedAutoResponses(permission.id, true)
      })
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      const session = directory ? directorySessions(directory) : []
      return autoRespondsPermission(store.autoAccept, session, { sessionID }, directory)
    }

    function isAutoAcceptingDirectory(directory: string) {
      return isDirectoryAutoAccepting(store.autoAccept, directory)
    }

    function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
      const session = directory ? directorySessions(directory) : []
      return autoRespondsPermission(store.autoAccept, session, permission, directory)
    }

    function bumpEnableVersion(sessionID: string, directory?: string) {
      return bumpPermissionAutoAcceptVersion(sessionID, directory)
    }

    const unsubscribe = globalSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked") return

      const perm = event.properties
      if (!shouldAutoRespond(perm, e.name)) return

      respondOnce(perm, e.name)
    })
    onCleanup(unsubscribe)

    const owner = getOwner()
    const [scopeVersion, setScopeVersion] = createSignal(0)
    const scopes = new Map<string, { count: number; state: () => PermissionAutoReconciliationState | undefined; dispose: () => void }>()
    const policyKey = createMemo(() => ready() ? Object.entries(store.autoAccept)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .sort()
        .join("\n") : undefined)

    // Mounted session panes own their workspace scope. URL parameters cannot
    // identify every open pane, and canonical workspace routes contain no dir.
    function observeDirectory(directory: PermissionDirectory) {
      let scope = scopes.get(directory)
      if (!scope) {
        scope = createRoot((dispose) => {
          let active = true
          onCleanup(() => { active = false })
          const [reconciliation] = createResource(policyKey, async (key) => {
            if (!key) return "ready" as const
            return reconcileAutoPermissionRequests({
              directory,
              active: () => active && ready() && policyKey() === key,
              autoAccept: () => store.autoAccept,
              sessions: () => directorySessions(directory),
              list: async () => (await permissionClient(directory).list({ directory })).data ?? [],
              respond: (permission) => respondOnce(permission, directory),
            })
          })
          return { count: 0, dispose, state: () => reconciliation.loading ? "pending" as const : reconciliation() }
        }, owner)
        scopes.set(directory, scope)
        setScopeVersion((value) => value + 1)
      }
      scope.count += 1
      let released = false
      return () => {
        if (released) return
        released = true
        if (--scope.count) return
        scope.dispose()
        scopes.delete(directory)
        setScopeVersion((value) => value + 1)
      }
    }
    onCleanup(() => {
      for (const scope of scopes.values()) scope.dispose()
      scopes.clear()
    })

    function reconciliationFor(target: PermissionDirectory): PermissionAutoReconciliationState | undefined {
      scopeVersion()
      return scopes.get(target)?.state()
    }

    function enableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
        }),
      )

      permissionClient(directory)
        .list({ directory })
        .then((x) => {
          if (!isAutoAcceptingDirectory(directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
        }),
      )
    }

    function enable(sessionID: string, directory: string) {
      const key = acceptKey(sessionID, directory)
      const version = bumpEnableVersion(sessionID, directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
          delete draft.autoAccept[sessionID]
        }),
      )

      permissionClient(directory)
        .list({ directory })
        .then((x) => {
          if (permissionAutoAcceptVersion(sessionID, directory) !== version) return
          if (!isAutoAccepting(sessionID, directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disable(sessionID: string, directory?: string) {
      bumpEnableVersion(sessionID, directory)
      const key = directory ? acceptKey(sessionID, directory) : sessionID
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
          if (!directory) return
          delete draft.autoAccept[sessionID]
        }),
      )
    }

    return {
      ready,
      observeDirectory,
      requestPolicyReady(directory: PermissionDirectory) {
        return permissionRequestPolicyReady(ready(), reconciliationFor(directory))
      },
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        const policyAutoResponds = shouldAutoRespond(permission, directory)
        return autoResponseOwnsPermission({
          policyAutoResponds,
          reconciliation: directory ? reconciliationFor(directory) : undefined,
          responseFailed: failedAutoResponses[permission.id] ?? false,
        })
      },
      isAutoAccepting,
      isAutoAcceptingDirectory,
      toggleAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) {
          disable(sessionID, directory)
          return
        }

        enable(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        if (isAutoAcceptingDirectory(directory)) {
          disableDirectory(directory)
          return
        }
        enableDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        enable(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        disable(sessionID, directory)
      },
    }
  },
}
export const { use: usePermission, provider: PermissionProvider } = createSimpleContext<ReturnType<typeof permissionContextInput.init>, Record<string, any>>(permissionContextInput)
