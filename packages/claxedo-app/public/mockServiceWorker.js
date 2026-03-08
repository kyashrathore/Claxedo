/*
  Retires legacy root-scoped demo workers.
  Active demo mocking now lives only at /demo/mockServiceWorker.js.
*/

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.resolve()
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((list) => Promise.all(list.map((client) => client.navigate(client.url)))),
  )
})
