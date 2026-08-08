use std::collections::HashMap;
use std::env;
use std::io::{self, Read};

use comrak::{Options, markdown_to_html};
use mermaid_rs_renderer::{RenderOptions, render_strict};
use serde::Deserialize;

// JSON escaping can expand a valid source by up to six bytes per input byte.
// The decoded source limits below remain the authoritative workload bounds.
const MAX_REQUEST_BYTES: u64 = 7 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 1024 * 1024;
const MAX_MERMAID_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderRequest {
    source: String,
    #[serde(default)]
    theme: HashMap<String, String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mode = env::args()
        .nth(1)
        .ok_or("expected markdown or mermaid mode")?;
    let mut input = String::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read request: {error}"))?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request exceeds the native renderer limit".to_string());
    }
    let request: RenderRequest =
        serde_json::from_str(&input).map_err(|error| format!("invalid render request: {error}"))?;

    let output = match mode.as_str() {
        "markdown" => render_markdown(&request)?,
        "mermaid" => render_mermaid(&request)?,
        _ => return Err(format!("unsupported renderer mode: {mode}")),
    };
    print!("{output}");
    Ok(())
}

fn render_markdown(request: &RenderRequest) -> Result<String, String> {
    require_source_limit(&request.source, MAX_MARKDOWN_BYTES, "Markdown")?;
    // CommonMark consumes the backslashes in Claxedo's `\(...\)` math
    // delimiters. Protect only the delimiters while Comrak parses the rest;
    // the renderer's existing KaTeX pass receives the original syntax.
    let source = request
        .source
        .replace("\\(", "\u{e000}CLAXEDO_MATH_OPEN\u{e001}")
        .replace("\\)", "\u{e000}CLAXEDO_MATH_CLOSE\u{e001}");
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.render.gfm_quirks = true;
    // The renderer owns the raw-HTML contract. Keep author-supplied HTML inert
    // before it crosses the process boundary; the DOM sanitizer remains a
    // defense-in-depth boundary for renderer-owned markup.
    options.render.r#unsafe = false;
    Ok(markdown_to_html(&source, &options)
        .replace(
            "<a href=",
            "<a class=\"external-link\" target=\"_blank\" rel=\"noopener noreferrer\" href=",
        )
        .replace("\u{e000}CLAXEDO_MATH_OPEN\u{e001}", "\\(")
        .replace("\u{e000}CLAXEDO_MATH_CLOSE\u{e001}", "\\)"))
}

fn render_mermaid(request: &RenderRequest) -> Result<String, String> {
    require_source_limit(&request.source, MAX_MERMAID_BYTES, "Mermaid")?;
    let mut options = RenderOptions::mermaid_default();
    apply_theme(&mut options, &request.theme);
    render_strict(&request.source, options)
        .map_err(|error| format!("invalid Mermaid source: {error}"))
}

fn require_source_limit(source: &str, limit: usize, name: &str) -> Result<(), String> {
    if source.len() <= limit {
        return Ok(());
    }
    Err(format!("{name} source exceeds the native renderer limit"))
}

fn apply_theme(options: &mut RenderOptions, theme: &HashMap<String, String>) {
    if let Some(value) = theme.get("background") {
        options.theme.background = value.clone();
    }
    if let Some(value) = theme.get("primaryColor").or_else(|| theme.get("mainBkg")) {
        options.theme.primary_color = value.clone();
    }
    if let Some(value) = theme.get("primaryTextColor") {
        options.theme.primary_text_color = value.clone();
    }
    if let Some(value) = theme
        .get("primaryBorderColor")
        .or_else(|| theme.get("nodeBorder"))
    {
        options.theme.primary_border_color = value.clone();
    }
    if let Some(value) = theme.get("lineColor") {
        options.theme.line_color = value.clone();
    }
    if let Some(value) = theme.get("secondaryColor") {
        options.theme.secondary_color = value.clone();
    }
    if let Some(value) = theme.get("tertiaryColor") {
        options.theme.tertiary_color = value.clone();
    }
    if let Some(value) = theme.get("textColor") {
        options.theme.text_color = value.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm_markdown_and_keeps_raw_html_inert() {
        let request = RenderRequest {
            source: "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n<script>alert(1)</script>".to_string(),
            theme: HashMap::new(),
        };
        let html = render_markdown(&request).unwrap();
        assert!(html.contains("<table>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("class=\"language-mermaid\""));
        assert!(!html.contains("<script>alert(1)</script>"));
    }

    #[test]
    fn gives_links_the_existing_external_link_contract() {
        let request = RenderRequest {
            source: "[Claxedo](https://claxedo.ai)".to_string(),
            theme: HashMap::new(),
        };
        let html = render_markdown(&request).unwrap();
        assert!(html.contains("class=\"external-link\""));
        assert!(html.contains("target=\"_blank\""));
        assert!(html.contains("rel=\"noopener noreferrer\""));
    }

    #[test]
    fn leaves_math_for_the_renderer_math_pass() {
        let request = RenderRequest {
            source: "Inline \\(x^2\\) and $$y^2$$.".to_string(),
            theme: HashMap::new(),
        };
        let html = render_markdown(&request).unwrap();
        assert!(html.contains("\\(x^2\\)"));
        assert!(html.contains("$$y^2$$"));
    }

    #[test]
    fn renders_mermaid_with_desktop_theme_values() {
        let request = RenderRequest {
            source: "flowchart LR\nA --> B".to_string(),
            theme: HashMap::from([
                ("primaryColor".to_string(), "#123456".to_string()),
                ("lineColor".to_string(), "#abcdef".to_string()),
            ]),
        };
        let svg = render_mermaid(&request).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("#123456"));
        assert!(svg.contains("#abcdef"));
    }

    #[test]
    fn rejects_invalid_mermaid() {
        let request = RenderRequest {
            source: "not a diagram".to_string(),
            theme: HashMap::new(),
        };
        assert!(render_mermaid(&request).is_err());
    }
}
