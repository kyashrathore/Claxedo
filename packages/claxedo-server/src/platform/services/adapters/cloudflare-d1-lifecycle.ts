import type { D1Database } from "@cloudflare/workers-types"

import {
  CloudflareOptionalServiceDeploymentDriver,
  type CloudflareOptionalServiceDeploymentInput,
} from "../cloudflare-deployment-driver"
import { OptionalServiceLifecycleCoordinator } from "../lifecycle-coordinator"
import { D1ServiceDeploymentLock, type D1ServiceDeploymentLockOptions } from "./d1-deployment-lock"
import { D1ServiceDeploymentStepStore } from "./d1-deployment-step-store"
import { D1ServiceInstallationStore } from "./d1-installation-store"

export function composeCloudflareD1OptionalServiceLifecycle(
  database: D1Database,
  input: Omit<CloudflareOptionalServiceDeploymentInput, "receipts">,
  lockOptions: D1ServiceDeploymentLockOptions = {},
) {
  const receipts = new D1ServiceDeploymentStepStore(database)
  const driver = new CloudflareOptionalServiceDeploymentDriver({ ...input, receipts })
  const coordinator = new OptionalServiceLifecycleCoordinator(
    new D1ServiceInstallationStore(database),
    new D1ServiceDeploymentLock(database, lockOptions),
  )
  return Object.freeze({ coordinator, driver })
}
