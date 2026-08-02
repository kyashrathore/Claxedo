import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/platform/persistence/persist"
import { useGlobalSDK } from "@/features/session/app-ports"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/lib/base64"
import { directoryConfig, directoryConfigQuery } from "@/platform/query/directory-config-cache"
import { directorySessions } from "@/features/session/data/sync/directory-session-cache"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
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
  response: "once" | "always" | "reject"
  directory?: string
}) => Promise<void>

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

const permissionContextInput = {
  name: "Permission", gate: true,
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const directory = createMemo(() => decode64(params.dir))
    const configQuery = useQuery(() => directoryConfigQuery(globalSDK.url, directory() ?? ""))
    const permissionConfig = createMemo(() => configQuery.data?.permission)

    const permissionsEnabled = createMemo(() => {
      if (!directory()) return false
      return hasPermissionPromptRules(permissionConfig())
    })

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("permission", ["permission.v3"]),
        migrate(value) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value

          const data = value as Record<string, unknown>
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

    // When config has permission: "allow", auto-enable directory-level auto-accept
    createEffect(() => {
      if (!ready()) return
      const currentDirectory = directory()
      if (!currentDirectory) return
      const perm = permissionConfig()
      if (typeof perm === "string" && perm === "allow") {
        const key = directoryAcceptKey(currentDirectory)
        if (store.autoAccept[key] === undefined) {
          setStore(
            produce((draft) => {
              draft.autoAccept[key] = true
            }),
          )
        }
      }
    })

    const respond: PermissionRespondFn = async (input) => {
      try {
        await globalSDK.client.permission.respond(input)
        if (input.response === "always" && input.directory) enable(input.sessionID, input.directory)
      } catch (err) {
        clearPermissionAutoResponded(input.permissionID)
        throw err
      }
    }

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const hit = markPermissionAutoResponded(permission.id)
      if (hit) return
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
      }).catch(() => undefined)
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

    function enableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
        }),
      )

      globalSDK.client.permission
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

      globalSDK.client.permission
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
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return shouldAutoRespond(permission, directory)
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
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        const perm = directoryConfig(globalSDK.url, directory)?.permission
        return typeof perm === "string" && perm === "allow"
      },
    }
  },
}
export const { use: usePermission, provider: PermissionProvider } = createSimpleContext<ReturnType<typeof permissionContextInput.init>, Record<string, any>>(permissionContextInput)
