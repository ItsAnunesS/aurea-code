use crate::{
    process::{config_query, require_repository_root, run},
    store::{error, Result, Store},
};
use serde::Serialize;
use std::{ffi::OsStr, path::Path};
const KEYS: [&str; 6] = [
    "user.name",
    "user.email",
    "init.defaultBranch",
    "core.autocrlf",
    "fetch.prune",
    "pull.ff",
];
const PATTERN: &str =
    "^(user\\.(name|email)|init\\.defaultbranch|core\\.autocrlf|fetch\\.prune|pull\\.ff)$";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    key: String,
    global_value: Option<String>,
    project_value: Option<String>,
    effective_value: Option<String>,
    source: String,
}
fn query(root: &Path, scope: Option<&str>) -> Result<Vec<(String, String, String)>> {
    let mut args = vec![
        "config",
        "--includes",
        "--null",
        "--show-origin",
        "--show-scope",
    ];
    if let Some(scope) = scope {
        args.push(scope);
    }
    args.extend(["--get-regexp", PATTERN]);
    let output = config_query(&args.iter().map(OsStr::new).collect::<Vec<_>>(), root)?;
    let fields: Vec<_> = output.split('\0').collect();
    Ok(fields
        .chunks(3)
        .filter(|row| row.len() == 3)
        .filter_map(|row| {
            row[2].split_once('\n').map(|(key, value)| {
                (
                    key.to_string(),
                    value.to_string(),
                    format!("{} · {}", row[0], row[1]),
                )
            })
        })
        .collect())
}
pub fn read(root: &Path, project: bool) -> Result<Vec<Setting>> {
    if project {
        require_repository_root(root)?;
    }
    let global = query(root, Some("--global"))?;
    let local = if project {
        query(root, Some("--local"))?
    } else {
        Vec::new()
    };
    let effective = query(root, if project { None } else { Some("--global") })?;
    Ok(KEYS
        .iter()
        .map(|key| {
            let find = |rows: &Vec<(String, String, String)>| {
                rows.iter()
                    .rev()
                    .find(|row| row.0.eq_ignore_ascii_case(key))
                    .cloned()
            };
            let current = find(&effective);
            Setting {
                key: key.to_string(),
                global_value: find(&global).map(|row| row.1),
                project_value: find(&local).map(|row| row.1),
                effective_value: current.as_ref().map(|row| row.1.clone()),
                source: current
                    .map(|row| row.2)
                    .unwrap_or_else(|| "Git default".into()),
            }
        })
        .collect())
}
pub fn write(root: &Path, scope: &str, key: &str, value: &str) -> Result<()> {
    if !KEYS.contains(&key) || !["global", "project"].contains(&scope) {
        return Err("Unsupported Git setting or scope.".into());
    }
    if scope == "project" {
        require_repository_root(root)?;
    }
    if value.len() > 512 || value.chars().any(char::is_control) {
        return Err("Enter a value shorter than 512 characters without control characters.".into());
    }
    if !value.is_empty() {
        let valid = match key {
            "core.autocrlf" => ["true", "false", "input"].contains(&value),
            "fetch.prune" => ["true", "false"].contains(&value),
            "pull.ff" => ["true", "false", "only"].contains(&value),
            "init.defaultBranch" => {
                !value.starts_with('-')
                    && run(
                        "git",
                        &[
                            OsStr::new("check-ref-format"),
                            OsStr::new(&format!("refs/heads/{value}")),
                        ],
                        root,
                    )
                    .is_ok()
            }
            _ => !value.trim().is_empty(),
        };
        if !valid {
            return Err("Invalid value for this Git setting.".into());
        }
    }
    let flag = if scope == "global" {
        "--global"
    } else {
        "--local"
    };
    if value.is_empty()
        && !query(root, Some(flag))?
            .iter()
            .any(|row| row.0.eq_ignore_ascii_case(key))
    {
        return Ok(());
    }
    let mut args = vec![
        "config",
        flag,
        if value.is_empty() {
            "--unset-all"
        } else {
            "--replace-all"
        },
        key,
    ];
    if !value.is_empty() {
        args.push(value);
    }
    run(
        "git",
        &args.iter().map(OsStr::new).collect::<Vec<_>>(),
        root,
    )
    .map(|_| ())
}
#[tauri::command]
pub async fn git_settings_read(
    store: tauri::State<'_, Store>,
    project_id: Option<String>,
) -> Result<Vec<Setting>> {
    let project = project_id.is_some();
    let root = if let Some(id) = project_id {
        store.project(&id)?.path
    } else {
        std::env::temp_dir()
    };
    tauri::async_runtime::spawn_blocking(move || read(&root, project))
        .await
        .map_err(error)?
}
#[tauri::command]
pub async fn git_setting_write(
    store: tauri::State<'_, Store>,
    project_id: Option<String>,
    scope: String,
    key: String,
    value: String,
) -> Result<()> {
    let root = if let Some(id) = project_id {
        store.project(&id)?.path
    } else if scope == "global" {
        std::env::temp_dir()
    } else {
        return Err("Open a project first.".into());
    };
    tauri::async_runtime::spawn_blocking(move || write(&root, &scope, &key, &value))
        .await
        .map_err(error)?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_settings_override_inheritance_without_changing_global_identity() {
        let root = tempfile::tempdir().unwrap();
        run("git", &[OsStr::new("init")], root.path()).unwrap();
        let original = read(root.path(), true)
            .unwrap()
            .into_iter()
            .find(|item| item.key == "user.name")
            .unwrap()
            .global_value;
        write(root.path(), "project", "user.name", "Project Author").unwrap();
        let setting = read(root.path(), true)
            .unwrap()
            .into_iter()
            .find(|item| item.key == "user.name")
            .unwrap();
        assert_eq!(setting.effective_value.as_deref(), Some("Project Author"));
        assert_eq!(setting.global_value, original);
        write(root.path(), "project", "user.name", "").unwrap();
        assert!(read(root.path(), true)
            .unwrap()
            .into_iter()
            .find(|item| item.key == "user.name")
            .unwrap()
            .project_value
            .is_none());
        assert!(write(root.path(), "project", "core.hooksPath", "/tmp").is_err());
        assert!(write(root.path(), "project", "fetch.prune", "invalid").is_err());
        assert!(write(root.path(), "project", "user.email", "bad\nemail").is_err());
    }
}
