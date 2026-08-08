const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function elapsed(started, now) {
  return `${((now - started) / 1000).toFixed(1)}s`
}

export function createScanProgress(stream, total, timing = {}) {
  const now = timing.now ?? Date.now
  const schedule = timing.setInterval ?? setInterval
  const cancel = timing.clearInterval ?? clearInterval
  const started = now()

  if (!stream.isTTY) {
    stream.write(`Scanning ${total.toLocaleString("en-US")} local transcript stores…\n`)
    return { update() {}, stop() {} }
  }

  let completed = 0
  let harness = "discovering"
  let frame = 0
  const draw = () => {
    const suffix = harness ? ` · ${harness}` : ""
    stream.write(
      `\r\u001B[2K${FRAMES[frame++ % FRAMES.length]} Scanning transcripts ${completed.toLocaleString("en-US")}/${total.toLocaleString("en-US")} · ${elapsed(started, now())}${suffix}`,
    )
  }

  stream.write("\u001B[?25l")
  draw()
  const timer = schedule(draw, 80)
  timer.unref?.()
  const restoreCursor = () => stream.write("\u001B[?25h")
  const interrupted = (code) => () => {
    cancel(timer)
    process.removeListener("exit", restoreCursor)
    stream.write("\r\u001B[2K\u001B[?25h")
    process.exit(code)
  }
  const signals = [
    ["SIGINT", interrupted(130)],
    ["SIGTERM", interrupted(143)],
  ]
  process.once("exit", restoreCursor)
  for (const [signal, handler] of signals) process.once(signal, handler)

  return {
    update(progress) {
      completed = progress.completed
      harness = progress.harness
    },
    stop(errors = 0) {
      cancel(timer)
      process.removeListener("exit", restoreCursor)
      for (const [signal, handler] of signals) process.removeListener(signal, handler)
      const mark = errors ? "!" : "✓"
      const issue = errors ? ` · ${errors.toLocaleString("en-US")} read errors` : ""
      stream.write(
        `\r\u001B[2K${mark} Scanned ${completed.toLocaleString("en-US")} transcript stores in ${elapsed(started, now())}${issue}\n\u001B[?25h`,
      )
    },
  }
}
