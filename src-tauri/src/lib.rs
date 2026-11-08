mod database;
mod docker;
mod files;
mod process;
mod store;
mod terminal;
pub mod updater;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

struct AppMenus([Submenu<tauri::Wry>; 3]);
#[tauri::command]
fn open_app_menu(
    window: tauri::WebviewWindow,
    menus: tauri::State<AppMenus>,
    name: &str,
    x: f64,
    y: f64,
) -> store::Result<()> {
    let index = match name {
        "file" => 0,
        "edit" => 1,
        "view" => 2,
        _ => return Err("Unknown application menu".into()),
    };
    window
        .popup_menu_at(&menus.0[index], tauri::LogicalPosition::new(x, y))
        .map_err(store::error)
}
#[tauri::command]
fn open_document_link(app: tauri::AppHandle, url: String) -> store::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = tauri::Url::parse(&url).map_err(store::error)?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only HTTP(S) documentation links are supported".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(store::error)
}
struct Desktop {
    tray_ready: AtomicBool,
}
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn action(app: &tauri::AppHandle, id: &str) {
    show(app);
    let _ = app.emit("native-action", id);
}
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.state::<terminal::Terminals>().stop_all();
    app.exit(0);
}
#[tauri::command]
fn desktop_status(desktop: tauri::State<Desktop>) -> bool {
    desktop.tray_ready.load(Ordering::Relaxed)
}

#[tauri::command]
fn open_release(app: tauri::AppHandle) -> store::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://github.com/ItsAnunesS/aurea-code/releases/latest",
            None::<&str>,
        )
        .map_err(store::error)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(terminal::Terminals::default())
        .manage(database::DatabaseState::default())
        .manage(Desktop {
            tray_ready: AtomicBool::new(false),
        })
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(updater::lock_installation(&directory).map_err(std::io::Error::other)?);
            app.manage(store::Store::open(directory).map_err(std::io::Error::other)?);
            let open = MenuItem::with_id(app, "open", "Open project…", true, Some("CmdOrCtrl+O"))?;
            let save = MenuItem::with_id(app, "save", "Save file", true, Some("CmdOrCtrl+S"))?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let workspace =
                MenuItem::with_id(app, "workspace", "New workspace…", true, None::<&str>)?;
            let file_menu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open,
                    &workspace,
                    &save,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("Undo"))?,
                    &PredefinedMenuItem::redo(app, Some("Redo"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("Cut"))?,
                    &PredefinedMenuItem::copy(app, Some("Copy"))?,
                    &PredefinedMenuItem::paste(app, Some("Paste"))?,
                    &PredefinedMenuItem::select_all(app, Some("Select All"))?,
                ],
            )?;
            let projects =
                MenuItem::with_id(app, "projects", "Projects", true, Some("CmdOrCtrl+1"))?;
            let git = MenuItem::with_id(app, "git", "Git", true, Some("CmdOrCtrl+2"))?;
            let docker = MenuItem::with_id(app, "docker", "Docker", true, Some("CmdOrCtrl+3"))?;
            let terminal =
                MenuItem::with_id(app, "terminal", "New terminal", true, Some("CmdOrCtrl+J"))?;
            let view_menu =
                Submenu::with_items(app, "View", true, &[&projects, &git, &docker, &terminal])?;
            app.set_menu(Menu::with_items(
                app,
                &[&file_menu, &edit_menu, &view_menu],
            )?)?;
            app.manage(AppMenus([file_menu, edit_menu, view_menu]));
            if let Some(window) = app.get_webview_window("main") {
                window.hide_menu()?;
            }
            app.on_menu_event(|app, event| action(app, event.id.as_ref()));
            let tray_show = MenuItem::with_id(app, "show", "Open Aurea Code", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&tray_show, &tray_quit])?;
            let tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/32x32.png"
                ))?)
                .tooltip("Aurea Code — your projects in one place")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .build(app);
            match tray {
                Ok(_) => app
                    .state::<Desktop>()
                    .tray_ready
                    .store(true, Ordering::Relaxed),
                Err(e) => eprintln!("System tray unavailable: {e}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.state::<Desktop>().tray_ready.load(Ordering::Relaxed) {
                    let _ = window.hide();
                } else {
                    action(window.app_handle(), "quit");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            database::tools::db_native_versions,
            database::tools::db_docker_containers,
            database::tools::db_create_server,
            database::db_connections,
            database::db_save_connection,
            database::db_remove_connection,
            database::db_tables,
            database::db_table,
            database::db_query,
            database::db_cancel,
            database::db_apply,
            store::load_workspace,
            store::create_workspace,
            store::add_project,
            store::remove_project,
            files::list_files,
            files::create_file,
            files::transfer_entry,
            files::rename_entry,
            files::create_folder,
            files::read_media,
            files::read_file,
            files::save_file,
            process::tools_status,
            process::git_action,
            docker::docker_action,
            open_release,
            process::reveal_project,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            exit_app,
            desktop_status,
            open_app_menu,
            open_document_link
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Aurea Code");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<terminal::Terminals>().stop_all();
        }
    });
}
