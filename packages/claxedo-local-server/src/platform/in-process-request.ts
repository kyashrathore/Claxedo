/**
 * Requests this process built for itself. Object identity is the one property a
 * network peer cannot forge, and entries die with the request.
 */
const inProcessRequests = new WeakSet<Request>()

export function markInProcessDaemonRequest(request: Request): Request {
  inProcessRequests.add(request)
  return request
}

export function isInProcessDaemonRequest(request: Request): boolean {
  return inProcessRequests.has(request)
}
