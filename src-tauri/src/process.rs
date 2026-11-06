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
        "{name} não encontrado no PATH. Instale o executável nativo e reinicie a Aurea Code."
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
    ["git", "docker", "codex", "claude"]
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
    let mut command = Command::new(executable(program)?);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(error)?;
    let stdout = child.stdout.take().ok_or("Sem stdout.")?;
    let stderr = child.stderr.take().ok_or("Sem stderr.")?;
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
            return Err("A operação excedeu 30 segundos. Verifique o serviço no terminal.".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = out
        .join()
        .map_err(|_| "Falha ao ler stdout.")?
        .map_err(error)?;
    let stderr = err
        .join()
        .map_err(|_| "Falha ao ler stderr.")?
        .map_err(error)?;
    if !status.success() {
        return Err(format!(
            "{program}: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
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
        _ => return Err("Operação Git inválida ou mensagem de commit vazia.".into()),
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
        return Err("Identificador de container inválido.".into());
    }
    let args = match action {
        "start" => vec!["start", container],
        "stop" => vec!["stop", "--time", "10", container],
        "restart" => vec!["restart", "--time", "10", container],
        "logs" => vec!["logs", "--tail", "200", container],
        _ => return Err("Operação Docker inválida.".into()),
    };
    Ok(args.iter().map(|s| s.to_string()).collect())
}
#[tauri::command]
pub async fn docker_action(
    store: tauri::State<'_, Store>,
    action: String,
    container: Option<String>,
) -> Result<String> {
    let directory = store.directory.clone();
    let args = docker_args(&action, container.as_deref().unwrap_or(""))?;
    tauri::async_runtime::spawn_blocking(move || {
        run(
            "docker",
            &args.iter().map(OsStr::new).collect::<Vec<_>>(),
            &directory,
        )
    })
    .await
    .map_err(error)?
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
    fn reads_real_repository_and_stages_changes() {
        if executable("git").is_err() {
            panic!("git is required for integration tests");
        }
        let dir = tempfile::tempdir().unwrap();
        run("git", &[OsStr::new("init")], dir.path()).unwrap();
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
