import { MemoryPorts, authority } from "../conformance/test-support/memory-ports"
import { registerBrokerBehaviorCases } from "./test-support/behavior-cases"
import { registerBrokerPortCases } from "./test-support/port-cases"

registerBrokerPortCases("memory", () => {
  const ports = new MemoryPorts()
  return {
    ports, authority,
    prepareProviderTurn: () => {},
    abortProviderTurn: () => ports.cancelProviderTurn(),
    close: () => {},
  }
})

registerBrokerBehaviorCases("memory", () => new MemoryPorts())
