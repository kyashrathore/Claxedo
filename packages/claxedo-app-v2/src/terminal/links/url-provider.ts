import { PatternLinkProvider, type LinkMatch, type LinkProviderTerminal } from "./wrapped-line-provider"

const URL_PATTERN = /\bhttps?:\/\/(?:\[[0-9a-fA-F:.%]+\][^\s<>[\]'"]*|[^\s<>[\]'"]+)/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

function trimUnbalancedParens(url: string): string {
  let open = 0
  let end = url.length
  for (let i = 0; i < url.length; i++) {
    if (url[i] === "(") open++
    else if (url[i] === ")") {
      if (open > 0) open--
      else {
        end = i
        break
      }
    }
  }
  let result = url.slice(0, end)
  while (result.endsWith("(")) result = result.slice(0, -1)
  return result
}

export class UrlLinkProvider extends PatternLinkProvider {
  constructor(
    terminal: LinkProviderTerminal,
    private readonly onOpen: (event: MouseEvent, url: string) => void,
  ) {
    super(terminal)
  }

  protected pattern(): RegExp {
    return new RegExp(URL_PATTERN.source, "g")
  }

  protected transformMatch(match: LinkMatch): LinkMatch | null {
    const text = trimUnbalancedParens(match.text).replace(TRAILING_PUNCTUATION, "")
    if (text === match.text) return match
    return { ...match, text, end: match.end - (match.text.length - text.length) }
  }

  protected handleActivation(event: MouseEvent, text: string): void {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    this.onOpen(event, text)
  }
}
