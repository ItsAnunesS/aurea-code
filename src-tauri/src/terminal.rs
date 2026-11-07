use crate::{
    process::executable,
    store::{error, id, Result, Store},
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{ipc::Channel, Manager};

pub struct Session {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
}
#[derive(Default)]
pub struct Terminals(pub Mutex<HashMap<String, Session>>);
impl Terminals {
    pub fn stop_all(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: String },
    Error { message: String },
}
fn size(rows: u16, cols: u16) -> Result<PtySize> {
    if !(2..=500).contains(&rows) || !(2..=500).contains(&cols) {
        return Err("Invalid terminal dimensions.".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequest {
    project_id: String,
    kind: String,
    tool: Option<crate::database::tools::ToolRequest>,
    rows: u16,
    cols: u16,
}
#[tauri::command]
pub async fn terminal_start(
    app: tauri::AppHandle,
    request: TerminalRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || start(app, request, on_event))
        .await
        .map_err(error)?
}
fn start(
    app: tauri::AppHandle,
    request: TerminalRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<String> {
    let state_app = app.clone();
    let store = state_app.state::<Store>();
    let terminals = state_app.state::<Terminals>();
    let TerminalRequest {
        project_id,
        kind,
        tool,
        rows,
        cols,
    } = request;
    let project = store.project(&project_id)?;
    let mut sessions = terminals.0.lock().map_err(error)?;
    if sessions.len() >= 8 {
        return Err("Close a terminal before opening another (maximum: 8).".into());
    }
    let mut command = match kind.as_str() {
        "database-tool" => crate::database::tools::command(
            &store,
            &app.state::<crate::database::DatabaseState>(),
            &project_id,
            &tool.ok_or("Missing database tool settings.")?,
        )?,
        "shell" => {
            #[cfg(windows)]
            let shell = executable("powershell")?;
            #[cfg(not(windows))]
            let shell = executable("bash")?;
            CommandBuilder::new(shell)
        }
        "compose" => {
            let mut command = CommandBuilder::new(executable("docker")?);
            command.args(crate::docker::compose_args(&project.path)?);
            command
        }
        _ => return Err("Invalid terminal type.".into()),
    };
    command.cwd(&project.path);
    command.env("TERM", "xterm-256color");
    let pair = native_pty_system()
        .openpty(size(rows, cols)?)
        .map_err(error)?;
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let mut child = pair.slave.spawn_command(command).map_err(error)?;
    drop(pair.slave);
    let session_id = id();
    let key = session_id.clone();
    sessions.insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            killer: child.clone_killer(),
        },
    );
    let output_channel = on_event.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if output_channel
                        .send(TerminalEvent::Output {
                            data: buffer[..count].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                // Linux PTYs report EIO when the slave is closed.
                Err(e) if e.raw_os_error() == Some(5) => break,
                Err(e) => {
                    let _ = output_channel.send(TerminalEvent::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }
    });
    std::thread::spawn(move || {
        let result = child.wait();
        if let Ok(mut sessions) = app.state::<Terminals>().0.lock() {
            sessions.remove(&key);
        }
        let _ = reader_thread.join();
        let _ = on_event.send(TerminalEvent::Exit {
            code: result.map(|s| s.to_string()).unwrap_or_else(error),
        });
    });
    Ok(session_id)
}
#[tauri::command]
pub fn terminal_write(
    terminals: tauri::State<Terminals>,
    session_id: String,
    data: String,
) -> Result<()> {
    if data.len() > 65536 {
        return Err("Input is too large (limit: 64 KiB).".into());
    }
    let mut sessions = terminals.0.lock().map_err(error)?;
    let session = sessions.get_mut(&session_id).ok_or("Terminal closed.")?;
    session.writer.write_all(data.as_bytes()).map_err(error)?;
    session.writer.flush().map_err(error)
}
#[tauri::command]
pub fn terminal_resize(
    terminals: tauri::State<Terminals>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<()> {
    terminals
        .0
        .lock()
        .map_err(error)?
        .get(&session_id)
        .ok_or("Terminal closed.")?
        .master
        .resize(size(rows, cols)?)
        .map_err(error)
}
#[tauri::command]
pub fn terminal_stop(terminals: tauri::State<Terminals>, session_id: String) -> Result<()> {
    if let Some(mut session) = terminals.0.lock().map_err(error)?.remove(&session_id) {
        session.killer.kill().map_err(error)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_terminal_dimensions() {
        assert!(size(0, 80).is_err());
        assert!(size(24, 501).is_err());
        assert!(size(24, 80).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn pty_exchanges_real_bytes() {
        let pair = native_pty_system().openpty(size(24, 80).unwrap()).unwrap();
        let mut command = CommandBuilder::new("/bin/echo");
        command.arg("aurea-pty-ok");
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut output = Vec::new();
        let _ = reader.read_to_end(&mut output);
        assert!(child.wait().unwrap().success());
        assert!(String::from_utf8_lossy(&output).contains("aurea-pty-ok"));
    }
}
