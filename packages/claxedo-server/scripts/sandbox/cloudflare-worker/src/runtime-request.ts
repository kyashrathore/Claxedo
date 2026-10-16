import type { Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"

// A Durable Object's and an entrypoint's `fetch` are typed with workers-types'
// own Request and Response, while this Worker is written against the DOM
// lib's; at runtime they are one class.

export function domRequest(request: WorkerRequest): Request {
  return request as unknown as Request
}

export function workerResponse(response: Response): WorkerResponse {
  return response as unknown as WorkerResponse
}
