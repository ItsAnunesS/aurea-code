use crate::store::{error, Result, Store};
use serde::Serialize;
use std::{
    env,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn executable(name: &str) -> Result<PathBuf> {
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let path = env::var_os("PATH").unwrap_or_default();
    for directory in env::split_paths(&path).filter(|p| p.is_absolute()) {
        let candidate = directory.join(&file_name);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata().map_err(error)?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return candidate.canonicalize().map_err(error);
        }
    }
    Err(format!(
        "{name} was not found in PATH. Install the native executable and restart Aurea Code."
    ))
}
#[derive(Serialize)]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
}
#[tauri::command]
pub fn tools_status() -> Vec<ToolStatus> {
    ["git", "docker"]
        .iter()
        .map(|name| {
            let path = executable(name)
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
            ToolStatus {
                name: name.to_string(),
                available: path.is_some(),
                path,
            }
        })
        .collect()
}
fn collect(mut reader: impl Read) -> std::io::Result<Vec<u8>> {
    const LIMIT: usize = 1024 * 1024;
    let mut output = vec![];
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
        truncated |= count > remaining;
    }
    if truncated {
        output.extend_from_slice(b"\n[Output truncated at 1 MiB]\n");
    }
    Ok(output)
}
pub fn run(program: &str, args: &[&OsStr], directory: &Path) -> Result<String> {
    run_inner(program, args, directory, false)
}
pub fn config_query(args: &[&OsStr], directory: &Path) -> Result<String> {
    run_inner("git", args, directory, true)
}
// Host tools must not load libraries bundled for the AppImage itself.
#[cfg(target_os = "linux")]
fn configure_host_libraries(
    command: &mut Command,
    app_dir: Option<&OsStr>,
    libraries: Option<&OsStr>,
) {
    let (Some(app_dir), Some(libraries)) = (app_dir, libraries) else {
        return;
    };
    let app_dir = Path::new(app_dir);
    if !app_dir.is_absolute() {
        return;
    }
    let paths: Vec<_> = env::split_paths(libraries)
        .filter(|path| !path.starts_with(app_dir))
        .collect();
    if paths.is_empty() {
        command.env_remove("LD_LIBRARY_PATH");
    } else if let Ok(value) = env::join_paths(paths) {
        command.env("LD_LIBRARY_PATH", value);
    }
}
fn run_inner(
    program: &str,
    args: &[&OsStr],
    directory: &Path,
    missing_config: bool,
) -> Result<String> {
    let mut command = Command::new(executable(program)?);
    #[cfg(target_os = "linux")]
    configure_host_libraries(
        &mut command,
        env::var_os("APPDIR").as_deref(),
        env::var_os("LD_LIBRARY_PATH").as_deref(),
    );
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat");
    if program == "git" {
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_LITERAL_PATHSPECS",
            "GIT_GLOB_PATHSPECS",
            "GIT_NOGLOB_PATHSPECS",
            "GIT_ICASE_PATHSPECS",
        ] {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(error)?;
    let stdout = child.stdout.take().ok_or("No stdout.")?;
    let stderr = child.stderr.take().ok_or("No stderr.")?;
    let out = thread::spawn(move || collect(stdout));
    let err = thread::spawn(move || collect(stderr));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(error)? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "The operation exceeded 30 seconds. Check the service in the terminal.".into(),
            );
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = out
        .join()
        .map_err(|_| "Failed to read stdout.")?
        .map_err(error)?;
    let stderr = err
        .join()
        .map_err(|_| "Failed to read stderr.")?
        .map_err(error)?;
    if missing_config && status.code() == Some(1) && stdout.is_empty() && stderr.is_empty() {
        return Ok(String::new());
    }
    if !status.success() {
        return Err(format!(
            "{program}: {}",
            String::from_utf8_lossy(if stderr.is_empty() { &stdout } else { &stderr }).trim()
        ));
    }
    // Git stdout contains machine-readable paths, status and configuration.
    if program == "git" {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ))
}
pub fn git_args(action: &str, message: &str) -> Result<Vec<String>> {
    let mut args = vec!["--no-pager".into(), "--literal-pathspecs".into()];
    let operation: Vec<&str> = match action {
        "status" => vec!["status", "--short", "--branch"],
        "diff" => vec!["diff", "--no-ext-diff", "--no-textconv", "--"],
        "staged" => vec!["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"],
        "log" => vec!["log", "-20", "--oneline", "--decorate"],
        "stage" => vec!["add", "--all", "--", "."],
        "unstage" => vec!["reset", "--mixed", "HEAD", "--", "."],
        "commit" if !message.trim().is_empty() && message.len() <= 4096 => {
            vec!["commit", "-m", message]
        }
        _ => return Err("Invalid Git operation or empty commit message.".into()),
    };
    args.extend(operation.iter().map(|s| s.to_string()));
    Ok(args)
}
#[tauri::command]
pub async fn git_action(
    store: tauri::State<'_, Store>,
    project_id: String,
    action: String,
    message: Option<String>,
) -> Result<String> {
    let project = store.project(&project_id)?;
    let args = git_args(&action, message.as_deref().unwrap_or(""))?;
    tauri::async_runtime::spawn_blocking(move || {
        require_repository_root(&project.path)?;
        run(
            "git",
            &args.iter().map(OsStr::new).collect::<Vec<_>>(),
            &project.path,
        )
    })
    .await
    .map_err(error)?
}
pub fn docker_args(action: &str, container: &str) -> Result<Vec<String>> {
    if action == "list" {
        return Ok(vec![
            "ps".into(),
            "--all".into(),
            "--no-trunc".into(),
            "--format".into(),
            "{{json .}}".into(),
        ]);
    }
    if !(12..=64).contains(&container.len()) || !container.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid container identifier.".into());
    }
    let args = match action {
        "start" => vec!["start", container],
        "stop" => vec!["stop", "--time", "10", container],
        "restart" => vec!["restart", "--time", "10", container],
        "logs" => vec!["logs", "--tail", "200", container],
        _ => return Err("Invalid Docker operation.".into()),
    };
    Ok(args.iter().map(|s| s.to_string()).collect())
}
pub fn require_repository_root(directory: &Path) -> Result<()> {
    if !directory.join(".git").try_exists().map_err(error)? {
        return Err("This folder is not a Git repository root. Open the folder containing .git (or initialize a repository in the terminal if this is a new project).".into());
    }
    let root = run(
        "git",
        &[OsStr::new("rev-parse"), OsStr::new("--show-toplevel")],
        directory,
    )?;
    if Path::new(root.trim()).canonicalize().map_err(error)?
        != directory.canonicalize().map_err(error)?
    {
        return Err("Open the repository root as a project to use integrated Git.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_project(
    app: tauri::AppHandle,
    store: tauri::State<Store>,
    project_id: String,
) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(
            store.project(&project_id)?.path.to_string_lossy(),
            None::<&str>,
        )
        .map_err(error)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn host_tools_exclude_only_appimage_library_paths() {
        let mut command = Command::new("git");
        configure_host_libraries(
            &mut command,
            Some(OsStr::new("/tmp/.mount_aurea")),
            Some(OsStr::new(
                "/tmp/.mount_aurea/usr/lib:/opt/host/lib:/tmp/.mount_aurea-other/lib",
            )),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == "LD_LIBRARY_PATH")
            .unwrap()
            .1
            .unwrap();
        assert_eq!(value, "/opt/host/lib:/tmp/.mount_aurea-other/lib");
        configure_host_libraries(
            &mut command,
            Some(OsStr::new("/tmp/.mount_aurea")),
            Some(OsStr::new("/tmp/.mount_aurea/usr/lib")),
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == "LD_LIBRARY_PATH")
                .unwrap()
                .1,
            None
        );
        let mut native = Command::new("git");
        configure_host_libraries(&mut native, None, Some(OsStr::new("/opt/host/lib")));
        assert_eq!(native.get_envs().count(), 0);
    }
    #[test]
    fn non_repository_has_actionable_error() {
        let directory = tempfile::tempdir().unwrap();
        let message = require_repository_root(directory.path()).unwrap_err();
        assert!(message.contains("Open the folder containing .git"));
        assert!(!directory.path().join(".git").exists());
    }
    #[test]
    fn git_warnings_do_not_corrupt_stdout() {
        let directory = tempfile::tempdir().unwrap();
        let output = run(
            "git",
            &[
                OsStr::new("-c"),
                OsStr::new("alias.warn=!printf result; printf warning >&2"),
                OsStr::new("warn"),
            ],
            directory.path(),
        )
        .unwrap();
        assert_eq!(output, "result");
    }
    #[test]
    fn rejects_arbitrary_operations() {
        assert!(git_args("push", "").is_err());
        assert!(git_args("commit", " ").is_err());
        assert!(docker_args("rm", "0123456789abcdef").is_err());
        assert!(docker_args("stop", "--all").is_err());
    }
    #[test]
    fn commit_message_is_one_argument() {
        let message = "fix: $(touch /tmp/unwanted); `whoami`";
        let args = git_args("commit", message).unwrap();
        assert_eq!(args.last().unwrap(), message);
        assert_eq!(args.len(), 5);
    }
    #[test]
    fn accepts_linked_worktree_roots() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        run("git", &[OsStr::new("init")], root).unwrap();
        run(
            "git",
            &[
                OsStr::new("-c"),
                OsStr::new("user.name=Test"),
                OsStr::new("-c"),
                OsStr::new("user.email=test@example.invalid"),
                OsStr::new("commit"),
                OsStr::new("--allow-empty"),
                OsStr::new("-m"),
                OsStr::new("Initial"),
            ],
            root,
        )
        .unwrap();
        let worktree = root.join("linked");
        run(
            "git",
            &[
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-b"),
                OsStr::new("linked"),
                worktree.as_os_str(),
            ],
            root,
        )
        .unwrap();
        assert!(worktree.join(".git").is_file());
        require_repository_root(&worktree).unwrap();
    }
    #[test]
    fn reads_real_repository_and_stages_changes() {
        if executable("git").is_err() {
            panic!("git is required for integration tests");
        }
        let dir = tempfile::tempdir().unwrap();
        run("git", &[OsStr::new("init")], dir.path()).unwrap();
        require_repository_root(dir.path()).unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(require_repository_root(&nested).is_err());
        std::fs::write(dir.path().join("hello.txt"), "hello").unwrap();
        let args = git_args("stage", "").unwrap();
        run(
            "git",
            &args.iter().map(OsStr::new).collect::<Vec<_>>(),
            dir.path(),
        )
        .unwrap();
        let args = git_args("staged", "").unwrap();
        assert!(run(
            "git",
            &args.iter().map(OsStr::new).collect::<Vec<_>>(),
            dir.path()
        )
        .unwrap()
        .contains("+hello"));
    }
}
