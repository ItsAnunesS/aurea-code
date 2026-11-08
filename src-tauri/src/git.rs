use crate::{
    process::{require_repository_root, run},
    store::{error, Result, Store},
};
use serde::Serialize;
use std::{
    ffi::OsStr,
    path::{Component, Path},
};
pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut command = vec![OsStr::new("--no-pager")];
    command.extend(args.iter().map(OsStr::new));
    run("git", &command, root)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    original_path: Option<String>,
    index: String,
    worktree: String,
}
#[derive(Serialize)]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    date: String,
    subject: String,
}
#[derive(Serialize)]
pub struct Stash {
    reference: String,
    hash: String,
    subject: String,
}
#[derive(Serialize)]
pub struct Snapshot {
    branch: String,
    changes: Vec<Change>,
    commits: Vec<Commit>,
    stashes: Vec<Stash>,
    repository: crate::git_remote::Repository,
}
fn changes(status: &str) -> Result<(String, Vec<Change>)> {
    let mut records = status.split('\0').filter(|record| !record.is_empty());
    let branch = records
        .next()
        .ok_or("Missing Git status.")?
        .strip_prefix("## ")
        .ok_or("Invalid Git status.")?
        .to_string();
    let mut result = Vec::new();
    for_record(&mut records, &mut result)?;
    Ok((branch, result))
}
fn for_record<'a>(
    records: &mut impl Iterator<Item = &'a str>,
    result: &mut Vec<Change>,
) -> Result<()> {
    while let Some(record) = records.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 4 || !bytes[0].is_ascii() || !bytes[1].is_ascii() {
            return Err("Invalid Git status record.".into());
        }
        let original_path = if bytes[..2].iter().any(|b| *b == b'R' || *b == b'C') {
            Some(records.next().ok_or("Incomplete Git rename.")?.to_string())
        } else {
            None
        };
        result.push(Change {
            path: record[3..].to_string(),
            original_path,
            index: (bytes[0] as char).to_string(),
            worktree: (bytes[1] as char).to_string(),
        });
    }
    Ok(())
}
pub fn snapshot(root: &Path) -> Result<Snapshot> {
    require_repository_root(root)?;
    let (branch, changes) = changes(&git(root, &["status", "--porcelain=v1", "--branch", "-z"])?)?;
    let mut commits = Vec::new();
    if git(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        let log = git(
            root,
            &["log", "-100", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00"],
        )?;
        let fields: Vec<_> = log.split('\0').collect();
        for row in fields.chunks(5).filter(|row| row.len() == 5) {
            commits.push(Commit {
                hash: row[0].trim_start_matches('\n').into(),
                short: row[1].into(),
                author: row[2].into(),
                date: row[3].into(),
                subject: row[4].into(),
            });
        }
    }
    let list = git(
        root,
        &["stash", "list", "-100", "--format=%gd%x00%H%x00%gs%x00"],
    )?;
    let fields: Vec<_> = list.split('\0').collect();
    let stashes = fields
        .chunks(3)
        .filter(|row| row.len() == 3)
        .map(|row| Stash {
            reference: row[0].trim_start_matches('\n').into(),
            hash: row[1].into(),
            subject: row[2].into(),
        })
        .collect();
    Ok(Snapshot {
        branch,
        changes,
        commits,
        stashes,
        repository: crate::git_remote::repository(root)?,
    })
}
fn pathspec(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') || !Path::new(path).components().all(|part| matches!(part, Component::Normal(value) if !value.to_string_lossy().eq_ignore_ascii_case(".git"))) { return Err("Invalid project file path.".into()); }
    Ok(())
}
fn hash(value: &str) -> Result<()> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Git object identifier.".into());
    }
    Ok(())
}
pub fn operation(root: &Path, action: &str, target: &str, message: &str) -> Result<String> {
    require_repository_root(root)?;
    match action {
        "stage-file" | "unstage-file" | "file-diff" | "index-diff" => {
            pathspec(target)?;
            let literal = format!(":(literal){target}");
            match action {
                "stage-file" => git(root, &["add", "--", &literal]),
                "unstage-file" => {
                    if git(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
                        let (_, entries) =
                            changes(&git(root, &["status", "--porcelain=v1", "--branch", "-z"])?)?;
                        let original = entries
                            .iter()
                            .find(|entry| entry.path == target)
                            .and_then(|entry| entry.original_path.as_deref());
                        if let Some(original) = original {
                            git(
                                root,
                                &[
                                    "reset",
                                    "HEAD",
                                    "--",
                                    &literal,
                                    &format!(":(literal){original}"),
                                ],
                            )
                        } else {
                            git(root, &["reset", "HEAD", "--", &literal])
                        }
                    } else {
                        git(root, &["rm", "--cached", "--", &literal])
                    }
                }
                "file-diff" => git(
                    root,
                    &["diff", "--no-ext-diff", "--no-textconv", "--", &literal],
                ),
                _ => git(
                    root,
                    &[
                        "diff",
                        "--cached",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                        &literal,
                    ],
                ),
            }
        }
        "commit-detail" => {
            hash(target)?;
            git(
                root,
                &[
                    "show",
                    "--format=",
                    "--patch",
                    "--no-ext-diff",
                    "--no-textconv",
                    target,
                    "--",
                ],
            )
        }
        "stash-detail" => {
            hash(target)?;
            git(
                root,
                &[
                    "stash",
                    "show",
                    "--patch",
                    "--include-untracked",
                    "--no-ext-diff",
                    "--no-textconv",
                    target,
                    "--",
                ],
            )
        }
        "unstage-all" => {
            if git(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
                git(root, &["reset", "HEAD", "--", "."])
            } else {
                git(root, &["rm", "-r", "--cached", "--", "."])
            }
        }
        "stash-apply" => {
            hash(target)?;
            git(root, &["stash", "apply", target])
        }
        "stash-save" => {
            if message.len() > 4096 {
                return Err("Stash message is too long.".into());
            }
            git(
                root,
                &[
                    "stash",
                    "push",
                    "--include-untracked",
                    "-m",
                    if message.trim().is_empty() {
                        "Aurea workspace"
                    } else {
                        message
                    },
                ],
            )
        }
        _ => crate::git_remote::operation(root, action, target, message),
    }
}
#[tauri::command]
pub async fn git_snapshot(store: tauri::State<'_, Store>, project_id: String) -> Result<Snapshot> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move || snapshot(&root))
        .await
        .map_err(error)?
}
#[tauri::command]
pub async fn git_workspace_action(
    store: tauri::State<'_, Store>,
    project_id: String,
    action: String,
    target: String,
    message: String,
) -> Result<String> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move || operation(&root, &action, &target, &message))
        .await
        .map_err(error)?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manages_real_history_staging_and_stashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init"]).unwrap();
        git(root, &["config", "user.name", "Test"]).unwrap();
        git(root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(root.join("a space.txt"), "first").unwrap();
        assert_eq!(snapshot(root).unwrap().changes[0].index, "?");
        operation(root, "stage-file", "a space.txt", "").unwrap();
        operation(root, "unstage-file", "a space.txt", "").unwrap();
        operation(root, "stage-file", "a space.txt", "").unwrap();
        git(root, &["commit", "-m", "first commit"]).unwrap();
        std::fs::write(root.join("a space.txt"), "second").unwrap();
        operation(root, "stage-file", "a space.txt", "").unwrap();
        operation(root, "unstage-file", "a space.txt", "").unwrap();
        assert_eq!(snapshot(root).unwrap().changes[0].index, " ");
        assert!(operation(root, "file-diff", "a space.txt", "")
            .unwrap()
            .contains("+second"));
        std::fs::write(root.join("untracked.txt"), "untracked").unwrap();
        operation(root, "stash-save", "", "my changes").unwrap();
        assert!(!root.join("untracked.txt").exists());
        let state = snapshot(root).unwrap();
        assert!(state.changes.is_empty());
        assert_eq!(state.commits[0].subject, "first commit");
        assert_eq!(state.stashes.len(), 1);
        operation(root, "stash-apply", &state.stashes[0].hash, "").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a space.txt")).unwrap(),
            "second"
        );
        assert!(operation(root, "stage-file", "../outside", "").is_err());
        assert!(operation(root, "commit-detail", "--all", "").is_err());
    }
    #[test]
    fn parses_renames_and_unusual_filenames() {
        let (_, rows) = changes("## main\0R  new name\0old name\0 M line\nbreak\0").unwrap();
        assert_eq!(rows[0].original_path.as_deref(), Some("old name"));
        assert_eq!(rows[1].path, "line\nbreak");
    }
}
