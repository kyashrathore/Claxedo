export const PUBLIC_ORIGIN = "https://claxedo.com"
export const RESEARCH_PATH = "/how-often-do-coding-agents-need-a-full-machine"
export const SHARE_PATH = "/agent-runtime-share"
export const REPORT_PATH_PREFIX = "/r"
export const REPORT_API_PATH = "/api/agent-runtime-reports"

/** @param {string} id */
export function reportPath(id) {
  return `${REPORT_PATH_PREFIX}/${id}`
}
