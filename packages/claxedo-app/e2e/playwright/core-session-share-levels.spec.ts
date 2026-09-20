/**
 * The two levels a session share can carry, driven through the People control.
 *
 * Facts this spec leans on that are not visible at the call site:
 *   - The control is rendered by `SessionHeader` into the titlebar's right
 *     slot, and only for a SIGNED account on a session whose `SessionRef`
 *     names a workspace. It reads its own state from
 *     `GET /api/control/sessions/:id/shares?workspaceId=…` and never from the
 *     workspace runtime.
 *   - A grant and a level change are the SAME request: the control plane keeps
 *     one active grant per (session, recipient), so `POST …/shares` with a
 *     different `level` moves that grant. There is no separate downgrade route,
 *     which is why the downgrade assertion below is a POST and not a PATCH.
 *   - A `send` grant is held in the client until the disclosure is
 *     acknowledged; nothing reaches the control plane before the checkbox. A
 *     `follow` grant and a downgrade are sent immediately, because neither
 *     widens what a teammate can reach.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-session-share-levels"
const SESSION_ID = "ses_share_levels"
const WORKSPACE_ID = "ws_share_levels"
const PROJECT_ID = "proj_share_levels"
const RELAY_ORIGIN = "https://relay.core-session-share-levels.test"
const BOB = "https://issuer.test|user_bob"

type Grant = {
  grant_id: string
  level: "follow" | "send"
  granted_to_user_id?: string
  granted_to_team_id?: string
}

/**
 * The share half of the control plane, with the one rule that decides this
 * spec: one active grant per recipient, so a second POST at another level
 * moves the grant it already holds.
 */
function shareStore() {
  const grants: Grant[] = []
  const posts: Array<{ level?: string; target: string }> = []
  const deletes: string[] = []
  let sequence = 0

  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  const recipient = (body: Record<string, unknown>) => {
    const team = text(body.grantedToTeamPublicId)
    if (team) return { key: team, column: "granted_to_team_id" as const }
    return {
      key: text(body.grantedToUserId) ?? text(body.grantedToTokenIdentifier) ?? "",
      column: "granted_to_user_id" as const,
    }
  }

  return {
    deletes,
    grants,
    posts,
    async handle(route: Route) {
      const request = route.request()
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>
      if (request.method() === "POST") {
        const { key, column } = recipient(body)
        const level = body.level === "send" ? "send" : "follow"
        posts.push({ level: typeof body.level === "string" ? body.level : undefined, target: key })
        const existing = grants.find((grant) => grant[column] === key)
        if (existing) existing.level = level
        else grants.push({ grant_id: `ssg_${++sequence}`, level, [column]: key })
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ grant_id: existing?.grant_id ?? `ssg_${sequence}`, level }),
        })
      }
      if (request.method() === "DELETE") {
        const { key, column } = recipient(body)
        const grantId = text(body.grantId)
        const index = grantId
          ? grants.findIndex((grant) => grant.grant_id === grantId)
          : grants.findIndex((grant) => grant[column] === key)
        deletes.push(grantId ?? key)
        if (index >= 0) grants.splice(index, 1)
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ revoked: index >= 0 }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          can_manage_shares: true,
          grants,
          participants: [],
          teams: [{ team_id: "team_eng", name: "Engineering", is_shared: grants.some((g) => g.granted_to_team_id) }],
        }),
      })
    },
  }
}

