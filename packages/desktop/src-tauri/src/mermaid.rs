use std::process::Command;

#[tauri::command]
#[specta::specta]
pub async fn render_mermaid_command(source: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || render_mermaid(&source))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

fn render_mermaid(source: &str) -> Result<String, String> {
    let mut child = Command::new("mmdr")
        .args(["-e", "svg"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run mmdr: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(source.as_bytes())
            .map_err(|e| format!("Failed to write to mmdr: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for mmdr: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("mmdr failed: {}", stderr.trim()));
    }

    let svg = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 from mmdr: {e}"))?;

    Ok(svg)
}
