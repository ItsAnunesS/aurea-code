use crate::{git::git, process::require_repository_root, store::Result};
use serde::Serialize;
use std::path::Path;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    reference: String,
    current: bool,
    remote: bool,
    upstream: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    branches: Vec<Branch>,
    remotes: Vec<String>,
    current: String,
    upstream: String,
    ahead: u64,
    behind: u64,
}
pub fn repository(root: &Path) -> Result<Repository> {
    let refs = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )?;
    let mut branches = Vec::new();
    for line in refs.lines() {
        let fields: Vec<_> = line.split('\0').collect();
        if fields.len() != 4 || !fields[3].is_empty() {
            continue;
        }
        let remote = fields[0].starts_with("refs/remotes/");
        branches.push(Branch {
            name: fields[0]
                .strip_prefix(if remote {
                    "refs/remotes/"
                } else {
                    "refs/heads/"
                })
                .unwrap_or(fields[0])
                .into(),
            reference: fields[0].into(),
            current: fields[1] == "*",
            remote,
            upstream: fields[2].into(),
        });
    }
    let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let upstream = branches
        .iter()
        .find(|branch| branch.current)
        .map(|branch| branch.upstream.clone())
        .unwrap_or_default();
    let upstream = if !upstream.is_empty()
        && git(root, &["rev-parse", "--verify", "--quiet", "@{upstream}"]).is_err()
    {
        String::new()
    } else {
        upstream
    };
    let (mut ahead, mut behind) = (0, 0);
    if !upstream.is_empty() {
        let counts = git(
            root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )?;
        let mut fields = counts.split_whitespace();
        ahead = fields.next().unwrap_or("0").parse().unwrap_or(0);
        behind = fields.next().unwrap_or("0").parse().unwrap_or(0);
    }
    Ok(Repository {
        branches,
        remotes: git(root, &["remote"])?
            .lines()
            .map(str::to_string)
            .collect(),
        current,
        upstream,
        ahead,
        behind,
    })
}
fn clean(root: &Path) -> Result<()> {
    if !git(root, &["status", "--porcelain"])?.trim().is_empty() {
        return Err(
            "Save and commit or stash your changes before switching, merging or pulling.".into(),
        );
    }
    Ok(())
}
fn branch_name(root: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n', '\r']) {
        return Err("Invalid branch name.".into());
    }
    git(root, &["check-ref-format", &format!("refs/heads/{name}")]).map(|_| ())
}
pub fn operation(root: &Path, action: &str, target: &str, message: &str) -> Result<String> {
    require_repository_root(root)?;
    let state = repository(root)?;
    if ["branch-create", "branch-merge", "pull"].contains(&action)
        && !message.is_empty()
        && message != state.current
    {
        return Err("The current branch changed. Refresh and review the operation again.".into());
    }
    match action {
        "remote-add" => {
            if target.is_empty()
                || target.starts_with('-')
                || !target
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            {
                return Err("Enter a remote name containing letters, numbers, dots, hyphens or underscores.".into());
            }
            let valid = message.starts_with("https://")
                || message.starts_with("http://")
                || message.starts_with("ssh://")
                || (message.starts_with("git@") && message.contains(':'))
                || Path::new(message).is_absolute();
            if !valid || message.len() > 2048 || message.chars().any(char::is_control) {
                return Err(
                    "Use an HTTPS/SSH repository URL or an absolute local repository path.".into(),
                );
            }
            git(root, &["remote", "add", "--", target, message])
        }
        "branch-create" => {
            clean(root)?;
            branch_name(root, target)?;
            git(root, &["switch", "-c", target])
        }
        "branch-switch" | "branch-track" | "branch-merge" => {
            clean(root)?;
            let branch = state
                .branches
                .iter()
                .find(|branch| branch.reference == target)
                .ok_or("Branch no longer exists. Refresh the repository.")?;
            match action {
                "branch-switch" if !branch.remote => {
                    git(root, &["switch", "--no-guess", "--", &branch.name])
                }
                "branch-track" if branch.remote => {
                    let (_, name) = branch
                        .name
                        .split_once('/')
                        .ok_or("Invalid remote branch.")?;
                    branch_name(root, name)?;
                    git(root, &["switch", "--track", "-c", name, &branch.reference])
                }
                "branch-merge" if !state.current.is_empty() => {
                    git(root, &["merge", "--no-edit", &branch.reference])
                }
                _ => Err("Choose a valid branch operation.".into()),
            }
        }
        "fetch" => {
            if target.starts_with('-') || !state.remotes.iter().any(|remote| remote == target) {
                return Err("Choose an existing remote.".into());
            }
            git(root, &["fetch", "--no-recurse-submodules", target])
        }
        "pull" => {
            clean(root)?;
            if state.upstream.is_empty() {
                return Err(
                    "Publish this branch with Push to configure its upstream first.".into(),
                );
            }
            git(root, &["pull", "--ff-only", "--no-recurse-submodules"])
        }
        "push" => {
            if state.current.is_empty() {
                return Err("Create or switch to a branch before pushing.".into());
            }
            if target.starts_with('-')
                || !state.remotes.contains(&target.to_string())
                || message != state.current
            {
                return Err(
                    "The branch or remote changed. Review the push destination again.".into(),
                );
            }
            git(
                root,
                &[
                    "push",
                    "--set-upstream",
                    target,
                    &format!("HEAD:refs/heads/{}", state.current),
                ],
            )
        }
        _ => Err("Unsupported Git workspace operation.".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manages_branches_and_syncs_a_local_remote_without_force() {
        let work = tempfile::tempdir().unwrap();
        let root = work.path();
        let remote = tempfile::tempdir().unwrap();
        let peer = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare"]).unwrap();
        git(root, &["init"]).unwrap();
        for path in [root, peer.path()] {
            git(path, &["init"]).unwrap();
            git(path, &["config", "user.name", "Test"]).unwrap();
            git(path, &["config", "user.email", "test@example.invalid"]).unwrap();
        }
        std::fs::write(root.join("base.txt"), "base").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "base"]).unwrap();
        let original = repository(root).unwrap().current;
        git(
            root,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        operation(root, "push", "origin", &original).unwrap();
        operation(root, "branch-create", "feature/ui", "").unwrap();
        std::fs::write(root.join("feature.txt"), "feature").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "feature"]).unwrap();
        operation(root, "branch-switch", &format!("refs/heads/{original}"), "").unwrap();
        operation(root, "branch-merge", "refs/heads/feature/ui", "").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("feature.txt")).unwrap(),
            "feature"
        );
        operation(root, "push", "origin", &original).unwrap();
        git(
            peer.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        git(peer.path(), &["fetch", "origin"]).unwrap();
        git(
            peer.path(),
            &[
                "switch",
                "-c",
                &original,
                "--track",
                &format!("origin/{original}"),
            ],
        )
        .unwrap();
        std::fs::write(peer.path().join("peer.txt"), "remote").unwrap();
        git(peer.path(), &["add", "."]).unwrap();
        git(peer.path(), &["commit", "-m", "peer"]).unwrap();
        git(peer.path(), &["push"]).unwrap();
        operation(root, "fetch", "origin", "").unwrap();
        assert_eq!(repository(root).unwrap().behind, 1);
        operation(root, "pull", "", "").unwrap();
        assert!(root.join("peer.txt").exists());
        assert!(operation(root, "branch-create", "--bad", "").is_err());
        assert!(operation(root, "fetch", "--all", "").is_err());
        std::fs::write(root.join("dirty.txt"), "unsaved").unwrap();
        assert!(operation(root, "branch-switch", "refs/heads/feature/ui", "").is_err());
        assert!(operation(root, "pull", "", "").is_err());
        std::fs::remove_file(root.join("dirty.txt")).unwrap();
        std::fs::write(root.join("local-only.txt"), "local").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "local divergence"]).unwrap();
        std::fs::write(peer.path().join("remote-only.txt"), "remote").unwrap();
        git(peer.path(), &["add", "."]).unwrap();
        git(peer.path(), &["commit", "-m", "remote divergence"]).unwrap();
        git(peer.path(), &["push"]).unwrap();
        assert!(operation(root, "pull", "", "").is_err());
        assert!(root.join("local-only.txt").exists());
        assert!(!root.join("remote-only.txt").exists());
    }
}
