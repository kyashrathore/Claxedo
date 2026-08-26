// Claxedo keeps the home override for hosted project creation and loopback project ensure.
import { createMemo, For, Match, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoLogo } from "@/ui/controls/claxedo-logo"
import { useLayout } from "@/app/providers/layout"
import { useNavigate } from "@solidjs/router"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { formatRelativeTime } from "@/lib/relative-time"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/app/dialogs/select-directory"
import { useServer } from "@/app/connection/server"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLanguage } from "@/platform/i18n/provider"
import { DialogCreateCloudProject } from "@/features/workspaces/ui/dialogs/create-cloud-project"
import { useConfigOptional } from "@/app/providers/config"
import { ensureLocalProject } from "../../features/workspaces/data/query/project-ensure"
import { workspaceRoute } from "@/platform/identity/route"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { centralTransportForServer } from "@/platform/runtime/transport"

export default function Home() {
  const queryOptions = useQueryOptions()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const config = useConfigOptional()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const pathQuery = useQuery(() => queryOptions.path(null))
  const homedir = createMemo(() => pathQuery.data?.home ?? "")
  const recent = createMemo(() => {
    return (projectsQuery.data ?? [])
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  async function openProject(directory: string) {
    if ((server.isLocal() || centralTransportForServer(server.url) === "loopback") && isFilesystemDirectory(directory)) {
      await ensureLocalProject({
        baseUrl: globalSDK.url,
        request: platform.fetch,
        directory,
        projectsQuery: queryOptions.projects(),
      })
    }
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(workspaceRoute(directory))
  }

  async function chooseProject() {
    async function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          await openProject(directory)
        }
      } else if (result) {
        await openProject(result)
      }
    }

    if (platform.platform === "web" && config?.sandboxEnabled) {
      dialog.show(
        () => <DialogCreateCloudProject onSelect={resolve} />,
        () => void resolve(null),
      )
      return
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => void resolve(null),
      )
    }
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <ClaxedoLogo class="md:w-xl opacity-12" />
      <Switch>
        <Match when={recent().length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {formatRelativeTime(project.time.updated ?? project.time.created)}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <div />
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
