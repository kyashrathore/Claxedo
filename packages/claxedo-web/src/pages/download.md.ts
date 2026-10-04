import type { APIRoute } from "astro"
import { downloadMarkdown, markdownResponse } from "../content/markdown"

export const GET: APIRoute = () => markdownResponse(downloadMarkdown)
