// target-layer: app-shell/bootstrap (demo mode)
import { setupWorker } from "msw/browser"
import { createHandlers } from "./handlers"

type Worker = ReturnType<typeof setupWorker>
type Opts = Parameters<Worker["start"]>[0]

let worker: Promise<Worker> | undefined

async function getWorker() {
  if (!worker) {
    worker = createHandlers().then((handlers) => setupWorker(...handlers))
  }
  return worker
}

export async function startWorker(opts?: Opts) {
  const api = await getWorker()
  await api.start({
    ...opts,
    serviceWorker: {
      url: "/demo/mockServiceWorker.js",
      options: { scope: "/demo/" },
    },
  })
  return api
}
