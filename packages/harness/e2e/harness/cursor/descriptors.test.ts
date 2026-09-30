import { expect, test } from "bun:test"
import { providerDestination } from "../../../../claxedo-server-core/src/credentials/destinations"
import { loadCursorDescriptors } from "./descriptors"

const BROKERED_SERVICES = ["agent/v1/agent_service", "aiserver/v1/bidi", "aiserver/v1/dashboard", "aiserver/v1/server-config"]

test("the Cursor broker row allows exactly the pinned SDK's agent, bidi, dashboard and server-config methods", async () => {
  const descriptors = await loadCursorDescriptors()
  try {
    const methods = BROKERED_SERVICES.flatMap((name) => {
      const service = descriptors.service(name)
      return Object.values(service.methods).map((method) => `/${service.typeName}/${method.name}`)
    })
    const destination = providerDestination({ providerId: "cursor-sdk", kind: "api_key", secret: "cursor-key" })
    expect([...destination?.exactPaths ?? []].sort()).toEqual(["/auth/exchange_user_api_key", "/v1/models", ...methods].sort())
  } finally {
    await descriptors.close()
  }
}, 30_000)
