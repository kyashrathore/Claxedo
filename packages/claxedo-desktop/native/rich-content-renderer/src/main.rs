use std::borrow::Cow;
use std::collections::HashMap;
use std::env;
use std::io::{self, Read};

use comrak::html::dangerous_url;
use comrak::nodes::{AstNode, NodeLink, NodeValue};
use comrak::{Arena, Options, format_html, parse_document};
use mermaid_rs_renderer::{RenderOptions, render_strict};
use serde::Deserialize;

// JSON escaping can expand a valid source by up to six bytes per input byte.
// The decoded source limits below remain the authoritative workload bounds.
const MAX_REQUEST_BYTES: u64 = 7 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 1024 * 1024;
const MAX_MERMAID_BYTES: usize = 256 * 1024;

// The same closed list as `transcriptLinkPrefixes` in `@opencode-ai/ui`'s
// `marked.tsx`; a parity test in that package fails once the two disagree.
const TRANSCRIPT_LINK_PREFIXES: [&str; 6] = [
    "https://",
    "http://",
    "file://",
    "vscode://",
    "claxedo://",
    "mailto:",
];

// Comrak blanks a `file:` destination unless raw HTML is let through with it,
// so the scheme crosses the formatter behind a name its scanner does not know
// and is put back in the rendered markup.
const BLOCKED_SCHEME_MASK: &str = "x-claxedo-href-";

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

    let arena = Arena::new();
    let root = parse_document(&arena, &source, &options);
    autolink_prose(&arena, root);
    mask_blocked_schemes(root);
    let mut html = String::new();
    format_html(root, &options, &mut html)
        .map_err(|error| format!("failed to render Markdown: {error}"))?;

    Ok(html
        .replace(
            "<a href=",
            "<a class=\"external-link\" target=\"_blank\" rel=\"noopener noreferrer\" href=",
        )
        .replace(&format!("href=\"{BLOCKED_SCHEME_MASK}"), "href=\"")
        .replace(&format!("src=\"{BLOCKED_SCHEME_MASK}"), "src=\"")
        .replace("\u{e000}CLAXEDO_MATH_OPEN\u{e001}", "\\(")
        .replace("\u{e000}CLAXEDO_MATH_CLOSE\u{e001}", "\\)"))
}

fn starts_with_ignore_ascii_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn has_transcript_prefix(url: &str) -> bool {
    TRANSCRIPT_LINK_PREFIXES
        .iter()
        .any(|prefix| starts_with_ignore_ascii_case(url, prefix))
}

// Comrak's own autolink rule owns `http(s)`, bare `www.` and email addresses:
// it backpedals over balanced parentheses, which the run below cannot. The
// remaining schemes have no rule at all, so prose carrying one stays inert
// without this pass.
fn prose_autolink_prefixes() -> impl Iterator<Item = &'static str> {
    TRANSCRIPT_LINK_PREFIXES
        .into_iter()
        .filter(|prefix| !prefix.starts_with("http"))
}

// The run and its trailing strip mirror `transcriptLinkRunSource` and the trim
// its caller applies in `marked.tsx`, so a link ends on the same character in
// both renderers.
fn is_link_run_char(character: char) -> bool {
    !character.is_whitespace() && !matches!(character, '<' | '>' | '"' | '\'' | '`' | ')' | ']')
}

fn is_link_trailing_char(character: char) -> bool {
    matches!(character, ')' | ',' | '.' | ';' | ':' | '!' | '?')
}

fn prose_link_at(text: &str) -> Option<&str> {
    let prefix =
        prose_autolink_prefixes().find(|prefix| starts_with_ignore_ascii_case(text, prefix))?;
    let run = &text[prefix.len()..];
    let length = run
        .find(|character| !is_link_run_char(character))
        .unwrap_or(run.len());
    if length == 0 {
        return None;
    }
    Some(text[..prefix.len() + length].trim_end_matches(is_link_trailing_char))
}

