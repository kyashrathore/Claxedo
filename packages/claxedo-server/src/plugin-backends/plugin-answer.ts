/**
 * The plugin chooses its answer's content type, and the answer is served from
 * the control plane's own origin: a `text/html` answer opened as a page would
 * otherwise run the plugin's script with that origin's cookies.
 */
const PLUGIN_ANSWER_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
}

/** A backend's answer as the host serves it: its status, body and content type, and nothing else the plugin set. */
export function pluginAnswer(answer: Response): Response {
  const answerType = answer.headers.get("content-type")
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...PLUGIN_ANSWER_HEADERS, ...(answerType ? { "content-type": answerType } : {}) },
  })
}
