/**
 * Control-plane + video helpers for the Org→Team `@tier-real` multiplayer suite.
 */
import { expect, type Browser, type Page } from "@playwright/test"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import {
  gateReachesReady,
  seedWorkspace,
  sessionRoute,
  waitForWorkspaceRole,
  type RelayFixtureInfo,
  type RunningRelayFixture,
  type RunningWebApp,
  type SignedRelayAccess,
} from "./web-signed-relay-harness"

const execFileAsync = promisify(execFile)

export type Teammate = {
  subject: string
  tokenIdentifier: string
  role: string
  controlPlaneToken: string
  name?: string
}

export async function mintTeammate(
  fixture: RunningRelayFixture,
  subject: string,
  role: "editor" | "viewer" | "admin",
  opts?: { name?: string; grantWorkspaceShare?: boolean },
): Promise<Teammate> {
  const url = new URL("/__fixture/authority-identity", fixture.info.backendUrl)
  url.searchParams.set("subject", subject)
  url.searchParams.set("role", role)
  if (opts?.name) url.searchParams.set("name", opts.name)
  if (opts?.grantWorkspaceShare === false) url.searchParams.set("grantWorkspaceShare", "0")
  const response = await fetch(url)
  const body = await response.text()
  expect(response.ok, `mint ${subject} failed: ${response.status} ${body}`).toBe(true)
  return JSON.parse(body) as Teammate
}

function controlHeaders(token: string, fixture: RunningRelayFixture, webApp: RunningWebApp) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
    origin: webApp.url,
    "x-opencode-directory": fixture.info.directory,
  }
}

export async function controlSessions(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  token: string,
) {
  const url = new URL("/api/control/sessions", fixture.info.backendUrl)
  url.searchParams.set("workspaceId", fixture.info.workspaceId)
  const response = await fetch(url, { headers: controlHeaders(token, fixture, webApp) })
  const raw = await response.text()
  expect(response.ok, `session list failed: ${response.status} ${raw}`).toBe(true)
  const body = JSON.parse(raw) as { sessions?: Array<{ id?: string; session_id?: string; sessionId?: string }> }
  return (body.sessions ?? []).map((row) => row.session_id ?? row.sessionId ?? row.id).filter((id): id is string => !!id)
}

export async function controlMessages(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  token: string,
  sessionId: string,
) {
  const url = new URL(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/messages`,
    fixture.info.backendUrl,
  )
  url.searchParams.set("workspaceId", fixture.info.workspaceId)
  const response = await fetch(url, { headers: controlHeaders(token, fixture, webApp) })
  const raw = await response.text()
  expect(response.ok, `messages failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw) as { allowed?: boolean; messages?: unknown[] }
}

export async function addTeamMember(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  teamId: string,
  tokenIdentifier: string,
) {
  const url = new URL(
    `/api/control/teams/${encodeURIComponent(teamId)}/members`,
    fixture.info.backendUrl,
  )
  const response = await fetch(url, {
    method: "POST",
    headers: controlHeaders(fixture.info.controlPlaneToken, fixture, webApp),
    body: JSON.stringify({ tokenIdentifier, role: "member" }),
  })
  const raw = await response.text()
  expect(response.ok, `add team member failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw)
}

export async function listTeamMembers(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  teamId: string,
) {
  const url = new URL(
    `/api/control/teams/${encodeURIComponent(teamId)}/members`,
    fixture.info.backendUrl,
  )
  const response = await fetch(url, {
    headers: controlHeaders(fixture.info.controlPlaneToken, fixture, webApp),
  })
  const raw = await response.text()
  expect(response.ok, `list team members failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw) as Array<{ token_identifier?: string; user_id?: string; role: string }>
}

export async function revokeSessionShareTeam(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  sessionId: string,
  teamId: string,
) {
  const url = new URL(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/shares`,
    fixture.info.backendUrl,
  )
  const response = await fetch(url, {
    method: "DELETE",
    headers: controlHeaders(fixture.info.controlPlaneToken, fixture, webApp),
    body: JSON.stringify({
      workspaceId: fixture.info.workspaceId,
      grantedToTeamId: teamId,
    }),
  })
  const raw = await response.text()
  expect(response.ok, `revoke team session share failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw) as { revoked?: boolean }
}

export async function listSessionShares(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  sessionId: string,
) {
  const url = new URL(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/shares`,
    fixture.info.backendUrl,
  )
  url.searchParams.set("workspaceId", fixture.info.workspaceId)
  const response = await fetch(url, {
    headers: controlHeaders(fixture.info.controlPlaneToken, fixture, webApp),
  })
  const raw = await response.text()
  expect(response.ok, `list session shares failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw) as {
    grants?: Array<{ granted_to_team_id?: string | null; grant_id?: string }>
    participants?: unknown[]
  }
}

function teammateInfo(fixture: RunningRelayFixture, token: string): RelayFixtureInfo {
  return { ...fixture.info, controlPlaneToken: token }
}

/** Wait until the composer harness+model trigger leaves "Loading models". */
export async function waitForModelsReady(page: Page, timeoutMs = 90_000) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control, "harness+model control never appeared").toBeVisible({ timeout: timeoutMs })
  await expect(
    control,
    'composer stuck on "Loading models" — runtime/providers never finished',
  ).not.toContainText(/Loading models|^$/, { timeout: timeoutMs })
}