enum ProsePiece<'text> {
    Text(&'text str),
    Link(&'text str),
}

fn split_prose_links(text: &str) -> Option<Vec<ProsePiece<'_>>> {
    let mut pieces = Vec::new();
    let mut pending = 0;
    let mut cursor = 0;
    while cursor < text.len() {
        let rest = &text[cursor..];
        let Some(href) = prose_link_at(rest) else {
            cursor += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        if pending < cursor {
            pieces.push(ProsePiece::Text(&text[pending..cursor]));
        }
        pieces.push(ProsePiece::Link(href));
        cursor += href.len();
        pending = cursor;
    }
    if pieces.is_empty() {
        return None;
    }
    if pending < text.len() {
        pieces.push(ProsePiece::Text(&text[pending..]));
    }
    Some(pieces)
}

fn autolink_prose<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>) {
    let candidates: Vec<&'a AstNode<'a>> = root
        .descendants()
        .filter(|node| matches!(node.data.borrow().value, NodeValue::Text(_)))
        .filter(|node| {
            !node.ancestors().any(|ancestor| {
                matches!(
                    ancestor.data.borrow().value,
                    NodeValue::Link(_) | NodeValue::Image(_)
                )
            })
        })
        .collect();

    for node in candidates {
        let NodeValue::Text(text) = node.data.borrow().value.clone() else {
            continue;
        };
        let Some(pieces) = split_prose_links(&text) else {
            continue;
        };
        let mut previous: &AstNode = node;
        for piece in pieces {
            let inserted: &AstNode = match piece {
                ProsePiece::Text(text) => {
                    arena.alloc(AstNode::from(NodeValue::Text(Cow::Owned(text.to_owned()))))
                }
                ProsePiece::Link(href) => {
                    let link: &AstNode =
                        arena.alloc(AstNode::from(NodeValue::Link(Box::new(NodeLink {
                            url: href.to_owned(),
                            title: String::new(),
                        }))));
                    link.append(
                        arena.alloc(AstNode::from(NodeValue::Text(Cow::Owned(href.to_owned())))),
                    );
                    link
                }
            };
            previous.insert_after(inserted);
            previous = inserted;
        }
        node.detach();
    }
}

