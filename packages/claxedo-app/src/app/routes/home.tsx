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
import { useConfigOptional } from "@/app/providers/config"
import { useServer } from "@/app/connection/server"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLanguage } from "@/platform/i18n/provider"
import { DialogCreateProject } from "@/features/workspaces/ui/dialogs/create-project-dialog"
import { checkServerHealthCached } from "@/app/connection/server-health"
import { ensureLocalProject, refreshProjectInventory } from "../../features/workspaces/data/query/project-ensure"
import { workspaceRoute } from "@/platform/identity/route"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { centralTransportForDeployment, centralTransportForServer } from "@/platform/runtime/transport"
import { workspaceRouteId } from "@/platform/identity/workspace-route"

export default function Home() {
  const queryOptions = useQueryOptions()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const config = useConfigOptional()
  const pathQuery = useQuery(() => queryOptions.path(null))
  const homedir = createMemo(() => pathQuery.data?.home ?? "")
  const recent = createMemo(() => {
    return (projectsQuery.data ?? [])
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  async function openProject(directory: string, selectedProject?: NonNullable<typeof projectsQuery.data>[number]) {
    let projects = projectsQuery.data ?? []
    if ((server.isLocal() || centralTransportForServer(server.url) === "loopback") && isFilesystemDirectory(directory)) {
      const ensured = await ensureLocalProject({
        baseUrl: globalSDK.url,
        request: platform.fetch,
        directory,
        projectsQuery: queryOptions.projects(),
      })
      if (Array.isArray(ensured)) projects = ensured
    } else {
      // A project the create dialog just made is not in the cached list yet.
      const refreshed = await refreshProjectInventory(queryOptions.projects()).catch(() => undefined)
      if (Array.isArray(refreshed)) projects = refreshed
    }
    const workspaceId = workspaceRouteId(selectedProject ? [selectedProject] : projects, directory)
    if (!workspaceId) return
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(workspaceRoute(workspaceId))
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

    const pickFolder = async () => {
      if (platform.openDirectoryPickerDialog && server.isLocal()) {
        const result = await platform.openDirectoryPickerDialog?.({ title: language.t("command.project.open"), multiple: false })
        return Array.isArray(result) ? result[0] : result ?? undefined
      }
      return new Promise<string | undefined>((done) => {
        dialog.show(
          () => <DialogSelectDirectory onSelect={(dir) => done(typeof dir === "string" ? dir : undefined)} />,
          () => done(undefined),
        )
      })
    }
    // A project is a repository and a name; where it runs is decided later in
    // the composer (see docs/plans/2026-09-05-003).
    const signed = centralTransportForDeployment({ serverUrl: server.url, authEnabled: config?.authEnabled === true }) === "signed-web"
    const health = await checkServerHealthCached({ url: server.url }, platform.fetch ?? globalThis.fetch)
    dialog.show(
      () => (
        <DialogCreateProject
          baseUrl={server.url}
          localExecution={health.localExecution ?? !signed}
          pickFolder={pickFolder}
          onCreated={(project) => void resolve(project.checkoutDirectory)}
        />
      ),
      () => void resolve(null),
    )
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
                    onClick={() => openProject(project.worktree, project)}
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
