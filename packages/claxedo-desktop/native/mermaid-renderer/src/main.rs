use std::collections::HashMap;
use std::env;
use std::io::{self, Read};

use mermaid_rs_renderer::{RenderOptions, render_strict};
use serde::Deserialize;

const MAX_MERMAID_BYTES: usize = 256 * 1024;
// JSON escaping can expand a valid source by up to six bytes per input byte.
// The decoded source limit above remains the authoritative workload bound.
const MAX_REQUEST_BYTES: u64 = 7 * MAX_MERMAID_BYTES as u64;

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
    let mode = env::args().nth(1).ok_or("expected mermaid mode")?;
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
        "mermaid" => render_mermaid(&request)?,
        _ => return Err(format!("unsupported renderer mode: {mode}")),
    };
    print!("{output}");
    Ok(())
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

// Mermaid's base theme derives actor, cluster, edge-label and pie colors from
// these keys; this renderer keeps its light defaults for them unless told.
fn apply_theme(options: &mut RenderOptions, theme: &HashMap<String, String>) {
    let target = &mut options.theme;
    if let Some(value) = theme.get("background") {
        target.background = value.clone();
    }
    if let Some(value) = theme.get("primaryColor").or_else(|| theme.get("mainBkg")) {
        target.primary_color = value.clone();
        target.sequence_actor_fill = value.clone();
    }
    if let Some(value) = theme.get("primaryTextColor") {
        target.primary_text_color = value.clone();
    }
    if let Some(value) = theme
        .get("primaryBorderColor")
        .or_else(|| theme.get("nodeBorder"))
    {
        target.primary_border_color = value.clone();
        target.sequence_actor_border = value.clone();
        target.sequence_actor_line = value.clone();
        target.cluster_border = value.clone();
    }
    if let Some(value) = theme.get("lineColor") {
        target.line_color = value.clone();
    }
    if let Some(value) = theme.get("secondaryColor") {
        target.secondary_color = value.clone();
        target.sequence_activation_fill = value.clone();
        target.edge_label_background = value.clone();
    }
    if let Some(value) = theme.get("tertiaryColor") {
        target.tertiary_color = value.clone();
        target.cluster_background = value.clone();
    }
    if let Some(value) = theme.get("textColor") {
        target.text_color = value.clone();
        target.pie_title_text_color = value.clone();
        target.pie_section_text_color = value.clone();
        target.pie_legend_text_color = value.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mermaid_rs_renderer::Theme;

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

    fn themed(source: &str, theme: &[(&str, &str)]) -> String {
        render_mermaid(&RenderRequest {
            source: source.to_string(),
            theme: theme
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        })
        .unwrap()
    }

    #[test]
    fn draws_sequence_actors_in_the_theme_colors() {
        let svg = themed(
            "sequenceDiagram\nApp->>Server: POST\nServer-->>App: ok",
            &[
                ("primaryColor", "#123456"),
                ("primaryBorderColor", "#abcdef"),
                ("secondaryColor", "#0d0e0f"),
            ],
        );
        assert!(svg.contains("#123456"));
        assert!(svg.contains("#abcdef"));
        for default in ["#EAEAEA", "#666666", "#999999"] {
            assert!(
                !svg.contains(default),
                "{default} kept from the light default theme"
            );
        }
    }

    #[test]
    fn draws_clusters_and_edge_labels_in_the_theme_colors() {
        let svg = themed(
            "flowchart LR\nsubgraph Store\nA -->|commit| B\nend",
            &[
                ("primaryBorderColor", "#abcdef"),
                ("secondaryColor", "#0d0e0f"),
                ("tertiaryColor", "#0a0b0c"),
            ],
        );
        assert!(svg.contains("#0a0b0c"));
        assert!(svg.contains("#0d0e0f"));
        for default in ["#FFFFDE", "#AAAA33", "rgba(248,250,252, 0.92)"] {
            assert!(
                !svg.contains(default),
                "{default} kept from the light default theme"
            );
        }
    }

    #[test]
    fn draws_pie_text_in_the_theme_text_color() {
        let svg = themed(
            "pie title Share\n\"a\" : 1\n\"b\" : 2",
            &[("textColor", "#fedcba")],
        );
        assert!(svg.contains("#fedcba"));
        assert!(!svg.contains(&format!(
            "fill=\"{}\"",
            Theme::mermaid_default().pie_title_text_color
        )));
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
