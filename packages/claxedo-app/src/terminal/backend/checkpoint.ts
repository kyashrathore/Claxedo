import type { Terminal as XTerm } from "@xterm/xterm"
import { applyTerminalCheckpointState, type TerminalCheckpoint } from "@claxedo/workspace-runtime/client"

type Write = (data: string, callback?: () => void) => void

function written(write: Write, data: string): Promise<void> {
  return new Promise((resolve) => write(data, resolve))
}

export function createCheckpointRestorer(input: {
  xterm: XTerm
  write: Write
  onReset: () => void
  disposed: () => boolean
}) {
  let chain = Promise.resolve()
  return (checkpoint: TerminalCheckpoint): Promise<void> => {
    chain = chain.then(async () => {
      await written(input.write, "")
      if (input.disposed()) return
      input.xterm.reset()
      input.onReset()
      input.xterm.resize(checkpoint.cols, checkpoint.rows)
      await written(input.write, checkpoint.screen)
      if (input.disposed()) return
      await written(input.write, checkpoint.continuation)
      if (input.disposed()) return
      applyTerminalCheckpointState(input.xterm, checkpoint.state)
    })
    return chain
  }
}
