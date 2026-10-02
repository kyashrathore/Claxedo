import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk"
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import { singleFlightUntil, stringRecord } from "@claxedo/helpers"
import type { HarnessServices, OwnedProcess, StartInput } from "../../contract"
import type { AcpConnectionOptions, AcpLaunch } from "./connection"
import { AcpStartupDeadline } from "./deadline"
import { AcpTransportError } from "./errors"
import { processByteStreams } from "./streams"

export async function openAcpStream(input: StartInput, options: AcpConnectionOptions, services: HarnessServices, launch: AcpLaunch) {
  if (launch.signal.aborted) throw new AcpTransportError("connection", "ACP launch was abandoned", launch.signal.reason)
  const abort = new AbortController()
  const signal = AbortSignal.any([launch.signal, abort.signal])
  const deadline = new AcpStartupDeadline(services.clock, options.startupTimeoutMs, "launch")
  try { return await deadline.run(openStream(input, options, services, { ...launch, signal }), signal) }
  catch (error) { abort.abort(error); throw error }
}

async function openStream(input: StartInput, options: AcpConnectionOptions, services: HarnessServices,
  launch: AcpLaunch): Promise<{ process?: OwnedProcess; stream: Stream }> {
  if (options.kind === "process") {
    const process = await services.spawn({ file: options.command, args: options.args ?? [], cwd: input.directory,
      env: { ...stringRecord(globalThis.process.env), ...options.env, ...input.credentials.secrets } },
      { role: launch.role, label: "ACP", sessionId: input.sessionId, signal: launch.signal })
    if (launch.signal.aborted) {
      const late = { retire: singleFlightUntil(() => retireAcpStream(process, async () => {}, services), () => true) }
      launch.owner.own(late)
      try { await launch.owner.retire(late) }
      catch (error) { services.log.error("ACP late launch retirement failed", { error }); throw error }
      throw new AcpTransportError("connection", "ACP launch was abandoned", launch.signal.reason)
    }
    const streams = processByteStreams(process)
    const stream = ndJsonStream(streams.output, streams.input)
    return { process, stream }
  }
  if (options.kind === "websocket") return { stream: createWebSocketStream(options.url,
    { headers: options.headers, protocols: options.protocols ? [...options.protocols] : undefined }) }
  return { stream: createHttpStream(options.url, { headers: options.headers }) }
}

export async function retireAcpStream(process: OwnedProcess | undefined,
  cancel: (reason?: unknown) => Promise<void>, services: HarnessServices): Promise<void> {
  if (!process) { await cancel(); return }
  const result = await process.retire({ at: services.clock.now() + 5_000, signal: new AbortController().signal })
  if (!result.stopped) throw new AcpTransportError("ownership", result.error.message)
}