fn mask_blocked_schemes<'a>(root: &'a AstNode<'a>) {
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        let (NodeValue::Link(destination) | NodeValue::Image(destination)) = &mut data.value else {
            continue;
        };
        // An author-written destination must not be able to spell the mask and
        // ride the restore past the formatter's dangerous-url scanner.
        while let Some(rest) = destination.url.strip_prefix(BLOCKED_SCHEME_MASK) {
            destination.url = rest.to_owned();
        }
        if has_transcript_prefix(&destination.url) && dangerous_url(&destination.url) {
            destination.url.insert_str(0, BLOCKED_SCHEME_MASK);
        }
    }
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

    fn markdown(source: &str) -> String {
        render_markdown(&RenderRequest {
            source: source.to_string(),
            theme: HashMap::new(),
        })
        .unwrap()
    }

    #[test]
    fn links_a_bare_scheme_the_parser_leaves_inert() {
        assert_eq!(
            markdown("It landed in file:///Users/dev/notes.md already."),
            concat!(
                "<p>It landed in <a class=\"external-link\" target=\"_blank\" ",
                "rel=\"noopener noreferrer\" href=\"file:///Users/dev/notes.md\">",
                "file:///Users/dev/notes.md</a> already.</p>\n"
            )
        );
        assert!(
            markdown("open vscode://file/Users/dev/notes.md:12 now")
                .contains("href=\"vscode://file/Users/dev/notes.md:12\"")
        );
        assert!(
            markdown("see claxedo://documents/open?id=doc_1 for it")
                .contains("href=\"claxedo://documents/open?id=doc_1\"")
        );
        assert!(
            markdown("write to mailto:dev@example.com").contains("href=\"mailto:dev@example.com\"")
        );
    }

    #[test]
    fn covers_the_closed_list_and_nothing_else() {
        for prefix in TRANSCRIPT_LINK_PREFIXES {
            assert!(
                markdown(&format!("go to {prefix}example.com/path here"))
                    .contains(&format!("href=\"{prefix}example.com/path\"")),
                "{prefix} did not autolink"
            );
        }
        assert_eq!(
            markdown("run javascript:alert(1) never"),
            "<p>run javascript:alert(1) never</p>\n"
        );
        assert!(!markdown("read data:text/html,x never").contains("<a "));
        assert!(!markdown("mount smb://share/x never").contains("<a "));
    }

    #[test]
    fn leaves_the_url_where_the_author_put_it() {
        assert_eq!(
            markdown("`file:///Users/dev/notes.md` stays code"),
            "<p><code>file:///Users/dev/notes.md</code> stays code</p>\n"
        );
        assert!(!markdown("```\nfile:///Users/dev/notes.md\n```").contains("<a "));
        let labelled = markdown("[notes](file:///Users/dev/notes.md)");
        assert!(labelled.contains("href=\"file:///Users/dev/notes.md\">notes</a>"));
        assert_eq!(labelled.matches("<a ").count(), 1);
        let relabelled = markdown("[file:///Users/dev/notes.md](https://example.com)");
        assert!(relabelled.contains("href=\"https://example.com\""));
        assert!(!relabelled.contains("href=\"file://"));
    }

    #[test]
    fn stops_where_the_sentence_does() {
        let sentence = markdown("saved to file:///Users/dev/notes.md.");
        assert!(sentence.contains("href=\"file:///Users/dev/notes.md\""));
        assert!(sentence.contains("notes.md</a>."));
        let parenthesised = markdown("(file:///Users/dev/notes.md)");
        assert!(parenthesised.contains("href=\"file:///Users/dev/notes.md\""));
        assert!(parenthesised.contains("notes.md</a>)"));
    }

    #[test]
    fn keeps_the_parsers_own_autolinking_of_http_and_email() {
        assert!(
            markdown("docs at https://en.wikipedia.org/wiki/Ruby_(gem) here")
                .contains("href=\"https://en.wikipedia.org/wiki/Ruby_(gem)\"")
        );
        assert!(markdown("mail dev@example.com back").contains("href=\"mailto:dev@example.com\""));
        assert!(
            markdown("visit www.example.com today").contains("href=\"http://www.example.com\"")
        );
    }

    #[test]
    fn keeps_prose_order_around_several_links() {
        assert_eq!(
            markdown("Öffne file:///ä, dann *vscode://b* — fertig."),
            concat!(
                "<p>Öffne <a class=\"external-link\" target=\"_blank\" rel=\"noopener noreferrer\" ",
                "href=\"file:///%C3%A4\">file:///ä</a>, dann <em>",
                "<a class=\"external-link\" target=\"_blank\" rel=\"noopener noreferrer\" ",
                "href=\"vscode://b\">vscode://b</a></em> — fertig.</p>\n"
            )
        );
    }

    #[test]
    fn keeps_the_image_sources_the_web_renderer_keeps() {
        assert_eq!(
            markdown("![shot](file:///Users/dev/shot.png)"),
            "<p><img src=\"file:///Users/dev/shot.png\" alt=\"shot\" /></p>\n"
        );
        for prefix in TRANSCRIPT_LINK_PREFIXES {
            assert!(
                markdown(&format!("![shot]({prefix}example.com/shot.png)"))
                    .contains(&format!("src=\"{prefix}example.com/shot.png\"")),
                "{prefix} lost its image source"
            );
        }
        assert!(
            markdown("![x](data:image/png;base64,AAAA)")
                .contains("src=\"data:image/png;base64,AAAA\"")
        );
    }

    #[test]
    fn blanks_an_image_source_off_the_closed_list() {
        for source in [
            "![x](javascript:alert(1))".to_owned(),
            "![x](data:text/html,x)".to_owned(),
            format!("![x]({BLOCKED_SCHEME_MASK}javascript:alert(1))"),
        ] {
            let html = markdown(&source);
            assert!(html.contains("src=\"\""), "{source} kept a source: {html}");
            assert!(!html.contains("javascript:"), "{source} kept the scheme");
            assert!(!html.contains(BLOCKED_SCHEME_MASK), "{source} leaked the mask");
        }
    }

    #[test]
    fn leaves_an_image_literal_where_the_author_put_it() {
        assert_eq!(
            markdown("`![shot](file:///Users/dev/shot.png)` stays code"),
            "<p><code>![shot](file:///Users/dev/shot.png)</code> stays code</p>\n"
        );
        assert!(!markdown("```\n![shot](file:///Users/dev/shot.png)\n```").contains("<img"));
    }

    #[test]
    fn never_leaks_the_blocked_scheme_mask() {
        assert!(!markdown("file:///Users/dev/notes.md").contains(BLOCKED_SCHEME_MASK));
        assert!(!markdown("[notes](file:///Users/dev/notes.md)").contains(BLOCKED_SCHEME_MASK));
        let forged = markdown(&format!("[x]({BLOCKED_SCHEME_MASK}javascript:alert(1))"));
        assert!(forged.contains("href=\"\""));
        assert!(!forged.contains("javascript:"));
    }

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
