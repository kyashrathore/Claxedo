import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { lookupNotificationSession, notificationViewedByScope } from "@/context/notification"
import { directorySessions, upsertDirectorySession } from "../shell/data/directory-session-cache"
import { queryClient } from "../shared/query/query-client"

function session(input: { id: string; parentID?: string; title?: string }) {
  return {
    id: input.id,
    parentID: input.parentID,
    title: input.title ?? input.id,
    slug: input.id,
    projectID: "proj",
    directory: "/repo/main",
    version: "1",
    time: { created: 1, updated: 1 },
  } as Session
}

beforeEach(() => {
  queryClient.clear()
})

describe("notification viewed scope", () => {
  test("marks only the focused workspace session as viewed", () => {
    expect(
      notificationViewedByScope({
        eventDirectory: "/repo/main",
        sessionID: "ses_active",
        active: { directory: "/repo/main", session: "ses_active" },
      }),
    ).toBe(true)

    expect(
      notificationViewedByScope({
        eventDirectory: "/repo/main",
        sessionID: "ses_background",
        active: { directory: "/repo/main", session: "ses_active" },
      }),
    ).toBe(false)

    expect(
      notificationViewedByScope({
        eventDirectory: "/repo/other",
        sessionID: "ses_active",
        active: { directory: "/repo/main", session: "ses_active" },
      }),
    ).toBe(false)
  })
})

describe("lookupNotificationSession", () => {
  test("returns a cached directory session without fetching", async () => {
    const cached = session({ id: "ses_cached", title: "Cached" })
    upsertDirectorySession("/repo/main", cached)

    const result = await lookupNotificationSession({
      directory: "/repo/main",
      sessionID: "ses_cached",
      getSession: async () => {
        throw new Error("should not fetch cached sessions")
      },
    })

    expect(result).toBe(cached)
  })

  test("fetches a cold session and warms the directory cache", async () => {
    const fetched = session({ id: "ses_cold", title: "Cold" })

    const result = await lookupNotificationSession({
      directory: "/repo/main",
      sessionID: "ses_cold",
      getSession: async (parameters) => {
        expect(parameters).toEqual({ directory: "/repo/main", sessionID: "ses_cold" })
        return fetched
      },
    })

    expect(result).toBe(fetched)
    expect(directorySessions("/repo/main").find((item) => item.id === "ses_cold")).toBe(fetched)
  })

  test("returns undefined when the cold session fetch fails", async () => {
    const result = await lookupNotificationSession({
      directory: "/repo/main",
      sessionID: "ses_missing",
      getSession: async () => {
        throw new Error("offline")
      },
    })

    expect(result).toBeUndefined()
    expect(directorySessions("/repo/main")).toEqual([])
  })
})
