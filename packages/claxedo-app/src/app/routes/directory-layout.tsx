// Claxedo workspace routes are pure pass-throughs: route resolution + cloud session URL side effects only. Per-pane providers live in Workbench DirectoryScope (rubric C4).
import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useServer } from "@/app/connection/server"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/platform/i18n/provider"
import { resolveSessionUrl } from "@/platform/runtime/session-url"
import { useConfigOptional } from "@/app/providers/config"
import { resolveLegacyRedirect } from "@/platform/identity/route"
import { authFetch } from "@/platform/api/api"
import { decodeDirectory, isLocalPersonalScope, workspaceResolveUrl } from "./directory-layout-routes"
import { useResolvedWorkspaceRoute } from "./workspace-route-resolution-provider"

export { decodeDirectory } from "./directory-layout-routes"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const config = useConfigOptional()
  const routeResolution = useResolvedWorkspaceRoute()
  const directory = createMemo(() => routeResolution()?.directory ?? "")

  createEffect(
    () => ({ pathname: location.pathname, search: location.search, hash: location.hash }),
    ({ pathname, search, hash }) => {
      let cancelled = false
      void resolveLegacyRedirect(pathname, async ({ directory }) => {
        const response = await (platform.fetch ?? authFetch)(
          workspaceResolveUrl({
            serverUrl: server.url,
            directory,
          }),
          { headers: { Accept: "application/json" } },
        )
        if (!response.ok) return null
        return await response.json().catch(() => null)
      }).then((target) => {
        if (cancelled || !target) return
        // Router navigation performs an imperative flush. Solid 2 deliberately
        // rejects that while this tracked effect (including its async scope) is
        // still active, so cross the documented microtask boundary first.
        queueMicrotask(() => {
          if (cancelled) return
          navigate(`${target}${search}${hash}`, { replace: true })
        })
      })
      return () => {
        cancelled = true
      }
    },
  )

  createEffect(
    () => !!params.dir && !directory(),
    (unresolvable) => {
      if (!unresolvable) return
      let cancelled = false
      queueMicrotask(() => {
        if (cancelled) return
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: language.t("directory.error.invalidUrl"),
        })
        navigate("/")
      })
      return () => {
        cancelled = true
      }
    },
  )

  // `server.add` writes the URL the guard reads, so the compute resolves the
  // session this route needs a gateway for and the effect phase does the
  // lookup and the add.
  createEffect(
    () => {
      const current = server.url
      if (!current) return undefined
      if (isLocalPersonalScope({ serverUrl: current, directory: directory() })) return undefined
      const sessionId = location.pathname.match(/\/session\/([^/]+)$/)?.[1]
      return sessionId && sessionId !== "new" ? sessionId : undefined
    },
    (sessionId) => {
      if (!sessionId) return
      let cancelled = false
      void resolveSessionUrl(sessionId, config).then((gatewayUrl) => {
        if (cancelled) return
        if (!gatewayUrl) return
        if (gatewayUrl === server.url) return
        server.add(gatewayUrl)
      })

      return () => {
        cancelled = true
      }
    },
  )

  return <Show when={directory()}>{props.children}</Show>
}
