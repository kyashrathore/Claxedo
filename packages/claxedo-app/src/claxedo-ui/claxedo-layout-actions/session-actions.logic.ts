import type { Session } from "@opencode-ai/sdk/v2"
import { produce } from "solid-js/store"
import type { SessionItem } from "../layouts/rail-sidebar"

export function runUpdate(
  session: {
    update: (input: { directory: string; sessionID: string; time: { archived: number } }) => Promise<unknown>
  },
  input: { directory: string; sessionID: string; time: { archived: number } },
) {
  return session.update(input)
}

export async function archiveSession(input: {
  item: SessionItem
  update: (input: { directory: string; sessionID: string; time: { archived: number } }) => Promise<unknown>
  setStore: (value: ReturnType<typeof produce<{ session?: Session[] }>>) => void
  drop?: (input: { id: string; directory: string; projectID?: string; tags?: string[] }) => void
  findTab: (directory: string, sessionId: string) => { id: string } | undefined
  closeTab: (tabId: string) => void
  toast: (input: { title: string; description: string; variant: "success"; duration: number }) => void
  track: () => void
}) {
  if (!input.item.directory) return

  input.track()
  const next = {
    directory: input.item.directory,
    sessionID: input.item.id,
    time: { archived: Date.now() },
  }
  await input.update(next)

  input.setStore(
    produce((draft: { session?: Session[] }) => {
      if (draft.session) {
        draft.session = draft.session.filter((item: Session) => item.id !== input.item.id)
      }
    }),
  )
  input.drop?.({
    id: input.item.id,
    directory: input.item.directory,
    projectID: input.item.projectID,
    tags: input.item.tags,
  })

  const tab = input.findTab(input.item.directory, input.item.id)
  if (tab) input.closeTab(tab.id)

  input.toast({
    title: "Session archived",
    description: `Session "${input.item.title}" has been archived.`,
    variant: "success",
    duration: 3000,
  })
}
