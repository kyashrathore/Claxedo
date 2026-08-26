import { describe, expect, test } from "bun:test"
import { createTerminalBenchmarkInstanceId, terminalBenchmarkWriteAcceptedObserver, terminalBenchmarkWriteObserver } from "./benchmark-observer"

describe("terminalBenchmarkWriteObserver", () => {
  test("is absent when no benchmark observer was installed", () => {
    expect(terminalBenchmarkWriteObserver("pty-1", "instance-1", {})).toBeUndefined()
  })

  test("forwards parsed writes without scheduling terminal work", () => {
    const receipts: unknown[] = []
    const serialize = () => "screen"
    const dimensions = () => ({ cols: 80, rows: 24 })
    const observer = terminalBenchmarkWriteObserver("pty-1", "instance-1", {
      __CLAXEDO_AGENT_APP_BENCHMARK__: {
        terminalWriteParsed: (receipt) => receipts.push(receipt),
      },
    })
    observer?.({ data: "sentinel", serialize, dimensions, parsedAtMs: 42 })
    expect(receipts).toEqual([{
      terminalId: "pty-1",
      instanceId: "instance-1",
      data: "sentinel",
      serialize,
      dimensions,
      parsedAtMs: 42,
    }])
  })

  test("forwards the client-arrival boundary separately from parsing", () => {
    const receipts: unknown[] = []
    const observer = terminalBenchmarkWriteAcceptedObserver("pty-1", "instance-1", {
      __CLAXEDO_AGENT_APP_BENCHMARK__: {
        terminalWriteAccepted: (receipt) => receipts.push(receipt),
      },
    })
    observer?.({ data: "first-chunk", acceptedAtMs: 12 })
    expect(receipts).toEqual([{ terminalId: "pty-1", instanceId: "instance-1", data: "first-chunk", acceptedAtMs: 12 }])
  })
  test("allocates an instance id only when the benchmark hook is installed", () => {
    expect(createTerminalBenchmarkInstanceId({})).toBeUndefined()
    const id = createTerminalBenchmarkInstanceId({ __CLAXEDO_AGENT_APP_BENCHMARK__: {} })
    expect(id).toBeString()
    expect(id).not.toHaveLength(0)
  })

})
