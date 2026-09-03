import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"

import {
  ConvexServiceInstallationStore,
  type ConvexInstallationExecutor,
  type ConvexInstallationOperation,
} from "../../../platform/services/adapters/convex-installation-store"
import { controlPlaneTimeoutMs, withTimeout } from "./timeout"
import { withConvexRetry } from "./retry"

type InstallationApi = {
  serviceInstallations: {
    list: FunctionReference<"query">
    get: FunctionReference<"query">
    audit: FunctionReference<"query">
    registerDisabled: FunctionReference<"mutation">
    recordProbe: FunctionReference<"mutation">
    transition: FunctionReference<"mutation">
    uninstall: FunctionReference<"mutation">
  }
}

const installationApi = anyApi as unknown as InstallationApi

const references: Record<ConvexInstallationOperation, FunctionReference<"query"> | FunctionReference<"mutation">> = {
  "serviceInstallations:list": installationApi.serviceInstallations.list,
  "serviceInstallations:get": installationApi.serviceInstallations.get,
  "serviceInstallations:audit": installationApi.serviceInstallations.audit,
  "serviceInstallations:registerDisabled": installationApi.serviceInstallations.registerDisabled,
  "serviceInstallations:recordProbe": installationApi.serviceInstallations.recordProbe,
  "serviceInstallations:transition": installationApi.serviceInstallations.transition,
  "serviceInstallations:uninstall": installationApi.serviceInstallations.uninstall,
}

export function createConvexServiceInstallationStore(input: {
  url: string
  serviceToken: string
  env?: Record<string, string | undefined>
}) {
  const client = new ConvexHttpClient(input.url)
  const env = input.env ?? {}
  const args = (value: Readonly<Record<string, unknown>>) => ({ service_token: input.serviceToken, ...value }) as never
  const executor: ConvexInstallationExecutor = {
    query(operation, value) {
      return withConvexRetry({
        idempotent: true,
        attempt: () => withTimeout(
          client.query(references[operation] as never, args(value)),
          controlPlaneTimeoutMs("read", env),
        ),
      })
    },
    mutation(operation, value) {
      return withConvexRetry({
        // Every installation mutation carries an immutable operationId and the
        // Convex producer makes exact replays idempotent.
        idempotent: true,
        attempt: () => withTimeout(
          client.mutation(references[operation] as never, args(value)),
          controlPlaneTimeoutMs("mutation", env),
        ),
      })
    },
  }
  return new ConvexServiceInstallationStore(executor)
}
