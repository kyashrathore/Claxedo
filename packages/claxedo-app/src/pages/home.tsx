// Claxedo keeps the home override for hosted project creation and loopback project ensure.
import { createMemo, For, Match, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoLogo } from "@claxedo/claxedo-ui/components/claxedo-logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@claxedo/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useServer } from "@claxedo/context/server"
import { useShellQueryOptions as useQueryOptions } from "@claxedo/shell/data/query-options"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@claxedo/context/language"
import { DialogCreateCloudProject } from "@claxedo/components/dialog-create-cloud-project"
import { useConfigOptional } from "@claxedo/context/config"
import { ensureLocalProject } from "../shared/query/project-ensure"
import { workspaceRoute } from "../shell/identity/route"
import { isLocalFilesystemDirectory } from "../shell/identity/legacy-resolver"
import { centralTransportForServer } from "@claxedo/shell/data/transport/transport"

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
    if ((server.isLocal() || centralTransportForServer(server.url) === "loopback") && isLocalFilesystemDirectory(directory)) {
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
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
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
