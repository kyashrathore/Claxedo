import { expect, type Page } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { safeLabel, startStack, type StackInput } from "./stack"
import { startHostedStack } from "../../../harness/e2e/harness/hosted-stack"
import { HOSTED_E2E_PUBLIC_HOSTNAME } from "../../../harness/e2e/harness/hosted-control-plane"
import { hostedFetch, type HostedPerson } from "../../../harness/e2e/harness/hosted-auth"
import { hostedRuntimeTransport, type HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import type { HttpTransport } from "../../../harness/e2e/harness/transport"
import type { Workspace } from "../../../harness/e2e/harness/workspaces"
import type { TlsTrust } from "./tls-front"
import { startHostedAppFront } from "./hosted-app-front"
import { signUpHostedEmail } from "./hosted-email"
import { startHostedMachine } from "./hosted-machine"
import { configureHostedScriptedAcp } from "../../../harness/e2e/harness/hosted-cloud"
import { bunPath } from "./scripted-world"

export type Account = {
  name: string
  email: string
  password: string
  person: HostedPerson
  api: ClaxedoApi
  transport: HttpTransport
}

export type SignedStack = {
  url: string
  trust: TlsTrust
  hosted: HostedStack
  local: Awaited<ReturnType<typeof startStack>>
  owner: Account
  signUp(name: string): Promise<Account>
  signIn(page: Page, account: Account): Promise<void>
  makeWorkspace(name: string, projectName?: string): Promise<Workspace>
  runtime(workspaceId: string): HttpTransport
  controlPlaneRequests(): readonly string[]
  close(): Promise<void>
}

export type SignedStackInput = StackInput & { frontPort: number; relayPort: number; distDir: string }

export function sessionCookie(url: string, account: Account) {
  const separator = account.person.cookie.indexOf("=")
  const name = account.person.cookie.slice(0, separator)
  const value = account.person.cookie.slice(separator + 1)
  return { name, value, url, secure: true, httpOnly: true, sameSite: "Lax" as const }
}

export function signedOrigin(frontPort: number) {
  return `https://${HOSTED_E2E_PUBLIC_HOSTNAME}:${frontPort}`
}

export async function startSignedStack(input: SignedStackInput): Promise<SignedStack> {
  const origin = signedOrigin(input.frontPort)
  const hosted = await startHostedStack(safeLabel(input.label), { apiOrigin: origin, appOrigin: origin, emailPassword: true, relayPort: input.relayPort })
  let front: Awaited<ReturnType<typeof startHostedAppFront>> | undefined
  let local: Awaited<ReturnType<typeof startStack>> | undefined
  let machine: Awaited<ReturnType<typeof startHostedMachine>> | undefined
  try {
    front = await startHostedAppFront({ port: input.frontPort, distDir: input.distDir, hosted })
    local = await startStack({ ...input, daemonEnv: { ...input.daemonEnv, NODE_EXTRA_CA_CERTS: hosted.certificate } })
    const workspaces = new Map<string, Workspace>()
    const connectionCache = new Map<string, { runtimeAccessToken: string; tokenExpiresAt: number }>()
    const runtime = (person: HostedPerson, workspaceId: string): HttpTransport => async (request) => {
      const key = `${person.id}:${workspaceId}`
      let connection = connectionCache.get(key)
      if (!connection || connection.tokenExpiresAt <= Date.now() + 10_000) {
        const response = await hostedFetch(hosted, `/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {}, person)
        if (!response.ok) return { status: response.status, body: await response.text() }
        const body = await response.json() as { runtimeAccessToken?: string; tokenExpiresAt?: number }
        if (!body.runtimeAccessToken || !body.tokenExpiresAt) throw new Error(`Workspace ${workspaceId} returned no live runtime capability`)
        connection = { runtimeAccessToken: body.runtimeAccessToken, tokenExpiresAt: body.tokenExpiresAt }
        connectionCache.set(key, connection)
      }
      return hostedRuntimeTransport(hosted, { id: workspaceId, runtimeAccessToken: connection.runtimeAccessToken })(request)
    }
    const signUp = async (name: string): Promise<Account> => {
      const account = await signUpHostedEmail(hosted, name)
      const api = new ClaxedoApi(hosted.workerUrl, (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/wr/")) return account.transport(request)
        const directory = url.searchParams.get("directory")
        const workspace = directory ? workspaces.get(directory) : undefined
        if (!workspace) throw new Error(`No registered hosted folder for ${directory}`)
        return runtime(account.person, workspace.id)(request)
      }, {
        reserveSessions: true,
        workspaceId: async (directory) => {
          const workspace = workspaces.get(directory)
          if (!workspace) throw new Error(`No registered hosted folder for ${directory}`)
          return workspace.id
        },
      })
      return { ...account, api }
    }
    const owner = await signUp("Ada Owner")
    const claim = await hosted.provisionOwnerClaim(owner.person.id)
    const bootstrap = await hostedFetch(hosted, "/api/claxedo/auth/bootstrap-owner", {
      method: "POST", headers: { "content-type": "application/json", "x-claxedo-bootstrap-owner-claim": claim }, body: "{}",
    }, owner.person)
    if (!bootstrap.ok) throw new Error(`Hosted owner bootstrap failed: ${bootstrap.status} ${await bootstrap.text()}`)
    await configureHostedScriptedAcp(hosted, owner.transport, { bunPath: await bunPath(), scriptDir: local.acp.scriptDir, red: input.red, core: true })
    machine = await startHostedMachine(hosted, local, owner.person)
    const opened = front
    const host = machine
    const localStack = local
    return {
      url: origin, trust: opened.trust, hosted, local: localStack, owner, signUp,
      signIn: async (page, account) => {
        await page.goto(`${origin}/login`)
        await page.getByRole("textbox", { name: "Email" }).fill(account.email)
        await page.getByRole("textbox", { name: "Password" }).fill(account.password)
        await page.getByRole("button", { name: "Sign in with email" }).click()
        await expect(page).not.toHaveURL(/\/login$/)
      },
      makeWorkspace: async (name, projectName) => {
        const workspace = await host.makeWorkspace(name, projectName)
        workspaces.set(workspace.directory, workspace)
        return workspace
      },
      runtime: (workspaceId) => runtime(owner.person, workspaceId),
      controlPlaneRequests: () => opened.controlPlaneRequests(),
      close: async () => {
        await host.close()
        await localStack.close()
        await hosted.close()
        await opened.close()
      },
    }
  } catch (error) {
    await machine?.close()
    await local?.close()
    await hosted.close()
    await front?.close()
    throw error
  }
}
