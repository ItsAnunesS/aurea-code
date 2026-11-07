mod engine;
pub mod tools;
use crate::store::{error, id, name, Result, Store};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Mariadb,
    Sqlite,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub engine: Engine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub tls: bool,
    #[serde(default)]
    pub saved_password: bool,
}
#[derive(Default)]
pub struct DatabaseState {
    passwords: Mutex<HashMap<String, String>>,
    active: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Table {
    pub schema: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub primary_key: bool,
    pub nullable: bool,
    pub editable: bool,
}
#[derive(Default, Serialize)]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: u64,
    pub truncated: bool,
}
#[derive(Deserialize)]
pub struct RowChange {
    pub original: Vec<Option<String>>,
    pub values: BTreeMap<String, Option<String>>,
}
#[derive(Serialize)]
pub struct TableData {
    pub columns: Vec<Column>,
    pub data: ResultSet,
    pub editable: bool,
}
fn config(store: &Store, project_id: &str, connection_id: &str) -> Result<ConnectionConfig> {
    store.project(project_id)?;
    store
        .snapshot()?
        .connections
        .into_iter()
        .find(|c| c.id == connection_id && c.project_id == project_id)
        .ok_or("Connection not found in this project.".into())
}
fn credential(id: &str) -> Result<keyring::Entry> {
    uuid::Uuid::parse_str(id).map_err(error)?;
    keyring::Entry::new("dev.aurea.code.database", id)
        .map_err(|_| "The system credential vault is unavailable.".into())
}
async fn credentials(app: &tauri::AppHandle, config: &ConnectionConfig) -> Result<String> {
    if config.engine == Engine::Sqlite {
        return Ok(String::new());
    }
    if let Some(value) = app
        .state::<DatabaseState>()
        .passwords
        .lock()
        .map_err(error)?
        .get(&config.id)
        .cloned()
    {
        return Ok(value);
    }
    if !config.saved_password {
        return Err("Enter this connection's password again.".into());
    }
    let id = config.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        credential(&id)?.get_password().map_err(|_| {
            "Unable to read the saved password. Unlock your system vault or enter it again.".into()
        })
    })
    .await
    .map_err(error)?
}
pub(super) fn validate(value: &ConnectionConfig) -> Result<()> {
    name(&value.name)?;
    if value.database.is_empty() || value.database.len() > 2048 || value.database.contains('\0') {
        return Err("Enter a database name or SQLite project-relative path.".into());
    }
    if value.engine != Engine::Sqlite
        && (value.host.is_empty()
            || value.host.len() > 253
            || value.host.chars().any(char::is_whitespace)
            || value.host.contains(['/', '\0'])
            || value.port == 0
            || value.username.is_empty()
            || value.username.len() > 128)
    {
        return Err("Check the host, port, and username.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn db_save_connection(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    mut connection: ConnectionConfig,
    password: Option<String>,
    remember: bool,
) -> Result<ConnectionConfig> {
    validate(&connection)?;
    let project = store.project(&connection.project_id)?;
    if connection.engine == Engine::Sqlite {
        crate::files::scoped_path(&project.path, &connection.database)?;
    }
    let password = match password {
        Some(value) => value,
        None => {
            credentials(
                &app,
                &config(&store, &connection.project_id, &connection.id)?,
            )
            .await?
        }
    };
    let previously_saved = store
        .snapshot()?
        .connections
        .iter()
        .any(|c| c.id == connection.id && c.saved_password);
    if connection.id.is_empty() {
        connection.id = id();
    } else {
        config(&store, &connection.project_id, &connection.id)?;
    }
    if password.len() > 4096 {
        return Err("Password is too long.".into());
    }
    connection.saved_password = remember && connection.engine != Engine::Sqlite;
    let saved = connection.clone();
    let secret = password.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        if saved.saved_password {
            credential(&saved.id)?.set_password(&secret).map_err(|_| {
                "Unable to save password. Unlock the system vault or turn off Remember password."
            })?;
        } else if previously_saved {
            match credential(&saved.id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err("Unable to remove the old credential from the vault.".into()),
            }
        }
        Ok(())
    })
    .await
    .map_err(error)??;
    store.update(|db| {
        db.connections.retain(|c| c.id != connection.id);
        db.connections.push(connection.clone());
        Ok(())
    })?;
    app.state::<DatabaseState>()
        .passwords
        .lock()
        .map_err(error)?
        .insert(connection.id.clone(), password);
    Ok(connection)
}
#[tauri::command]
pub fn db_connections(
    store: tauri::State<Store>,
    project_id: String,
) -> Result<Vec<ConnectionConfig>> {
    store.project(&project_id)?;
    Ok(store
        .snapshot()?
        .connections
        .into_iter()
        .filter(|c| c.project_id == project_id)
        .collect())
}
#[tauri::command]
pub async fn db_remove_connection(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    project_id: String,
    connection_id: String,
) -> Result<()> {
    let current = config(&store, &project_id, &connection_id)?;
    if current.saved_password {
        let id = connection_id.clone();
        tauri::async_runtime::spawn_blocking(move || match credential(&id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok::<(), String>(()),
            Err(_) => Err("Unlock your system vault before removing this connection.".into()),
        })
        .await
        .map_err(error)??;
    }
    db_cancel(app.clone(), project_id.clone(), connection_id.clone())?;
    store.update(|db| {
        db.connections.retain(|c| c.id != connection_id);
        Ok(())
    })?;
    app.state::<DatabaseState>()
        .passwords
        .lock()
        .map_err(error)?
        .remove(&connection_id);
    Ok(())
}
#[tauri::command]
pub fn db_cancel(app: tauri::AppHandle, project_id: String, connection_id: String) -> Result<()> {
    config(&app.state::<Store>(), &project_id, &connection_id)?;
    if let Some(handle) = app
        .state::<DatabaseState>()
        .active
        .lock()
        .map_err(error)?
        .get(&connection_id)
    {
        handle.abort();
    }
    Ok(())
}
async fn connect(
    app: &tauri::AppHandle,
    project_id: &str,
    connection_id: &str,
) -> Result<engine::DbConnection> {
    let store = app.state::<Store>();
    let current = config(&store, project_id, connection_id)?;
    let root = store.project(project_id)?.path;
    let password = credentials(app, &current).await?;
    tokio::time::timeout(
        Duration::from_secs(12),
        engine::DbConnection::open(&current, &password, &root),
    )
    .await
    .map_err(|_| "Connection timed out.")?
}
#[tauri::command]
pub async fn db_tables(
    app: tauri::AppHandle,
    project_id: String,
    connection_id: String,
) -> Result<Vec<Table>> {
    tokio::time::timeout(Duration::from_secs(30), async {
        connect(&app, &project_id, &connection_id)
            .await?
            .tables()
            .await
    })
    .await
    .map_err(|_| "Schema discovery timed out.")?
}
#[tauri::command]
pub async fn db_query(
    app: tauri::AppHandle,
    project_id: String,
    connection_id: String,
    sql: String,
) -> Result<Vec<ResultSet>> {
    if sql.trim().is_empty() || sql.len() > 128 * 1024 {
        return Err("Enter SQL up to 128 KiB.".into());
    }
    config(&app.state::<Store>(), &project_id, &connection_id)?;
    let cloned = app.clone();
    let id = connection_id.clone();
    let task = {
        let state = app.state::<DatabaseState>();
        let mut active = state.active.lock().map_err(error)?;
        if active.contains_key(&id) {
            return Err("A query is already running on this connection.".into());
        }
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(30), async {
                connect(&cloned, &project_id, &id).await?.query(&sql).await
            })
            .await
            .map_err(|_| "Query timed out. Earlier statements may already have committed.")?
        });
        active.insert(connection_id.clone(), task.abort_handle());
        task
    };
    let result = task
        .await
        .map_err(|_| "Query cancelled. Earlier statements may already have committed.".to_owned());
    app.state::<DatabaseState>()
        .active
        .lock()
        .map_err(error)?
        .remove(&connection_id);
    result?
}
#[tauri::command]
pub async fn db_table(
    app: tauri::AppHandle,
    project_id: String,
    connection_id: String,
    table: Table,
    offset: u32,
) -> Result<TableData> {
    if offset > 10_000_000 {
        return Err("Page offset is too large.".into());
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut db = connect(&app, &project_id, &connection_id).await?;
        let columns = db.columns(&table).await?;
        let editable = table.kind == "table"
            && columns.iter().any(|c| c.primary_key)
            && columns.iter().all(|c| !c.primary_key || c.editable)
            && db.transactional(&table).await?;
        let data = db.browse(&table, &columns, offset).await?;
        Ok(TableData {
            columns,
            data,
            editable,
        })
    })
    .await
    .map_err(|_| "Table loading timed out.")?
}
#[tauri::command]
pub async fn db_apply(
    app: tauri::AppHandle,
    project_id: String,
    connection_id: String,
    table: Table,
    changes: Vec<RowChange>,
) -> Result<u64> {
    if changes.is_empty() || changes.len() > 100 {
        return Err("Apply between 1 and 100 edited rows.".into());
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        connect(&app, &project_id, &connection_id)
            .await?
            .apply(&table, &changes)
            .await
    })
    .await
    .map_err(|_| {
        "Saving timed out. Reload the table before retrying; the commit outcome may be unknown."
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connections_are_project_scoped_and_metadata_has_no_password() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let connection = ConnectionConfig {
            id: id(),
            project_id: "one".into(),
            name: "Fixture".into(),
            engine: Engine::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "test".into(),
            username: "test".into(),
            tls: true,
            saved_password: false,
        };
        store
            .update(|db| {
                for name in ["one", "two"] {
                    db.projects.push(crate::store::Project {
                        id: name.into(),
                        name: name.into(),
                        path: dir.path().into(),
                        workspace_id: db.workspaces[0].id.clone(),
                    });
                }
                db.connections.push(connection.clone());
                Ok(())
            })
            .unwrap();
        assert!(config(&store, "one", &connection.id).is_ok());
        assert!(config(&store, "two", &connection.id).is_err());
        let saved = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(!saved.contains("\"password\":"));
        assert!(saved.contains("saved_password"));
    }
}
