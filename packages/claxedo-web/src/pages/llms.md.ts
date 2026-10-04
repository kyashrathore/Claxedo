import type { APIRoute } from "astro"
import { homeMarkdown, markdownResponse } from "../content/markdown"

export const GET: APIRoute = () => markdownResponse(homeMarkdown)
