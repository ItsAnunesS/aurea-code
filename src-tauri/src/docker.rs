use crate::{
    process::{docker_args, run},
    store::{error, Result, Store},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    path::Path,
};

const WORKING_DIR: &str = "com.docker.compose.project.working_dir";
#[derive(Deserialize)]
struct Container {
    #[serde(rename = "ID")]
    id: String,
    #[serde(default)]
    labels: HashMap<String, String>,
    #[serde(flatten)]
    display: serde_json::Map<String, serde_json::Value>,
}
fn belongs_to(container: &Container, root: &Path) -> bool {
    container
        .labels
        .get(WORKING_DIR)
        .and_then(|path| Path::new(path).canonicalize().ok())
        .zip(root.canonicalize().ok())
        .is_some_and(|(directory, root)| directory == root)
}
fn inspect(id: &str, root: &Path) -> Result<Container> {
    docker_args("logs", id)?;
    // Request only presentation fields and ownership metadata, never environment secrets.
    let format = r#"{"ID":{{json .Id}},"Names":{{json .Name}},"Image":{{json .Config.Image}},"State":{{json .State.Status}},"Status":{{json .State.Status}},"Ports":"","labels":{{json .Config.Labels}}}"#;
    let output = run(
        "docker",
        &[
            OsStr::new("inspect"),
            OsStr::new("--type"),
            OsStr::new("container"),
            OsStr::new("--format"),
            OsStr::new(format),
            OsStr::new(id),
        ],
        root,
    )?;
    serde_json::from_str(output.trim()).map_err(error)
}
fn scoped_action(
    root: &Path,
    action: &str,
    id: &str,
    inspect_container: impl FnOnce(&str, &Path) -> Result<Container>,
    execute: impl FnOnce(&[String], &Path) -> Result<String>,
) -> Result<String> {
    docker_args(action, id)?;
    let container = inspect_container(id, root)?;
    if !belongs_to(&container, root) {
        return Err("Este container não pertence ao projeto aberto.".into());
    }
    execute(&docker_args(action, &container.id)?, root)
}
#[tauri::command]
pub async fn docker_action(
    store: tauri::State<'_, Store>,
    project_id: String,
    action: String,
    container: Option<String>,
) -> Result<String> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move || {
        if action == "list" {
            let filter = format!("label={WORKING_DIR}");
            let output = run(
                "docker",
                &[
                    OsStr::new("ps"),
                    OsStr::new("-aq"),
                    OsStr::new("--no-trunc"),
                    OsStr::new("--filter"),
                    OsStr::new(&filter),
                ],
                &root,
            )?;
            let ids: Vec<_> = output.lines().filter(|id| !id.is_empty()).collect();
            if ids.len() > 200 {
                return Err("Demasiados containers para consultar (limite: 200).".into());
            }
            let mut result = Vec::new();
            for id in ids {
                let container = inspect(id, &root)?;
                if belongs_to(&container, &root) {
                    let mut display = container.display;
                    display.insert("ID".into(), container.id.into());
                    result.push(serde_json::to_string(&display).map_err(error)?);
                }
            }
            Ok(result.join("\n"))
        } else {
            scoped_action(
                &root,
                &action,
                container.as_deref().unwrap_or(""),
                inspect,
                |args, root| {
                    run(
                        "docker",
                        &args.iter().map(OsStr::new).collect::<Vec<_>>(),
                        root,
                    )
                },
            )
        }
    })
    .await
    .map_err(error)?
}
pub fn compose_args(root: &Path) -> Result<Vec<OsString>> {
    let file = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .iter()
    .map(|name| root.join(name))
    .find(|file| file.is_file())
    .ok_or("Não existe um ficheiro Compose na raiz deste projeto.")?;
    Ok(vec![
        "compose".into(),
        "--project-directory".into(),
        root.as_os_str().into(),
        "-f".into(),
        file.into_os_string(),
        "up".into(),
        "--build".into(),
    ])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_uses_full_directory_and_rejects_unlabelled_containers() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut container = Container {
            id: "a".repeat(64),
            labels: HashMap::new(),
            display: Default::default(),
        };
        assert!(!belongs_to(&container, root.path()));
        container
            .labels
            .insert(WORKING_DIR.into(), other.path().to_string_lossy().into());
        assert!(scoped_action(
            root.path(),
            "stop",
            &"a".repeat(64),
            |_, _| Ok(container),
            |_, _| panic!("foreign container must never be stopped")
        )
        .is_err());
        let container = Container {
            id: "a".repeat(64),
            labels: HashMap::from([(WORKING_DIR.into(), root.path().to_string_lossy().into())]),
            display: Default::default(),
        };
        assert!(belongs_to(&container, root.path()));
    }
    #[test]
    fn compose_does_not_discover_parent_projects() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("compose.yaml"), "services: {}").unwrap();
        let child = root.path().join("child");
        std::fs::create_dir(&child).unwrap();
        assert!(compose_args(&child).is_err());
        assert!(compose_args(root.path())
            .unwrap()
            .contains(&root.path().join("compose.yaml").into_os_string()));
    }
}