async function seedProject(page: Page) {
  await page.addInitScript(
    (input: { dir: string; workspaceId: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [
              { worktree: input.dir, expanded: true, sandboxes: [] },
              { worktree: input.workspaceId, expanded: true, sandboxes: [input.workspaceId] },
            ],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, workspaceId: WORKSPACE_ID },
  )
}

async function openSession(
  page: Page,
  cloud: { role?: "owner" | "viewer"; sessionPrompt?: boolean } = {},
) {
  await seedProject(page)
  // A local-only session is unshareable by design, so the session under test
  // is on the relay lane: only a relay-backed ref carries the workspace id the
  // control reads.
  const handles = await installMockRuntime(page, {
    dir: DIR,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    projectName: "share-levels",
    cloud: {
      workspaceId: WORKSPACE_ID,
      relayOrigin: RELAY_ORIGIN,
      projectName: "share-levels-workspace",
      ...cloud,
    },
  })
  await page.goto(`/w/${encodeURIComponent(WORKSPACE_ID)}/session/${SESSION_ID}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  return handles
}

async function openShareDialog(page: Page, store: ReturnType<typeof shareStore>) {
  await page.route("**/api/control/sessions/*/shares*", (route) => void store.handle(route))
  await openSession(page)
  await page.getByLabel("Share session").click()
  await expect(page.getByText("Share this private session")).toBeVisible()
}

const DISCLOSURE = "The agent runs on the workspace's machine with that machine's files."
const FOLLOW_PLACEHOLDER = "You can follow this session, not send to it"

test.describe("core session share levels @core @surface-web", () => {
  test("a follow grant is sent with no disclosure", async ({ page }) => {
    const store = shareStore()
    await openShareDialog(page, store)

    await page.getByPlaceholder("Person token identifier").fill(BOB)
    await page.getByText("Add person", { exact: true }).click()

    await expect(page.getByText("Can follow").first()).toBeVisible()
    expect(store.posts).toEqual([{ level: "follow", target: BOB }])
    await expect(page.getByText(DISCLOSURE, { exact: false })).toHaveCount(0)
  })

  test("a send grant shows the disclosure and reaches the control plane only after it is acknowledged", async ({ page }) => {
    const store = shareStore()
    await openShareDialog(page, store)

    await page.getByPlaceholder("Person token identifier").fill(BOB)
    await page.getByLabel("Share level").selectOption("send")
    await page.getByText("Add person", { exact: true }).click()

    await expect(page.getByText(DISCLOSURE, { exact: false })).toBeVisible()
    expect(store.posts).toEqual([])
    const confirm = page.getByLabel("Allow sending: Person added to session")
    await expect(confirm).toBeDisabled()

    await page.getByRole("checkbox").check()
    await confirm.click()

    await expect(page.getByText("Can send messages").first()).toBeVisible()
    expect(store.posts).toEqual([{ level: "send", target: BOB }])
    expect(store.grants).toEqual([{ grant_id: "ssg_1", level: "send", granted_to_user_id: BOB }])
  })

  test("a sending grant is downgraded and then revoked from its own row", async ({ page }) => {
    const store = shareStore()
    store.grants.push({ grant_id: "ssg_bob", level: "send", granted_to_user_id: BOB })
    await openShareDialog(page, store)

    await page.getByLabel(`Limit User ${BOB} to following`).click()

    await expect(page.getByText("Can follow").first()).toBeVisible()
    expect(store.posts).toEqual([{ level: "follow", target: BOB }])
    expect(store.grants.map((grant) => grant.level)).toEqual(["follow"])
    // A downgrade is not a second dialog: the narrower level needs no warning.
    await expect(page.getByText(DISCLOSURE, { exact: false })).toHaveCount(0)

    await page.getByLabel(`Remove User ${BOB} from session`).click()

    await expect(page.getByText("No people have been added yet.")).toBeVisible()
    expect(store.deletes).toEqual(["ssg_bob"])
    expect(store.grants).toEqual([])
  })

  test("raising a live follow grant to send passes through the same gate", async ({ page }) => {
    const store = shareStore()
    store.grants.push({ grant_id: "ssg_bob", level: "follow", granted_to_user_id: BOB })
    await openShareDialog(page, store)

    await page.getByLabel(`Let User ${BOB} send messages`).click()

    await expect(page.getByText(DISCLOSURE, { exact: false })).toBeVisible()
    expect(store.posts).toEqual([])

    await page.getByRole("checkbox").check()
    await page.getByLabel(`Allow sending: User ${BOB} on this session`).click()

    await expect(page.getByText("Can send messages").first()).toBeVisible()
    expect(store.posts).toEqual([{ level: "send", target: BOB }])
    expect(store.grants.map((grant) => grant.level)).toEqual(["send"])
  })

  // The composer gate, driven from the two answers the session authority can
  // give. The workspace role is deliberately the OPPOSITE of the session's
  // answer in both cases, so a composer that still read the role would fail
  // each one.
  test("a send grantee composes although the workspace ranks them viewer", async ({ page }) => {
    await openSession(page, { role: "viewer", sessionPrompt: true })

    const editor = page.locator('[data-component="prompt-input"]').last()
    await expect(editor).toHaveAttribute("aria-label", "Ask anything, / for commands, @ for context...")
    await editor.click()
    await editor.fill("run the build")
    await expect(page.locator('[data-action="prompt-submit"]').last()).toBeEnabled()
  })

  test("a follow grantee is refused although the workspace ranks them owner", async ({ page }) => {
    const following = await openSession(page, { sessionPrompt: false })
    const editor = page.locator('[data-component="prompt-input"]').last()
    await expect(editor).toHaveAttribute("aria-label", FOLLOW_PLACEHOLDER)

    const submit = page.locator('[data-action="prompt-submit"]').last()
    await expect(submit).toBeDisabled()
    await expect(submit).toHaveAttribute("aria-label", FOLLOW_PLACEHOLDER)

    await editor.click()
    await editor.fill("this should never send")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(800)
    expect(following.requests.cloudPromptCount).toBe(0)
  })
})
