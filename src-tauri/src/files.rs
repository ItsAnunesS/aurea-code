use crate::store::{atomic_write, error, Result, Store};
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
pub const MAX_FILE: u64 = 2 * 1024 * 1024;

// Reject traversal and symbolic links instead of allowing the editor to leave the project.
pub fn scoped_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root.canonicalize().map_err(error)?;
    let mut path = root.clone();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part)
                if !part
                    .to_string_lossy()
                    .trim_end_matches(['.', ' '])
                    .eq_ignore_ascii_case(".git") =>
            {
                path.push(part)
            }
            _ => return Err("Path is outside the project or protected.".into()),
        }
        if fs::symlink_metadata(&path)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err("The editor does not open symbolic links.".into());
        }
    }
    let path = path.canonicalize().map_err(error)?;
    if !path.starts_with(root) {
        return Err("Path is outside the project.".into());
    }
    Ok(path)
}
#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}
#[tauri::command]
pub fn list_files(
    store: tauri::State<Store>,
    project_id: String,
    relative: String,
) -> Result<Vec<FileEntry>> {
    let project = store.project(&project_id)?;
    let directory = scoped_path(&project.path, &relative)?;
    let mut entries = vec![];
    for (index, entry) in fs::read_dir(directory).map_err(error)?.enumerate() {
        if index >= 2000 {
            return Err("Folder is too large for the explorer (limit: 2000 entries).".into());
        }
        let entry = entry.map_err(error)?;
        let kind = entry.file_type().map_err(error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() || [".git", "node_modules", "target"].contains(&name.as_str()) {
            continue;
        }
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        entries.push(FileEntry {
            name,
            path: entry
                .path()
                .strip_prefix(&project.path)
                .map_err(error)?
                .to_string_lossy()
                .into_owned(),
            directory: kind.is_dir(),
        });
    }
    if entries.len() > 2000 {
        return Err("Folder is too large for the explorer (limit: 2000 entries).".into());
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
pub fn read_text(path: &Path) -> Result<String> {
    let file = fs::File::open(path).map_err(error)?;
    if !file.metadata().map_err(error)?.is_file() {
        return Err("Not a regular file.".into());
    }
    let mut bytes = vec![];
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("The editor supports files up to 2 MiB.".into());
    }
    if bytes.contains(&0) {
        return Err("The editor does not support binary files.".into());
    }
    String::from_utf8(bytes).map_err(|_| "The editor only supports UTF-8 text.".into())
}
#[tauri::command]
pub fn read_file(
    store: tauri::State<Store>,
    project_id: String,
    relative: String,
) -> Result<String> {
    read_text(&scoped_path(&store.project(&project_id)?.path, &relative)?)
}
pub fn save_text(root: &Path, relative: &str, content: &str, original: &str) -> Result<()> {
    if content.len() as u64 > MAX_FILE {
        return Err("File is too large.".into());
    }
    let path = scoped_path(root, relative)?;
    if read_text(&path)? != original {
        return Err("The file changed on disk. Reopen it to review changes before saving.".into());
    }
    atomic_write(&path, content.as_bytes())
}
pub fn create_text_file(root: &Path, relative: &str) -> Result<()> {
    let relative = Path::new(relative);
    let filename = relative.file_name().ok_or("Invalid filename.")?;
    if filename
        .to_string_lossy()
        .trim_end_matches(['.', ' '])
        .eq_ignore_ascii_case(".git")
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Path is outside the project or protected.".into());
    }
    let parent = relative.parent().unwrap_or(Path::new(""));
    let path = scoped_path(root, &parent.to_string_lossy())?.join(filename);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(error)?;
    Ok(())
}
#[tauri::command]
pub fn create_file(store: tauri::State<Store>, project_id: String, relative: String) -> Result<()> {
    create_text_file(&store.project(&project_id)?.path, &relative)
}
#[tauri::command]
pub fn save_file(
    store: tauri::State<Store>,
    project_id: String,
    relative: String,
    content: String,
    original: String,
) -> Result<()> {
    save_text(
        &store.project(&project_id)?.path,
        &relative,
        &content,
        &original,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_files_without_overwriting_or_escaping() {
        let directory = tempfile::tempdir().unwrap();
        create_text_file(directory.path(), "new.rs").unwrap();
        assert!(directory.path().join("new.rs").is_file());
        assert!(create_text_file(directory.path(), "new.rs").is_err());
        assert!(create_text_file(directory.path(), "../outside.rs").is_err());
        assert!(create_text_file(directory.path(), ".git").is_err());
    }
    #[test]
    fn blocks_escape_and_protected_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "hello").unwrap();
        assert!(scoped_path(dir.path(), "../file.txt").is_err());
        assert!(scoped_path(dir.path(), "/etc/passwd").is_err());
        assert!(scoped_path(dir.path(), ".git/config").is_err());
        assert!(scoped_path(dir.path(), ".GIT/config").is_err());
        assert!(scoped_path(dir.path(), ".git./config").is_err());
        assert!(scoped_path(dir.path(), "file.txt").is_ok());
    }
    #[test]
    fn refuses_to_overwrite_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "external").unwrap();
        assert!(save_text(dir.path(), "a.txt", "mine", "old").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        save_text(dir.path(), "a.txt", "mine", "external").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "mine");
    }
    #[test]
    fn rejects_binary_and_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a");
        fs::write(&path, [0, 1]).unwrap();
        assert!(read_text(&path).is_err());
        fs::write(&path, vec![b'a'; MAX_FILE as usize + 1]).unwrap();
        assert!(read_text(&path).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc", dir.path().join("escape")).unwrap();
        assert!(scoped_path(dir.path(), "escape/passwd").is_err());
    }
}
