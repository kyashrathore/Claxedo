import { definePlugin, type PluginApi, type SessionRef, type SurfaceChannel, type SurfaceMessage, type SurfaceProgram } from "@claxedo/plugin-api"
import { BUILT_IN_TEMPLATES, type PromptTemplate } from "./library"
import {
  categoriesOf,
  checkDraft,
  codeSnippet,
  diffPatches,
  fillPrompt,
  firstText,
  libraryView,
  missingText,
  missingVariables,
  previewMarkdown,
  readDraft,
  readValues,
  recordUse,
  selectedView,
  sessionTitle,
  templateFromDraft,
  toggleFavourite,
  valuesFor,
  type Json,
  type Library,
  type LibraryView,
  type Values,
} from "./model"
import {
  detailArea,
  draftActions,
  draftCategory,
  emptyDraft,
  favouritesPanel,
  libraryComponents,
  libraryTabs,
  openingMessages,
  patch,
  previewStatus,
  projectArea,
  replace,
  sendArea,
  variableForm,
  type Project,
} from "./view"

const PAGE_ID = "prompt-library"

const NO_CODE = "// Press “Copy as code” to turn the filled prompt into a plugin call."

const NO_SELECTION = { id: "", name: "", byline: "", description: "" }

type Problem = { readonly title: string; readonly text: string }

type Store = { library: Library; selectedId: string | undefined; values: Map<string, Values> }

