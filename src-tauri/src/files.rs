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
// Atomic no-replace publication: a concurrent destination must never be overwritten.
#[cfg(target_os = "linux")]
fn rename_new(source: &Path, destination: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renameat2(
            old_dir: i32,
            old: *const std::ffi::c_char,
            new_dir: i32,
            new: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let source = CString::new(source.as_os_str().as_bytes()).map_err(error)?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(error)?;
    // AT_FDCWD and RENAME_NOREPLACE; both strings remain alive during the call.
    if unsafe { renameat2(-100, source.as_ptr(), -100, destination.as_ptr(), 1) } != 0 {
        return Err(error(std::io::Error::last_os_error()));
    }
    Ok(())
}
#[cfg(target_os = "windows")]
fn rename_new(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination).map_err(error)
}
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn rename_new(_source: &Path, _destination: &Path) -> Result<()> {
    Err("File transfers are not supported on this platform.".into())
}

fn inspect_transfer(path: &Path, count: &mut usize, bytes: &mut u64, depth: usize) -> Result<()> {
    *count += 1;
    if *count > 10_000 || depth > 100 {
        return Err("Transfer exceeds the limit of 10,000 entries or 100 folder levels.".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
        return Err("Transfers cannot include symbolic links or special files.".into());
    }
    if path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case(".git")
    }) {
        return Err("Transfers cannot include protected .git folders.".into());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(error)? {
            inspect_transfer(&entry.map_err(error)?.path(), count, bytes, depth + 1)?;
        }
    } else {
        *bytes = bytes.saturating_add(metadata.len());
        if *bytes > 1024 * 1024 * 1024 {
            return Err("Transfer exceeds the 1 GiB limit.".into());
        }
    }
    Ok(())
}
fn copy_entry(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(error)?;
    if metadata.is_dir() {
        fs::create_dir(destination).map_err(error)?;
        for entry in fs::read_dir(source).map_err(error)? {
            let entry = entry.map_err(error)?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() && !metadata.file_type().is_symlink() {
        fs::copy(source, destination).map_err(error)?;
    } else {
        return Err("Transfers cannot include symbolic links or special files.".into());
    }
    Ok(())
}
pub fn transfer_path(root: &Path, source: &str, destination: &str, copy: bool) -> Result<String> {
    if source.is_empty() {
        return Err("The project root cannot be transferred.".into());
    }
    let source_path = scoped_path(root, source)?;
    let target = scoped_path(root, destination)?;
    if !target.is_dir() {
        return Err("Choose a destination folder.".into());
    }
    if target.starts_with(&source_path) {
        return Err("A folder cannot be transferred into itself.".into());
    }
    let name = source_path.file_name().ok_or("Invalid source.")?;
    let mut output = target.join(name);
    // Copying alongside the original creates a unique sibling, as in an IDE explorer.
    if copy && source_path.parent() == Some(target.as_path()) {
        let name = name.to_string_lossy();
        let mut found = false;
        for index in 1..=1000 {
            let suffix = if index == 1 {
                " copy".to_string()
            } else {
                format!(" copy {index}")
            };
            let candidate = if source_path.is_file() {
                let stem = source_path.file_stem().unwrap().to_string_lossy();
                let extension = source_path
                    .extension()
                    .map(|value| format!(".{}", value.to_string_lossy()))
                    .unwrap_or_default();
                format!("{stem}{suffix}{extension}")
            } else {
                format!("{name}{suffix}")
            };
            output = target.join(candidate);
            if !output.try_exists().map_err(error)? {
                found = true;
                break;
            }
        }
        if !found {
            return Err("Unable to find an available copy name.".into());
        }
    }
    if output.try_exists().map_err(error)? {
        return Err("The destination already exists. No files were replaced.".into());
    }
    inspect_transfer(&source_path, &mut 0, &mut 0, 0)?;
    if copy {
        let staging = tempfile::tempdir_in(&target).map_err(error)?;
        let staged = staging.path().join("content");
        copy_entry(&source_path, &staged)?;
        rename_new(&staged, &output)?;
    } else {
        rename_new(&source_path, &output)?;
    }
    Ok(output
        .strip_prefix(root.canonicalize().map_err(error)?)
        .map_err(error)?
        .to_string_lossy()
        .into_owned())
}
#[tauri::command]
pub async fn transfer_entry(
    store: tauri::State<'_, Store>,
    project_id: String,
    source: String,
    destination: String,
    copy: bool,
) -> Result<String> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move || transfer_path(&root, &source, &destination, copy))
        .await
        .map_err(error)?
}
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.contains(['/', '\\', ':', '\0'])
        || name.ends_with(['.', ' '])
        || name == "."
        || name == ".."
        || name.eq_ignore_ascii_case(".git")
        || name.chars().any(char::is_control)
    {
        return Err("Enter a single valid file or folder name.".into());
    }
    Ok(())
}
fn inspect_deletion(path: &Path, count: &mut usize, depth: usize) -> Result<()> {
    *count += 1;
    if *count > 100_000 || depth > 100 {
        return Err("Deletion exceeds 100,000 entries or 100 folder levels.".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("Deletion cannot include symbolic links or special files.".into());
    }
    if path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case(".git")
    }) {
        return Err("Deletion cannot include protected .git folders.".into());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(error)? {
            inspect_deletion(&entry.map_err(error)?.path(), count, depth + 1)?;
        }
    }
    Ok(())
}
pub fn delete_path(root: &Path, relative: &str) -> Result<()> {
    let path = scoped_path(root, relative)?;
    if path == root.canonicalize().map_err(error)? {
        return Err("The project root cannot be deleted.".into());
    }
    inspect_deletion(&path, &mut 0, 0)?;
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(error)
    } else {
        fs::remove_file(path).map_err(error)
    }
}
#[tauri::command]
pub async fn delete_entry(
    store: tauri::State<'_, Store>,
    project_id: String,
    relative: String,
) -> Result<()> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move || delete_path(&root, &relative))
        .await
        .map_err(error)?
}

