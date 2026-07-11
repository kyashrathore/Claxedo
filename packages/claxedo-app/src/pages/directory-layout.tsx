// Claxedo /:dir route is a pure pass-through: directory resolution + cloud session URL side effects only. Per-pane providers live in Workbench DirectoryScope (rubric C4).
import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { resolveSessionUrl } from "@/utils/session-url"
import { useConfigOptional } from "@/context/config"
import { resolveLegacyRedirect } from "@/shell/identity/route"
import { authFetch } from "@/utils/api"
import { isLocalPersonalScope, workspaceResolveUrl } from "./directory-layout-routes"

// Nominal branded string (was Schema.String.brand("ProjectDirString") from "effect");
// hand-rolled to keep the brand type without dragging the effect runtime into boot.
export type ProjectDirString = string & { readonly __brand: "ProjectDirString" }

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return decoded as ProjectDirString
}

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
