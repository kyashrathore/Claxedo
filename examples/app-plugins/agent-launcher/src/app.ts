import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceProgram } from "@claxedo/plugin-api"
import {
  CUSTOM_TEMPLATE_ID,
  batchTitles,
  fillTemplate,
  launchRow,
  projectsSignature,
  readLaunchForm,
  readVariables,
  refreshStatuses,
  templateById,
  validateLaunch,
  variablesFor,
  type Json,
  type Launch,
  type Project,
} from "./model"
import {
  changedPatches,
  launchArea,
  launchedArea,
  launchedData,
  launcherComponents,
  launcherData,
  openingMessages,
  patch,
  projectArea,
  replace,
  summaryData,
  templateNote,
} from "./view"

const PAGE_ID = "agent-launcher"
const STATUS_POLL_MS = 2000

type Ledger = { launches: Launch[]; nextKey: number }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clockTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function openLauncher(api: PluginApi, channel: SurfaceChannel, ledger: Ledger): SurfaceProgram {
  const { surfaceId } = channel
  let projects: readonly Project[] = api.projects.list()
  let launching = false
  let errorsShown = false
  let summary = summaryData(ledger.launches, launching)

  channel.send(
    ...openingMessages(
      surfaceId,
      launcherComponents({ projects, hasLaunches: ledger.launches.length > 0, launching, hasErrors: errorsShown }),
      launcherData(projects, api.context.currentProjectId(), ledger.launches),
    ),
  )

  const sendSummary = () => {
    const next = summaryData(ledger.launches, launching)
    channel.send(...changedPatches(surfaceId, "/stats", summary.stats, next.stats), ...changedPatches(surfaceId, "/status", summary.status, next.status))
    summary = next
  }

  const showErrors = (errors: readonly string[]) => {
    const visible = errors.length > 0
    channel.send(patch(surfaceId, "/errors", errors.join(" ")), ...(visible === errorsShown ? [] : [replace(surfaceId, launchArea(launching, visible))]))
    errorsShown = visible
  }

  const updateLaunch = (index: number, next: Launch) => {
    ledger.launches[index] = next
    channel.send(patch(surfaceId, `/launched/${index}`, launchRow(next)))
  }

  const pollStatuses = () => {
    const refreshed = refreshStatuses(ledger.launches, (ref) => api.sessions.status(ref))
    if (refreshed.changed.length > 0) {
      ledger.launches = refreshed.launches
      channel.send(
        ...refreshed.changed.flatMap((index) => {
          const row = launchRow(refreshed.launches[index]!)
          return [patch(surfaceId, `/launched/${index}/status`, row.status), patch(surfaceId, `/launched/${index}/tone`, row.tone)]
        }),
      )
      sendSummary()
    }
    const current = api.projects.list()
    if (projectsSignature(current) !== projectsSignature(projects)) {
      projects = current
      channel.send(replace(surfaceId, projectArea(projects)))
    }
  }
  const timer = setInterval(pollStatuses, STATUS_POLL_MS)

  const pickTemplate = (context: Record<string, Json>) => {
    const template = templateById(typeof context.id === "string" ? context.id : CUSTOM_TEMPLATE_ID)
    const variables = variablesFor(template, readVariables(context.variables))
    channel.send(patch(surfaceId, "/template", template.id), patch(surfaceId, "/templateNote", templateNote(template.label)), patch(surfaceId, "/variables", variables))
    showErrors([])
    if (template.id !== CUSTOM_TEMPLATE_ID) channel.send(patch(surfaceId, "/prompt", fillTemplate(template.body, variables)))
  }

  const fillPrompt = (context: Record<string, Json>) => {
    const template = templateById(typeof context.template === "string" ? context.template : CUSTOM_TEMPLATE_ID)
    if (template.id === CUSTOM_TEMPLATE_ID) return
    channel.send(patch(surfaceId, "/prompt", fillTemplate(template.body, readVariables(context.variables))))
  }

  const launch = async (context: Record<string, Json>) => {
    if (launching) return
    const form = readLaunchForm(context)
    const errors = validateLaunch(form, projects)
    showErrors(errors)
    if (errors.length > 0) return
    const project = projects.find((entry) => entry.id === form.projectId)!
    const titles = batchTitles(form.title, form.batch, templateById(form.templateId).label)
    const wasEmpty = ledger.launches.length === 0
    const start = ledger.launches.length
    const launchedAt = clockTime()
    for (const title of titles) {
      ledger.launches.push({ key: `launch-${ledger.nextKey++}`, title, projectName: project.name, launchedAt, status: "launching" })
    }
    launching = true
    let settled = 0
    const progress = () =>
      patch(surfaceId, "/launching", { label: `Creating ${titles.length} session${titles.length === 1 ? "" : "s"} in ${project.name}`, percent: Math.round((settled / titles.length) * 100) })
    channel.send(
      ...titles.map((_, offset) => patch(surfaceId, `/launched/${start + offset}`, launchRow(ledger.launches[start + offset]!))),
      progress(),
      replace(surfaceId, launchArea(true, errorsShown)),
      ...(wasEmpty ? [replace(surfaceId, launchedArea(true))] : []),
    )
    sendSummary()
    const failures: string[] = []
    await Promise.all(
      titles.map(async (title, offset) => {
        const index = start + offset
        try {
          const ref = await api.sessions.create({ projectId: project.id, prompt: form.prompt, title })
          updateLaunch(index, { ...ledger.launches[index]!, ref, status: api.sessions.status(ref) })
        } catch (error) {
          failures.push(errorMessage(error))
          updateLaunch(index, { ...ledger.launches[index]!, status: "launch_failed", error: errorMessage(error) })
        }
        settled += 1
        channel.send(progress())
        sendSummary()
      }),
    )
    launching = false
    channel.send(replace(surfaceId, launchArea(false, errorsShown)))
    sendSummary()
    if (failures.length === 0) {
      api.ui.toast({ kind: "success", title: `Launched ${titles.length} session${titles.length === 1 ? "" : "s"}`, description: project.name })
    } else {
      api.ui.toast({ kind: "error", title: `${failures.length} of ${titles.length} launches failed`, description: failures[0] })
    }
  }

  const openSession = (context: Record<string, Json>) => {
    const target = ledger.launches.find((launch) => launch.key === context.key)
    if (!target?.ref) {
      api.ui.toast({ kind: "warning", title: "This session has not started", description: target?.error })
      return
    }
    try {
      api.sessions.open(target.ref)
    } catch (error) {
      api.ui.toast({ kind: "error", title: `Couldn't open ${target.title}`, description: errorMessage(error) })
    }
  }

  const clearLaunched = async () => {
    if (ledger.launches.length === 0) return
    if (launching) {
      api.ui.toast({ kind: "info", title: "Wait for the current launch to finish" })
      return
    }
    const confirmed = await api.ui.confirm({
      title: "Clear the launched list?",
      description: "The sessions keep running; only this list is cleared.",
      confirmLabel: "Clear list",
    })
    if (!confirmed) return
    ledger.launches = []
    summary = summaryData([], launching)
    channel.send(replace(surfaceId, launchedArea(false)), ...Object.entries(launchedData([], launching)).map(([key, value]) => patch(surfaceId, `/${key}`, value)))
  }

  return {
    async action(action) {
      switch (action.name) {
        case "pickTemplate":
          return pickTemplate(action.context)
        case "fillPrompt":
          return fillPrompt(action.context)
        case "launch":
          return launch(action.context)
        case "openSession":
          return openSession(action.context)
        case "clearLaunched":
          return clearLaunched()
      }
    },
    dispose() {
      clearInterval(timer)
    },
  }
}

export default definePlugin({
  activate(api) {
    const ledger: Ledger = { launches: [], nextKey: 1 }
    api.pages.register({
      id: PAGE_ID,
      path: "/agent-launcher",
      title: "Agent launcher",
      surface: (channel) => openLauncher(api, channel, ledger),
    })
    api.sidebar.item({ id: "agent-launcher", label: "Agent launcher", pageId: PAGE_ID })
    api.commands.register({ id: "open", title: "Open agent launcher", category: "Agent launcher", run: () => api.pages.open(PAGE_ID) })
  },
})