pub fn rename_path(root: &Path, source: &str, name: &str) -> Result<String> {
    validate_name(name)?;
    if source.is_empty() {
        return Err("The project root cannot be renamed.".into());
    }
    let path = scoped_path(root, source)?;
    let output = path.parent().ok_or("Invalid source.")?.join(name);
    if path == output {
        return Ok(source.to_string());
    }
    rename_new(&path, &output)?;
    Ok(output
        .strip_prefix(root.canonicalize().map_err(error)?)
        .map_err(error)?
        .to_string_lossy()
        .into_owned())
}
#[tauri::command]
pub fn rename_entry(
    store: tauri::State<Store>,
    project_id: String,
    source: String,
    name: String,
) -> Result<String> {
    rename_path(&store.project(&project_id)?.path, &source, &name)
}
#[tauri::command]
pub fn create_folder(
    store: tauri::State<Store>,
    project_id: String,
    parent: String,
    name: String,
) -> Result<()> {
    validate_name(&name)?;
    fs::create_dir(scoped_path(&store.project(&project_id)?.path, &parent)?.join(name))
        .map_err(error)
}
pub fn read_preview(root: &Path, relative: &str) -> Result<Vec<u8>> {
    let path = scoped_path(root, relative)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "pdf",
    ]
    .contains(&extension.as_str())
    {
        return Err("This file type does not support a media preview.".into());
    }
    let file = fs::File::open(path).map_err(error)?;
    if !file.metadata().map_err(error)?.is_file() {
        return Err("Not a regular file.".into());
    }
    let mut bytes = Vec::new();
    file.take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Media previews support files up to 20 MiB.".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn read_media(
    store: tauri::State<'_, Store>,
    project_id: String,
    relative: String,
) -> Result<tauri::ipc::Response> {
    let root = store.project(&project_id)?.path;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_preview(&root, &relative))
        .await
        .map_err(error)??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deletes_files_and_folders_but_preserves_protected_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("folder/nested")).unwrap();
        fs::write(root.join("folder/nested/file.txt"), "contents").unwrap();
        fs::write(root.join("keep.txt"), "keep").unwrap();
        assert!(delete_path(root, "").is_err());
        assert!(delete_path(root, "../outside").is_err());
        fs::create_dir_all(root.join("repository/.git")).unwrap();
        assert!(delete_path(root, "repository/.git").is_err());
        assert!(delete_path(root, "repository").is_err());
        assert!(root.join("repository/.git").exists());
        delete_path(root, "folder").unwrap();
        assert!(!root.join("folder").exists());
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep");
        delete_path(root, "keep.txt").unwrap();
        assert!(delete_path(root, "keep.txt").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn deletion_rejects_nested_symlinks_without_touching_targets() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        fs::create_dir(directory.path().join("folder")).unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("folder/link")).unwrap();
        assert!(delete_path(directory.path(), "folder/link").is_err());
        assert!(delete_path(directory.path(), "folder").is_err());
        assert!(outside.path().join("keep.txt").exists());
        assert!(directory.path().join("folder/link").exists());
    }
    #[test]
    fn rename_preserves_data_and_rejects_invalid_names_and_collisions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "content").unwrap();
        assert_eq!(rename_path(root, "src/a.txt", "b.rs").unwrap(), "src/b.rs");
        assert_eq!(
            fs::read_to_string(root.join("src/b.rs")).unwrap(),
            "content"
        );
        fs::write(root.join("src/taken.rs"), "existing").unwrap();
        for name in [
            "taken.rs",
            "../outside",
            ".git",
            "a/b",
            "a\\b",
            ".",
            "..",
            "",
            "bad.",
        ] {
            assert!(rename_path(root, "src/b.rs", name).is_err(), "{name}");
        }
        assert!(rename_path(root, "", "renamed").is_err());
        assert_eq!(rename_path(root, "src", "lib").unwrap(), "lib");
        assert_eq!(
            fs::read_to_string(root.join("lib/b.rs")).unwrap(),
            "content"
        );
    }
    #[test]
    fn preview_is_bounded_and_project_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("image.webp"), [0, 1, 2]).unwrap();
        assert_eq!(read_preview(root, "image.webp").unwrap(), [0, 1, 2]);
        fs::write(root.join("script.html"), "<script></script>").unwrap();
        assert!(read_preview(root, "script.html").is_err());
        assert!(read_preview(root, "../outside.pdf").is_err());
        fs::File::create(root.join("large.pdf"))
            .unwrap()
            .set_len(20 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_preview(root, "large.pdf").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("link.svg")).unwrap();
            assert!(read_preview(root, "link.svg").is_err());
        }
    }
    #[test]
    fn transfers_nested_folders_and_duplicates_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir(root.join("dest")).unwrap();
        fs::write(root.join("src/nested/a.bin"), [0, 1, 2]).unwrap();
        assert_eq!(
            transfer_path(root, "src", "dest", true).unwrap(),
            "dest/src"
        );
        assert!(root.join("src/nested/a.bin").exists());
        assert_eq!(
            fs::read(root.join("dest/src/nested/a.bin")).unwrap(),
            [0, 1, 2]
        );
        assert!(transfer_path(root, "src", "dest", false).is_err());
        assert_eq!(transfer_path(root, "src", "", true).unwrap(), "src copy");
        assert_eq!(transfer_path(root, "src", "", true).unwrap(), "src copy 2");
        assert_eq!(
            transfer_path(root, "src/nested/a.bin", "", false).unwrap(),
            "a.bin"
        );
        assert!(!root.join("src/nested/a.bin").exists());
        assert_eq!(
            transfer_path(root, "a.bin", "", true).unwrap(),
            "a copy.bin"
        );
    }
    #[test]
    fn rejects_invalid_transfers_before_mutating() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        for copy in [false, true] {
            assert!(transfer_path(root, "", "src", copy).is_err());
            assert!(transfer_path(root, "src", "src/nested", copy).is_err());
            assert!(transfer_path(root, "src", "../outside", copy).is_err());
            assert!(transfer_path(root, "../outside", "", copy).is_err());
        }
        fs::create_dir(root.join("src/.git")).unwrap();
        assert!(transfer_path(root, "src", "", true).is_err());
        assert!(!root.join("src copy").exists());
    }
    #[cfg(unix)]
    #[test]
    fn transfer_rejects_nested_links_and_destination_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("src")).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("src/link")).unwrap();
        assert!(transfer_path(root, "src", "", true).is_err());
        assert!(!root.join("src copy").exists());
        assert!(transfer_path(root, "src", "src/link", false).is_err());
    }
    #[test]
    fn publication_never_replaces_an_existing_file_or_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a"), "source").unwrap();
        fs::write(root.join("b"), "destination").unwrap();
        assert!(rename_new(&root.join("a"), &root.join("b")).is_err());
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "destination");
        fs::create_dir(root.join("first")).unwrap();
        fs::create_dir(root.join("second")).unwrap();
        assert!(rename_new(&root.join("first"), &root.join("second")).is_err());
    }
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