export async function openAs(
  page: Page,
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  access: SignedRelayAccess,
  token: string,
  user: { id: string; fullName: string },
  role: "owner" | "editor" | "viewer" | "admin" = "owner",
) {
  await seedWorkspace(page, teammateInfo(fixture, token), access, user)
  await page.goto(`${webApp.url}${sessionRoute(fixture.info)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  })
  await gateReachesReady(page)
  await waitForWorkspaceRole(page, fixture.info.workspaceId, role)
  await waitForModelsReady(page)
}

export async function sessionIdsOnRail(page: Page) {
  return await page.locator('[data-testid="rail-sidebar-session-row"]').evaluateAll((rows) =>
    rows
      .map((row) => row.getAttribute("data-session-id"))
      .filter((id): id is string => !!id),
  )
}

export async function expectRailAccountName(page: Page, name: string) {
  const label = page.locator('[data-testid="rail-account-trigger"] [data-slot="rail-account-label"]')
  await expect(label, `rail account label never showed ${name}`).toHaveText(name, { timeout: 20_000 })
}

export async function expectAuthorVisible(page: Page, name: string) {
  const avatar = page.locator(`[data-component="message-author-avatar"][aria-label="${name}"]`).first()
  const label = page.locator('[data-slot="message-author-name"]', { hasText: name }).first()
  await expect(avatar, `message-author avatar for ${name} never appeared`).toBeVisible({ timeout: 20_000 })
  await expect(label, `message-author name for ${name} never appeared`).toBeVisible({ timeout: 20_000 })
}

export async function expectSessionOwnerAvatar(page: Page, sessionId: string, ownerName: string) {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`)
  await expect(row, `session row ${sessionId} never appeared`).toBeVisible({ timeout: 20_000 })
  const avatar = row.locator('[data-testid="rail-sidebar-session-owner-avatar"]')
  await expect(avatar, `owner avatar for ${ownerName} never appeared on session ${sessionId}`).toBeVisible({
    timeout: 20_000,
  })
  await expect(avatar).toHaveAttribute("aria-label", ownerName)
}

export async function expectNoSessionOwnerAvatar(page: Page, sessionId: string) {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`)
  await expect(row, `session ${sessionId} never appeared`).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('[data-testid="rail-sidebar-session-owner-avatar"]')).toHaveCount(0)
}

export async function openRecordedPage(browser: Browser, dir: string) {
  mkdirSync(dir, { recursive: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir, size: { width: 1280, height: 900 } },
  })
  const page = await context.newPage()
  return { context, page }
}

export async function grantSessionShareTeam(
  fixture: RunningRelayFixture,
  webApp: RunningWebApp,
  sessionId: string,
  teamId: string,
) {
  const url = new URL(
    `/api/control/sessions/${encodeURIComponent(sessionId)}/shares`,
    fixture.info.backendUrl,
  )
  const response = await fetch(url, {
    method: "POST",
    headers: controlHeaders(fixture.info.controlPlaneToken, fixture, webApp),
    body: JSON.stringify({
      workspaceId: fixture.info.workspaceId,
      grantedToTeamId: teamId,
    }),
  })
  const raw = await response.text()
  expect(response.ok, `grant team session share failed: ${response.status} ${raw}`).toBe(true)
  return JSON.parse(raw) as { grant_id?: string }
}

export async function shareSessionWithTeamViaPeopleUi(page: Page, teamId: string) {
  await expect(page.getByText("Reconnecting…")).toHaveCount(0, { timeout: 60_000 }).catch(() => undefined)
  // SessionHeader can remount across pane/layout updates, leaving more than one
  // share trigger in the DOM; click the last visible one in the live header.
  const people = page.getByRole("button", { name: "Share session", exact: true }).filter({ visible: true }).last()
  await expect(people, "People control never appeared in the session header").toBeVisible({ timeout: 30_000 })
  await people.click()
  const select = page.locator("select").filter({ has: page.locator(`option[value="${teamId}"]`) }).first()
  await expect(select, "People team select never listed the default team").toBeVisible({ timeout: 15_000 })
  await select.selectOption(teamId)
  await page.getByRole("button", { name: "Add team" }).filter({ visible: true }).last().click()
  await expect(page.getByText(`Team ${teamId}`).first()).toBeVisible({ timeout: 15_000 })
}

/** Compose Alice|Bob side-by-side; fails if ffmpeg missing or output absent. */
export async function composeSideBySideVideo(input: {
  aliceWebm: string
  bobWebm: string
  outMp4: string
}) {
  mkdirSync(path.dirname(input.outMp4), { recursive: true })
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", input.aliceWebm,
    "-i", input.bobWebm,
    "-filter_complex",
    "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[left];" +
      "[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[right];" +
      "[left][right]hstack=inputs=2[v]",
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    input.outMp4,
  ], { timeout: 120_000 })
  expect(existsSync(input.outMp4), `composed video missing: ${input.outMp4}`).toBe(true)
}

export function persistVideoCopy(rawPath: string | undefined, outPath: string) {
  expect(rawPath, `raw video path missing for ${outPath}`).toBeTruthy()
  mkdirSync(path.dirname(outPath), { recursive: true })
  copyFileSync(rawPath!, outPath)
  expect(existsSync(outPath), `copied video missing: ${outPath}`).toBe(true)
  return outPath
}

export function writeEvidenceManifest(file: string, body: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(body, null, 2))
  expect(existsSync(file), `manifest missing: ${file}`).toBe(true)
}
