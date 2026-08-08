// Claxedo /:dir route is a pure pass-through: directory resolution + cloud session URL side effects only. Per-pane providers live in Workbench DirectoryScope (rubric C4).
import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { decode64 } from "@/lib/base64"
import { useServer } from "@/app/connection/server"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/platform/i18n/provider"
import { resolveSessionUrl } from "@/platform/runtime/session-url"
import { useConfigOptional } from "@/app/providers/config"
import { resolveLegacyRedirect } from "@/platform/identity/route"
import { authFetch } from "@/platform/api/api"
import { decodeDirectory, isLocalPersonalScope, workspaceResolveUrl } from "./directory-layout-routes"

export { decodeDirectory } from "./directory-layout-routes"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const config = useConfigOptional()
  const directory = createMemo(() => {
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    const pathname = location.pathname
    const search = location.search
    const hash = location.hash
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
      navigate(`${target}${search}${hash}`, { replace: true })
    })
    return () => {
      cancelled = true
    }
  })

  createEffect(() => {
    if (!params.dir) return
    if (directory()) return
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/")
  })

  createEffect(() => {
    const current = server.url
    if (!current) return
    if (isLocalPersonalScope({ serverUrl: current, directory: directory() })) return

    const pathname = location.pathname
    const match = pathname.match(/\/session\/([^/]+)$/)
    const sessionId = match?.[1]
    if (!sessionId || sessionId === "new") return

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
  })

  return (
    <Show when={directory()}>
      {props.children}
    </Show>
  )
}
