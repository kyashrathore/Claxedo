import type { APIRoute } from "astro"
import { compareMarkdown, markdownResponse } from "../content/markdown"

export const GET: APIRoute = () => markdownResponse(compareMarkdown)
