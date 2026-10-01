import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { expect, type Page } from "@playwright/test"
import { ClaxedoApi } from "./api"
import type { SignedDaemon } from "./daemon"
import { storeScriptedKeys } from "../../../harness/e2e/harness/scripted-providers"
import { APP_SCRIPTED_PROVIDER_IDS } from "./scripted-world"
import { releasePort, reservePort } from "../../../harness/e2e/harness/ports"
import { relayResolverToken, startRelay, type Relay } from "./relay"
import { startStack, type Stack, type StackInput } from "./stack"
import { startTlsFront, type TlsFront, type TlsTrust } from "./tls-front"
import { bearerTransport, type HttpTransport } from "../../../harness/e2e/harness/transport"
import { makeSignedWorkspace, type Workspace } from "../../../harness/e2e/harness/workspaces"

export type Account = {
  name: string
  email: string
  password: string
  subject: string
  api: ClaxedoApi
  transport: HttpTransport
}

export type SignedStack = {
  url: string
  trust: TlsTrust
  stack: Stack
  owner: Account
  signUp(name: string): Promise<Account>
  signIn(page: Page, account: Account): Promise<void>
  makeWorkspace(name: string, projectName?: string): Promise<Workspace>
  relayLog(): string
  close(): Promise<void>
}

export type SignedStackInput = StackInput & { frontPort: number; distDir: string; cloud?: boolean }

async function signUp(stack: Stack, frontUrl: string, name: string): Promise<Account> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@claxedo.test`
  const password = `pw-${randomUUID()}`
  const response = await fetch(new URL("/api/auth/sign-up/email", stack.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: frontUrl },
    body: JSON.stringify({ email, password, name }),
  })
  const token = response.headers.get("set-auth-token")
  if (response.status !== 200 || !token) throw new Error(`Signing up ${email} failed: ${response.status} ${await response.text()}`)
  const { user } = (await response.json()) as { user: { id: string } }
  const transport = bearerTransport(token)
  await storeScriptedKeys(transport, stack.url, APP_SCRIPTED_PROVIDER_IDS)
  return { name, email, password, subject: user.id, api: new ClaxedoApi(stack.url, transport, { reserveSessions: true }), transport }
}

function runtimeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
}

async function signIn(page: Page, frontUrl: string, account: Account) {
  await page.goto(`${frontUrl}/login`)
  await page.getByRole("textbox", { name: "Email" }).fill(account.email)
  await page.getByRole("textbox", { name: "Password" }).fill(account.password)
  await page.getByRole("button", { name: "Sign in with email" }).click()
  await expect(page).not.toHaveURL(/\/login$/)
}

async function startCloudRelay(stack: Stack, signed: SignedDaemon, relayPort: number | undefined, frontUrl: string): Promise<Relay | undefined> {
  if (relayPort === undefined || !signed.cloud) return undefined
  return startRelay({
    root: stack.dataDir,
    port: relayPort,
    resolverToken: signed.cloud.resolverToken,
    controlPlaneUrl: stack.url,
    runtimePublicPem: signed.runtimeKeys.publicPem,
    allowedOrigins: [frontUrl, stack.url],
  })
}

export async function startSignedStack(input: SignedStackInput): Promise<SignedStack> {
  const stack = await startStack(input)
  const relayPort = input.cloud ? await reservePort() : undefined
  let front: TlsFront | undefined
  let relay: Relay | undefined
  const closeCloud = async () => {
    await relay?.close()
    if (relayPort !== undefined) releasePort(relayPort)
  }
  try {
    front = await startTlsFront({ port: input.frontPort, daemonUrl: stack.url, certDir: stack.dataDir })
    const signed: SignedDaemon = {
      publicOrigin: front.url,
      secret: randomBytes(32).toString("hex"),
      distDir: input.distDir,
      operators: [],
      runtimeKeys: runtimeKeys(),
      ...(relayPort !== undefined ? { cloud: { relayUrl: `http://127.0.0.1:${relayPort}`, resolverToken: relayResolverToken() } } : {}),
    }
    await stack.daemon.restart({ signed })
    const owner = await signUp(stack, front.url, "Ada Owner")
    await stack.daemon.restart({ signed: { ...signed, operators: [owner.subject] } })
    relay = await startCloudRelay(stack, signed, relayPort, front.url)
    const opened = front
    return {
      url: opened.url,
      trust: opened.trust,
      stack,
      owner,
      signUp: (name) => signUp(stack, opened.url, name),
      signIn: (page, account) => signIn(page, opened.url, account),
      makeWorkspace: (name, projectName) => makeSignedWorkspace(owner.transport, stack.url, path.join(stack.dataDir, "workspaces"), name, projectName),
      relayLog: () => relay?.log() ?? "",
      close: async () => {
        await opened.close()
        await closeCloud()
        await stack.close()
      },
    }
  } catch (error) {
    await front?.close()
    await closeCloud()
    await stack.close()
    throw error
  }
}
