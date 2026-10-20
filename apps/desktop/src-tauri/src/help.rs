use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HelpTopic {
    pub id: String,
    pub label: String,
    #[serde(rename = "labelKey")]
    pub label_key: Option<String>,
    pub file: Option<String>,
    pub children: Option<Vec<HelpTopic>>,
}

fn get_embedded_help_file(name: &str) -> Option<&'static str> {
    match name {
        "archives.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/archives.md"
        )),
        "columns.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/columns.md"
        )),
        "copy_move.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/copy_move.md"
        )),
        "delete.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/delete.md"
        )),
        "intro.de.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/intro.de.md"
        )),
        "intro.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/intro.md"
        )),
        "intro.nl.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/intro.nl.md"
        )),
        "layout.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/layout.md"
        )),
        "mkdir.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/mkdir.md"
        )),
        "multi_rename.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/multi_rename.md"
        )),
        "options.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/options.md"
        )),
        "search.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/search.md"
        )),
        "selection.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/selection.md"
        )),
        "shortcuts.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/shortcuts.md"
        )),
        "tech-support.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/tech-support.md"
        )),
        "themes.md" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/themes.md"
        )),
        "topics.json" => Some(include_str!(
            "../../../../packages/ui/src/lib/help/topics.json"
        )),
        _ => None,
    }
}

#[tauri::command]
pub fn get_help_topics() -> Result<Vec<HelpTopic>, String> {
    let content = get_embedded_help_file("topics.json")
        .ok_or_else(|| "Failed to load topics.json: not embedded".to_string())?;
    let topics: Vec<HelpTopic> =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse topics.json: {}", e))?;
    Ok(topics)
}

#[tauri::command]
pub fn get_help_content(file_name: String, lang: Option<String>) -> Result<String, String> {
    // Try translated version if a language is provided (e.g., intro.de.md)
    if let Some(l) = lang {
        let l_short = l.split('_').next().unwrap_or(&l); // en_US -> en
        let translated_name = file_name.replace(".md", &format!(".{}.md", l_short));
        if let Some(content) = get_embedded_help_file(&translated_name) {
            return Ok(content.to_string());
        }
    }

    // Default to base file
    let content = get_embedded_help_file(&file_name)
        .ok_or_else(|| format!("Help file not found: {}", file_name))?;
    Ok(content.to_string())
}
