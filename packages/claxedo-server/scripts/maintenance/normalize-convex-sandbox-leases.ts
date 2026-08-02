import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"

type NormalizeResult = {
  scanned: number
  updated: number
}

type MutationExecutor = {
  mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
}

const sandboxLeaseFunctions = (anyApi as unknown as Record<string, {
  normalizeLegacyFields: unknown
}>).sandboxLeases

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function requireEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = clean(env[key])
  if (!value) throw new Error(`${key} is required`)
  return value
}

function assertNormalizeResult(input: unknown): NormalizeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Convex sandbox lease cleanup returned an invalid result")
  }
  const row = input as Record<string, unknown>
  if (typeof row.scanned !== "number" || typeof row.updated !== "number") {
    throw new Error("Convex sandbox lease cleanup returned an incomplete result")
  }
  return { scanned: row.scanned, updated: row.updated }
}

export function normalizeConvexSandboxLeasesInput(env: NodeJS.ProcessEnv = process.env) {
  return {
    convexUrl: requireEnv(env, "CLAXEDO_WORKSPACE_AUTHORITY_URL"),
    serviceToken: requireEnv(env, "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN"),
  }
}

export async function normalizeConvexSandboxLeases(input: {
  serviceToken: string
  executor: MutationExecutor
}) {
  const result = await input.executor.mutation(sandboxLeaseFunctions.normalizeLegacyFields, {
    service_token: input.serviceToken,
  })
  return assertNormalizeResult(result)
}

async function main() {
  const input = normalizeConvexSandboxLeasesInput()
  const client = new ConvexHttpClient(input.convexUrl)
  const result = await normalizeConvexSandboxLeases({
    serviceToken: input.serviceToken,
    executor: {
      mutation: (fn, args) => client.mutation(fn as never, args as never),
    },
  })
  console.log(`Convex sandbox lease cleanup scanned ${result.scanned} rows and updated ${result.updated}.`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
