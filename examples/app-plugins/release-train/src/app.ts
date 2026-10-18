import { definePlugin, type SurfaceActionEvent } from "@claxedo/plugin-api"
import {
  absorbChecks,
  addEntry,
  addOwner,
  announcementPrompt,
  createRelease,
  defaultReleaseDate,
  isBump,
  overallProgress,
  removeEntry,
  ship,
  startNextRelease,
  targetVersion,
  type Release,
} from "./model"
import {
  announceStatus,
  changelogData,
  checklistMessages,
  components,
  entriesBody,
  openMessages,
  ownersData,
  patch,
  releaseModel,
  summaryMessages,
} from "./view"

const PAGE_ID = "release-train"
const MAX_LISTED_BLOCKERS = 5

function contextText(action: SurfaceActionEvent, key: string): string {
  const value = action.context[key]
  return typeof value === "string" ? value : ""
}

function contextChoice(action: SurfaceActionEvent, key: string): string | undefined {
  const value = action.context[key]
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined
}

export default definePlugin({
  activate(api) {
    let release: Release = createRelease("1.4.3", defaultReleaseDate(Date.now()))

    api.sidebar.item({ id: "release-train", label: "Release train", pageId: PAGE_ID, icon: "checklist" })

    api.pages.register({
      id: PAGE_ID,
      path: "/release-train",
      title: "Release train",
      surface(channel) {
        const { surfaceId } = channel
        channel.send(...openMessages(surfaceId, release))

        const absorb = (action: SurfaceActionEvent): Release => {
          const bump = contextChoice(action, "bump")
          const date = action.context.date
          return {
            ...absorbChecks(release, action.context.stages),
            ...(isBump(bump) && !release.shipped ? { bump } : {}),
            ...(typeof date === "string" ? { releaseDate: date } : {}),
          }
        }

        const sendChangelog = (before: Release) => {
          const swap = before.changelog.length > 0 !== release.changelog.length > 0 ? [components(surfaceId, [entriesBody(release.changelog.length > 0)])] : []
          channel.send(...swap, patch(surfaceId, "/changelog", changelogData(release)), ...summaryMessages(surfaceId, release))
        }

        const draftAnnouncement = async () => {
          const projectId = api.context.currentProjectId() ?? api.projects.currentId()
          if (!projectId) {
            api.ui.toast({ kind: "warning", title: "Open a project first", description: "The announcement session starts in the current project." })
            return
          }
          const version = targetVersion(release)
          channel.send(components(surfaceId, [announceStatus(true)]))
          try {
            const ref = await api.sessions.create({ projectId, title: `Announce v${version}`, prompt: announcementPrompt(release) })
            const project = api.projects.list().find((item) => item.id === projectId)?.name ?? projectId
            channel.send(patch(surfaceId, "/announce/status", `Announcement session for v${version} in ${project}: ${api.sessions.status(ref)}`))
            api.sessions.open(ref)
          } catch (error) {
            api.ui.toast({ kind: "error", title: "Could not start the session", description: error instanceof Error ? error.message : String(error) })
          } finally {
            channel.send(components(surfaceId, [announceStatus(false)]))
          }
        }

        return {
          async action(action) {
            switch (action.name) {
              case "saveProgress": {
                release = absorb(action)
                channel.send(...checklistMessages(surfaceId, release))
                const progress = overallProgress(release.stages)
                api.ui.toast({ kind: "success", title: "Progress saved", description: `${progress.done} of ${progress.total} checks done` })
                return
              }
              case "applyBump": {
                release = absorb(action)
                channel.send(...summaryMessages(surfaceId, release), patch(surfaceId, "/changelog", changelogData(release)))
                return
              }
              case "ship": {
                release = absorb(action)
                const attempt = ship(release, Date.now())
                if (attempt.error) {
                  channel.send(...checklistMessages(surfaceId, release))
                  const listed = attempt.blockers.slice(0, MAX_LISTED_BLOCKERS).map((blocker) => `${blocker.stage}: ${blocker.label}`)
                  const more = attempt.blockers.length - listed.length
                  api.ui.toast({
                    kind: "warning",
                    title: `Not shipping: ${attempt.error}`,
                    description: listed.length > 0 ? `${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : undefined,
                  })
                  return
                }
                const version = targetVersion(release)
                const ok = await api.ui.confirm({ title: `Ship v${version}?`, description: `Release date ${release.releaseDate.replace("T", " ")}.`, confirmLabel: "Ship" })
                if (!ok) return
                release = ship(release, Date.now()).release
                channel.send(...checklistMessages(surfaceId, release), patch(surfaceId, "/changelog", changelogData(release)))
                api.ui.toast({ kind: "success", title: `v${version} shipped`, description: "Move on to the Announce stage." })
                return
              }
              case "startNext": {
                const ok = await api.ui.confirm({
                  title: "Start the next release?",
                  description: "Every check is cleared and the changelog starts empty. Owners stay.",
                  confirmLabel: "Start next release",
                })
                if (!ok) return
                const before = release
                release = { ...startNextRelease(release), releaseDate: defaultReleaseDate(Date.now()) }
                const model = releaseModel(release)
                channel.send(
                  ...checklistMessages(surfaceId, release),
                  patch(surfaceId, "/bump", model.bump),
                  patch(surfaceId, "/releaseDate", model.releaseDate),
                  patch(surfaceId, "/announce", model.announce),
                )
                sendChangelog(before)
                return
              }
              case "addEntry": {
                const before = release
                const change = addEntry(release, contextChoice(action, "type"), contextText(action, "scope"), contextText(action, "description"))
                if (change.error) {
                  api.ui.toast({ kind: "warning", title: "Entry not added", description: change.error })
                  return
                }
                release = change.release
                sendChangelog(before)
                channel.send(patch(surfaceId, "/entryDraft/description", ""), patch(surfaceId, "/entryDraft/scope", ""))
                return
              }
              case "removeEntry": {
                const before = release
                release = removeEntry(release, contextText(action, "id"))
                sendChangelog(before)
                return
              }
              case "addOwner": {
                const change = addOwner(release, contextText(action, "name"), contextText(action, "role"), contextChoice(action, "stage"))
                if (change.error) {
                  api.ui.toast({ kind: "warning", title: "Owner not added", description: change.error })
                  return
                }
                release = change.release
                channel.send(patch(surfaceId, "/owners", ownersData(release)), patch(surfaceId, "/ownerDraft", { name: "", role: "", stage: ["prepare"] }))
                return
              }
              case "draftAnnouncement":
                release = absorb(action)
                await draftAnnouncement()
                return
            }
          },
        }
      },
    })

    api.commands.register({
      id: "release-train.open",
      title: "Open release train",
      category: "Release train",
      run: () => api.pages.open(PAGE_ID),
    })
  },
})
