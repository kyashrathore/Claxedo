import { definePlugin, type SurfaceActionEvent } from "@claxedo/plugin-api"
import {
  absorbRunbooks,
  addUpdate,
  declareIncident,
  elapsedSeconds,
  formatDuration,
  isRecord,
  postmortemPrompt,
  recordImpact,
  resolve,
  stakeholderUpdate,
  STATUS_LABEL,
  transition,
  type DeclareInput,
  type Incident,
} from "./model"
import {
  components,
  elapsedText,
  incidentMessages,
  incidentModel,
  noticeMessages,
  openMessages,
  patch,
  postmortemStatus,
  structureMessage,
  summaryData,
  updatesBody,
  updatesData,
  type Notice,
  type NoticeKey,
} from "./view"

const PAGE_ID = "incident-commander"

function contextText(action: SurfaceActionEvent, key: string): string {
  const value = action.context[key]
  return typeof value === "string" ? value : ""
}

function declareInput(value: unknown): DeclareInput {
  const form = isRecord(value) ? value : {}
  return { title: form.title, severity: form.severity, services: form.services, commander: form.commander, comms: form.comms, scribe: form.scribe }
}

export default definePlugin({
  activate(api) {
    let incident: Incident | null = null

    api.sidebar.item({ id: "incident-commander", label: "Incident commander", pageId: PAGE_ID, icon: "warning" })

    api.pages.register({
      id: PAGE_ID,
      path: "/incident-commander",
      title: "Incident commander",
      surface(channel) {
        const { surfaceId } = channel
        let timer: ReturnType<typeof setInterval> | undefined
        const shownNotices = new Set<NoticeKey>()

        const notify = (key: NoticeKey, notice: Notice | null) => {
          channel.send(...noticeMessages(surfaceId, key, notice, shownNotices.has(key)))
          if (notice) shownNotices.add(key)
          else shownNotices.delete(key)
        }

        const syncTimer = () => {
          const live = incident !== null && incident.status !== "resolved"
          if (live && timer === undefined) timer = setInterval(() => channel.send(patch(surfaceId, "/elapsed", elapsedText(incident, Date.now()))), 1000)
          if (!live && timer !== undefined) {
            clearInterval(timer)
            timer = undefined
          }
        }

        const show = (next: Incident | null, extra: ReturnType<typeof patch>[] = []) => {
          const hadUpdates = (incident?.updates.length ?? 0) > 0
          incident = next
          const hasUpdates = (incident?.updates.length ?? 0) > 0
          channel.send(...(hadUpdates !== hasUpdates ? [components(surfaceId, [updatesBody(hasUpdates)])] : []), ...incidentMessages(surfaceId, incident, Date.now()), ...extra)
          syncTimer()
        }

        const withRunbooks = (action: SurfaceActionEvent): Incident | null => (incident ? absorbRunbooks(incident, action.context.runbooks) : null)

        const resolveIncident = async (current: Incident, note: string) => {
          const ok = await api.ui.confirm({
            title: `Resolve "${current.title}"?`,
            description: `The clock stops at ${formatDuration(elapsedSeconds(current, Date.now()))} and the status locks.`,
            confirmLabel: "Resolve",
          })
          if (!ok) {
            channel.send(patch(surfaceId, "/statusChoice", [current.status]))
            return
          }
          const change = resolve(current, Date.now(), note)
          if (change.error) {
            notify("status", { title: "Not resolved", text: change.error })
            return
          }
          notify("status", null)
          show(change.incident, [patch(surfaceId, "/transitionNote", "")])
          api.ui.toast({ kind: "success", title: "Incident resolved", description: `Total duration ${formatDuration(elapsedSeconds(change.incident, Date.now()))}` })
        }

        const startPostmortem = async (current: Incident) => {
          if (current.status !== "resolved") {
            const ok = await api.ui.confirm({
              title: "The incident is still open",
              description: "Start the postmortem now anyway? The agent sees the timeline so far.",
              confirmLabel: "Start anyway",
            })
            if (!ok) return
          }
          const projectId = api.context.currentProjectId() ?? api.projects.currentId()
          if (!projectId) {
            api.ui.toast({ kind: "warning", title: "Open a project first", description: "The postmortem session starts in the current project." })
            return
          }
          channel.send(components(surfaceId, [postmortemStatus(true)]))
          try {
            const ref = await api.sessions.create({ projectId, title: `Postmortem: ${current.title}`, prompt: postmortemPrompt(current, Date.now()) })
            channel.send(patch(surfaceId, "/postmortem/status", `Postmortem session ${api.sessions.status(ref)}`))
            api.sessions.open(ref)
          } catch (error) {
            api.ui.toast({ kind: "error", title: "Could not start the postmortem", description: error instanceof Error ? error.message : String(error) })
          } finally {
            channel.send(components(surfaceId, [postmortemStatus(false)]))
          }
        }

        channel.send(...openMessages(surfaceId, incident, Date.now()))
        syncTimer()

        return {
          async action(action) {
            const now = Date.now()
            if (action.name === "declare") {
              const declared = declareIncident(declareInput(action.context.form), now)
              if (!declared.incident) {
                notify("declare", { title: "Incident not declared", text: declared.errors.join(" ") })
                return
              }
              incident = declared.incident
              notify("declare", null)
              channel.send(structureMessage(surfaceId, true), patch(surfaceId, "/", incidentModel(incident, now)))
              syncTimer()
              api.ui.toast({ kind: "warning", title: `${incident.severity} declared`, description: `${incident.title} · commander ${incident.commander}` })
              return
            }
            const current = withRunbooks(action)
            if (!current) {
              api.ui.toast({ kind: "warning", title: "No open incident", description: "Declare one first." })
              return
            }
            switch (action.name) {
              case "transition": {
                const status = action.context.status
                const target = Array.isArray(status) ? status[0] : undefined
                const note = contextText(action, "note")
                incident = current
                if (target === "resolved") {
                  await resolveIncident(current, note)
                  return
                }
                const change = transition(current, target, now, note)
                if (change.error) {
                  channel.send(patch(surfaceId, "/statusChoice", [current.status]))
                  notify("status", { title: "Status not changed", text: change.error })
                  return
                }
                notify("status", null)
                show(change.incident, [patch(surfaceId, "/transitionNote", "")])
                return
              }
              case "saveRunbooks":
                show(current)
                api.ui.toast({ kind: "success", title: "Runbook progress saved" })
                return
              case "postUpdate": {
                const change = addUpdate(current, contextText(action, "text"), now)
                if (change.error) {
                  notify("update", { title: "Update not posted", text: change.error })
                  return
                }
                notify("update", null)
                show(change.incident, [patch(surfaceId, "/draftUpdate", "")])
                api.ui.toast({ kind: "success", title: "Update posted", description: "The stakeholder summary is refreshed." })
                return
              }
              case "recordImpact": {
                const change = recordImpact(current, action.context.usersPercent, action.context.errorRate)
                if (change.error) {
                  notify("impact", { title: "Impact not recorded", text: change.error })
                  return
                }
                notify("impact", null)
                incident = change.incident
                channel.send(patch(surfaceId, "/incident", summaryData(incident)), patch(surfaceId, "/stakeholder", stakeholderUpdate(incident, now)))
                return
              }
              case "resolve":
                incident = current
                await resolveIncident(current, contextText(action, "note"))
                return
              case "postmortem":
                incident = current
                await startPostmortem(current)
                return
              case "reset": {
                const ok = await api.ui.confirm({
                  title: current.status === "resolved" ? "Close this incident?" : "Discard the open incident?",
                  description: current.status === "resolved" ? "Its timeline and updates are cleared from this page." : "It is not resolved. Its timeline and updates are lost.",
                  confirmLabel: "Close",
                })
                if (!ok) return
                incident = null
                for (const key of shownNotices) notify(key, null)
                channel.send(structureMessage(surfaceId, false), patch(surfaceId, "/", incidentModel(null, Date.now())))
                syncTimer()
                return
              }
            }
          },
          dispose() {
            if (timer !== undefined) clearInterval(timer)
            timer = undefined
          },
        }
      },
    })

    api.commands.register({
      id: "incident-commander.open",
      title: "Open incident commander",
      category: "Incidents",
      run: () => api.pages.open(PAGE_ID),
    })

    api.commands.register({
      id: "incident-commander.status",
      title: "Show the open incident's status",
      category: "Incidents",
      run: () => {
        if (!incident) {
          api.ui.toast({ kind: "info", title: "No open incident" })
          return
        }
        api.ui.toast({
          kind: incident.status === "resolved" ? "success" : "warning",
          title: `${incident.severity} · ${STATUS_LABEL[incident.status]} · ${formatDuration(elapsedSeconds(incident, Date.now()))}`,
          description: `${incident.title} · ${updatesData(incident).length} updates posted`,
        })
      },
    })
  },
})
