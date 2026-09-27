import { spawn } from "node:child_process"

export type ScreenBounds = { x: number; y: number; width: number; height: number }

export function recordScreen(bounds: ScreenBounds | undefined, file: string, seconds: number) {
  const region = bounds ? [`-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`] : []
  const child = spawn("screencapture", ["-v", "-x", "-k", `-V${seconds}`, ...region, file], { stdio: ["ignore", "inherit", "inherit"] })
  console.log(`[screen] screencapture pid ${child.pid} for ${seconds}s`)
  return { startedAt: Date.now(), done: new Promise<void>((resolve) => child.on("exit", () => resolve())) }
}
