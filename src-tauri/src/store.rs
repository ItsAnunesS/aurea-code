use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub workspace_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Database {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    pub projects: Vec<Project>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<crate::database::ConnectionConfig>,
}
impl Default for Database {
    fn default() -> Self {
        Self {
            version: 1,
            workspaces: vec![Workspace {
                id: id(),
                name: "Personal".into(),
            }],
            projects: vec![],
            connections: vec![],
        }
    }
}
pub struct Store {
    pub directory: PathBuf,
    pub db: Mutex<Database>,
}
impl Store {
    pub fn open(directory: PathBuf) -> Result<Self> {
        private_directory(&directory)?;
        let path = directory.join("workspace.json");
        let db: Database = if path.exists() {
            serde_json::from_slice(&fs::read(path).map_err(error)?)
                .map_err(|e| format!("Unable to read workspaces: {e}"))?
        } else {
            Database::default()
        };
        if db.version != 1 {
            return Err("Unsupported data version. Update the app.".into());
        }
        Ok(Self {
            directory,
            db: Mutex::new(db),
        })
    }
    pub fn snapshot(&self) -> Result<Database> {
        Ok(self.db.lock().map_err(error)?.clone())
    }
    pub fn update(&self, action: impl FnOnce(&mut Database) -> Result<()>) -> Result<Database> {
        let mut guard = self.db.lock().map_err(error)?;
        let mut next = guard.clone();
        action(&mut next)?;
        atomic_write(
            &self.directory.join("workspace.json"),
            &serde_json::to_vec_pretty(&next).map_err(error)?,
        )?;
        *guard = next.clone();
        Ok(next)
    }
    pub fn project(&self, project_id: &str) -> Result<Project> {
        self.db
            .lock()
            .map_err(error)?
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or("Project not found.".into())
    }
}
pub fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err("Use a name between 1 and 80 characters.".into());
    }
    Ok(value.into())
}
pub fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    Ok(())
}
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Invalid directory.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(error)?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(error)?;
    }
    temporary.write_all(content).map_err(error)?;
    temporary.as_file().sync_all().map_err(error)?;
    temporary.persist(path).map_err(error)?;
    Ok(())
}

#[tauri::command]
pub fn load_workspace(store: tauri::State<Store>) -> Result<Database> {
    store.snapshot()
}
#[tauri::command]
pub fn create_workspace(store: tauri::State<Store>, title: String) -> Result<Database> {
    let title = name(&title)?;
    store.update(|db| {
        db.workspaces.push(Workspace {
            id: id(),
            name: title,
        });
        Ok(())
    })
}
#[tauri::command]
pub fn add_project(
    store: tauri::State<Store>,
    workspace_id: String,
    path: PathBuf,
) -> Result<Database> {
    let path = path.canonicalize().map_err(error)?;
    if !path.is_dir() {
        return Err("Select an existing folder.".into());
    }
    let title = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    store.update(|db| {
        if !db.workspaces.iter().any(|w| w.id == workspace_id) {
            return Err("Workspace not found.".into());
        }
        if db
            .projects
            .iter()
            .any(|p| p.workspace_id == workspace_id && p.path == path)
        {
            return Err("This project is already in the workspace.".into());
        }
        db.projects.push(Project {
            id: id(),
            name: title,
            path,
            workspace_id,
        });
        Ok(())
    })
}
#[tauri::command]
pub fn remove_project(store: tauri::State<Store>, project_id: String) -> Result<Database> {
    store.update(|db| {
        db.projects.retain(|p| p.id != project_id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updates_persist_and_failed_updates_roll_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        store
            .update(|db| {
                db.workspaces[0].name = "Work".into();
                Ok(())
            })
            .unwrap();
        assert!(store
            .update(|db| {
                db.workspaces.clear();
                Err("failed".into())
            })
            .is_err());
        assert_eq!(
            Store::open(dir.path().to_path_buf())
                .unwrap()
                .snapshot()
                .unwrap()
                .workspaces[0]
                .name,
            "Work"
        );
        assert_eq!(store.snapshot().unwrap().workspaces.len(), 1);
    }
    #[test]
    fn existing_workspaces_survive_obsolete_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let project_path = dir.path().join("project");
        let legacy = serde_json::json!({
            "version": 1,
            "workspaces": [{"id": "work", "name": "Work", "profile_ids": ["old"]}],
            "profiles": [{"id": "old", "name": "Legacy", "provider": "retired"}],
            "projects": [{"id": "project", "name": "Project", "path": project_path, "workspace_id": "work"}]
        });
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.snapshot().unwrap().workspaces[0].name, "Work");
        assert_eq!(store.project("project").unwrap().path, project_path);
        store
            .update(|db| {
                db.workspaces[0].name = "Renamed".into();
                Ok(())
            })
            .unwrap();
        let reloaded = Store::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.snapshot().unwrap().workspaces[0].name, "Renamed");
        assert_eq!(reloaded.project("project").unwrap().workspace_id, "work");
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(saved.get("profiles").is_none());
        assert!(saved["workspaces"][0].get("profile_ids").is_none());
    }
    #[test]
    fn validates_names() {
        assert!(name("  ").is_err());
        assert!(name("line\nbreak").is_err());
        assert_eq!(name(" Project ").unwrap(), "Project");
    }
}