const VIEW_KEYS = ["header", "favouritesTitle", "favourites", "tabs"] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function openLibrary(api: PluginApi, channel: SurfaceChannel, store: Store): SurfaceProgram {
  const { surfaceId } = channel
  const templateById = (id: Json | undefined) => store.library.templates.find((template) => template.id === id)
  let projects: readonly Project[] = api.projects.list()
  let shown: LibraryView = libraryView(store.library)
  let categories = categoriesOf(store.library.templates)
  let sending = false
  let sendErrorShown = false
  let draftErrorsShown = false
  const selected = templateById(store.selectedId)
  const currentProject = api.context.currentProjectId()
  const defaultProject = projects.some((project) => project.id === currentProject) ? currentProject : projects[0]?.id
  const values = selected ? valuesFor(selected, store.values.get(selected.id) ?? {}) : {}
  let previewFilled = selected ? missingVariables(selected, values).length === 0 : false

  channel.send(
    ...openingMessages(
      surfaceId,
      libraryComponents({ categories, hasFavourites: shown.favourites.length > 0, selected, previewFilled, projects }),
      {
        ...shown,
        selected: selected ? selectedView(store.library, selected) : NO_SELECTION,
        values,
        preview: selected ? previewMarkdown(selected, values) : "",
        missing: selected ? missingText(selected, values) : "",
        sendError: { title: "", text: "" },
        code: NO_CODE,
        project: defaultProject ? [defaultProject] : [],
        title: "",
        openAfter: true,
        draft: emptyDraft(categories[0]!),
      },
    ),
  )

  const renderLibrary = () => {
    const next = libraryView(store.library)
    const nextCategories = categoriesOf(store.library.templates)
    const messages: SurfaceMessage[] = VIEW_KEYS.flatMap((key) => diffPatches(`/${key}`, shown[key], next[key])).map((entry) => patch(surfaceId, entry.path, entry.value))
    if (!sameList(categories, nextCategories)) messages.push(replace(surfaceId, [...libraryTabs(nextCategories), ...draftCategory(nextCategories)]))
    if ((shown.favourites.length > 0) !== (next.favourites.length > 0)) messages.push(replace(surfaceId, favouritesPanel(next.favourites.length > 0)))
    shown = next
    categories = nextCategories
    if (messages.length > 0) channel.send(...messages)
  }

  const refreshProjects = () => {
    const current = api.projects.list()
    if (sameList(current.map((project) => `${project.id}:${project.name}`), projects.map((project) => `${project.id}:${project.name}`))) return
    projects = current
    channel.send(replace(surfaceId, projectArea(projects)))
  }

  const showPreview = (template: PromptTemplate, filled: Values) => {
    const ready = missingVariables(template, filled).length === 0
    channel.send(
      patch(surfaceId, "/preview", previewMarkdown(template, filled)),
      patch(surfaceId, "/missing", missingText(template, filled)),
      ...(ready === previewFilled ? [] : [replace(surfaceId, previewStatus(ready))]),
    )
    previewFilled = ready
  }

  const showSendError = (problem: Problem | undefined) => {
    if (problem) channel.send(patch(surfaceId, "/sendError", problem))
    if ((problem !== undefined) === sendErrorShown) return
    sendErrorShown = problem !== undefined
    channel.send(replace(surfaceId, sendArea(sending, sendErrorShown)))
  }

  const remember = (context: Record<string, Json>) => {
    if (typeof context.id === "string" && context.id) store.values.set(context.id, readValues(context.values))
  }

  const select = (template: PromptTemplate) => {
    const hadSelection = templateById(store.selectedId) !== undefined
    store.selectedId = template.id
    const filled = valuesFor(template, store.values.get(template.id) ?? {})
    channel.send(
      patch(surfaceId, "/selected", selectedView(store.library, template)),
      patch(surfaceId, "/values", filled),
      patch(surfaceId, "/code", NO_CODE),
      patch(surfaceId, "/title", ""),
      replace(surfaceId, variableForm(template)),
      ...(hadSelection ? [] : [replace(surfaceId, detailArea(true))]),
    )
    showPreview(template, filled)
    showSendError(undefined)
  }

  const selectTemplate = (context: Record<string, Json>) => {
    remember(context)
    const template = templateById(context.pick)
    if (template) select(template)
  }

  const favourite = (context: Record<string, Json>) => {
    const template = templateById(context.template)
    if (!template) return
    store.library = toggleFavourite(store.library, template.id)
    renderLibrary()
    const added = store.library.favourites.includes(template.id)
    api.ui.toast({ kind: "success", title: added ? "Added to favourites" : "Removed from favourites", description: template.name })
  }

  const preview = (context: Record<string, Json>) => {
    remember(context)
    const template = templateById(context.id)
    if (template) showPreview(template, readValues(context.values))
  }

  const copyCode = async (context: Record<string, Json>) => {
    remember(context)
    const template = templateById(context.id)
    if (!template) return
    const prompt = fillPrompt(template.body, readValues(context.values))
    const code = codeSnippet({ projectId: firstText(context.project) || "<project id>", title: sessionTitle(template, firstText(context.title)), prompt })
    channel.send(patch(surfaceId, "/code", code))
    try {
      await navigator.clipboard.writeText(code)
      api.ui.toast({ kind: "success", title: "Copied the code" })
    } catch {
      api.ui.toast({ kind: "info", title: "The code is ready under Code", description: "The clipboard is not available here." })
    }
  }

  const send = async (context: Record<string, Json>) => {
    if (sending) return
    remember(context)
    refreshProjects()
    const template = templateById(context.id)
    if (!template) return
    const filled = readValues(context.values)
    showPreview(template, filled)
    if (missingVariables(template, filled).length > 0) {
      showSendError({ title: "Can't send yet", text: `Fill in ${missingText(template, filled)} first.` })
      return
    }
    const project = projects.find((entry) => entry.id === firstText(context.project))
    if (!project) {
      showSendError({ title: "Can't send yet", text: "Choose a project." })
      return
    }
    showSendError(undefined)
    sending = true
    channel.send(replace(surfaceId, sendArea(true, false)))
    const title = sessionTitle(template, firstText(context.title))
    let ref: SessionRef
    try {
      ref = await api.sessions.create({ projectId: project.id, prompt: fillPrompt(template.body, filled), title })
    } catch (error) {
      sending = false
      showSendError({ title: "Couldn't send the prompt", text: errorMessage(error) })
      return
    }
    sending = false
    channel.send(replace(surfaceId, sendArea(false, false)))
    store.library = recordUse(store.library, template.id)
    renderLibrary()
    if (store.selectedId === template.id) channel.send(patch(surfaceId, "/selected/byline", selectedView(store.library, template).byline))
    api.ui.toast({ kind: "success", title: `Sent “${title}”`, description: project.name })
    if (context.openAfter !== true) return
    try {
      api.sessions.open(ref)
    } catch (error) {
      api.ui.toast({ kind: "error", title: `Couldn't open “${title}”`, description: errorMessage(error) })
    }
  }

  const showDraftCheck = (variables: readonly string[], errors: readonly string[]) => {
    channel.send(
      patch(surfaceId, "/draft/variables", variables.map((name) => ({ name: `{${name}}` }))),
      patch(surfaceId, "/draft/variablesLabel", variables.length === 0 ? "Variables found: none" : `Variables found: ${variables.length}`),
      patch(surfaceId, "/draft/errors", errors.join(" ")),
    )
    const visible = errors.length > 0
    if (visible !== draftErrorsShown) channel.send(replace(surfaceId, draftActions(visible)))
    draftErrorsShown = visible
  }

  const addTemplate = (context: Record<string, Json>) => {
    const draft = readDraft(context)
    const checked = checkDraft(draft, store.library.templates)
    showDraftCheck(checked.variables, checked.errors)
    if (checked.errors.length > 0) return
    const template = templateFromDraft(draft, store.library.templates)
    store.library = { ...store.library, templates: [...store.library.templates, template] }
    renderLibrary()
    channel.send(patch(surfaceId, "/draft", emptyDraft(template.category)))
    select(template)
    api.ui.toast({ kind: "success", title: `Added “${template.name}”`, description: `In ${template.category}, with ${template.variables.length} variables` })
  }

  return {
    async action(action) {
      const context = action.context
      switch (action.name) {
        case "selectTemplate":
          return selectTemplate(context)
        case "toggleFavourite":
          return favourite(context)
        case "preview":
          return preview(context)
        case "copyCode":
          return copyCode(context)
        case "send":
          return send(context)
        case "checkDraft": {
          const checked = checkDraft(readDraft(context), store.library.templates)
          return showDraftCheck(checked.variables, checked.errors)
        }
        case "addTemplate":
          return addTemplate(context)
      }
    },
  }
}

export default definePlugin({
  activate(api) {
    const store: Store = { library: { templates: BUILT_IN_TEMPLATES, favourites: [], usage: {} }, selectedId: undefined, values: new Map() }
    api.pages.register({ id: PAGE_ID, path: "/prompt-library", title: "Prompt library", surface: (channel) => openLibrary(api, channel, store) })
    api.sidebar.item({ id: "prompt-library", label: "Prompt library", pageId: PAGE_ID })
    api.commands.register({ id: "open", title: "Open prompt library", category: "Prompt library", run: () => api.pages.open(PAGE_ID) })
  },
})
