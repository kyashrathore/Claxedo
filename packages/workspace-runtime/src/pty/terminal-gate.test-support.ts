import net from "node:net"

/**
 * On Windows the runtime asks the PTY for a terminal gate rather than the
 * shell. A faked PTY answers for that gate over its pipe, naming the real
 * process it reports, so admission contains that process before activating it.
 */
export function answerAsTerminalGate(args: readonly string[], pid: number) {
  const index = args.indexOf("--activation-pipe")
  const pipe = index === -1 ? undefined : args[index + 1]
  if (!pipe || !(pid > 0)) return
  const socket = net.connect(pipe)
  socket.on("error", () => {})
  socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", pid, gateNonce: "faked" })}\n`))
  socket.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes('"activate"')) socket.end(`${JSON.stringify({ type: "activated", gateNonce: "faked", pid })}\n`)
  })
}

/** The part of node-pty's Windows terminal that `closeNativeTerminal` reaches into. */
export function fakeWindowsAgent(pid: number) {
  return { _getConsoleProcessList: () => Promise.resolve([pid]) }
}
