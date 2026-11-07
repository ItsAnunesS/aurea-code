use super::*;
use crate::files::scoped_path;
use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Column as _, ConnectOptions, Connection, Row, TypeInfo, ValueRef};
use std::path::Path;

pub enum DbConnection {
    Pg(sqlx::PgConnection),
    My(sqlx::MySqlConnection),
    Lite(sqlx::SqliteConnection),
}
fn sql_error(e: sqlx::Error) -> String {
    if let Some(db) = e.as_database_error() {
        format!("Database: {}", db.message())
    } else {
        "The database operation failed. Check the connection and retry.".into()
    }
}
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn text(row: &[Option<String>], index: usize) -> String {
    row.get(index).and_then(Clone::clone).unwrap_or_default()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn sqlite_cell(row: &sqlx::sqlite::SqliteRow, index: usize) -> Result<Option<String>> {
    let value = row.try_get_raw(index).map_err(sql_error)?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(match value.type_info().name() {
        "INTEGER" => row.try_get::<i64, _>(index).map_err(sql_error)?.to_string(),
        "REAL" => row.try_get::<f64, _>(index).map_err(sql_error)?.to_string(),
        "BLOB" => format!(
            "0x{}",
            hex(&row.try_get::<Vec<u8>, _>(index).map_err(sql_error)?)
        ),
        _ => row
            .try_get_unchecked::<String, _>(index)
            .map_err(sql_error)?,
    }))
}
impl DbConnection {
    pub fn open<'a>(
        config: &'a ConnectionConfig,
        password: &'a str,
        root: &'a Path,
    ) -> futures_util::future::BoxFuture<'a, Result<Self>> {
        Box::pin(async move {
            let failure = |_| {
                "Unable to connect. Check the address, database, credentials, and TLS certificate."
                    .to_owned()
            };
            match config.engine {
                Engine::Postgres => {
                    let options = PgConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(password)
                        .database(&config.database)
                        .ssl_mode(if config.tls {
                            PgSslMode::VerifyFull
                        } else {
                            PgSslMode::Disable
                        })
                        .disable_statement_logging();
                    let mut connection = sqlx::PgConnection::connect_with(&options)
                        .await
                        .map_err(failure)?;
                    sqlx::Executor::execute(&mut connection, "SET standard_conforming_strings = on; SET statement_timeout = 30000; SET lock_timeout = 5000").await.map_err(sql_error)?;
                    Ok(Self::Pg(connection))
                }
                Engine::Mysql | Engine::Mariadb => {
                    let options = MySqlConnectOptions::new()
                        .host(&config.host)
                        .port(config.port)
                        .username(&config.username)
                        .password(password)
                        .database(&config.database)
                        .ssl_mode(if config.tls {
                            MySqlSslMode::VerifyIdentity
                        } else {
                            MySqlSslMode::Disabled
                        })
                        .disable_statement_logging();
                    let mut connection = sqlx::MySqlConnection::connect_with(&options)
                        .await
                        .map_err(failure)?;
                    sqlx::Executor::execute(
                        &mut connection,
                        "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
                    )
                    .await
                    .map_err(sql_error)?;
                    Ok(Self::My(connection))
                }
                Engine::Sqlite => {
                    let options = SqliteConnectOptions::new()
                        .filename(scoped_path(root, &config.database)?)
                        .create_if_missing(false)
                        .foreign_keys(true)
                        .busy_timeout(Duration::from_secs(5))
                        .disable_statement_logging();
                    Ok(Self::Lite(
                        sqlx::SqliteConnection::connect_with(&options)
                            .await
                            .map_err(failure)?,
                    ))
                }
            }
        })
    }
    fn ident(&self, value: &str) -> String {
        let quote = if matches!(self, Self::My(_)) {
            '`'
        } else {
            '"'
        };
        format!(
            "{quote}{}{quote}",
            value.replace(quote, &format!("{quote}{quote}"))
        )
    }
    fn table_name(&self, table: &Table) -> Result<String> {
        if table.name.is_empty() || table.name.contains('\0') || table.schema.contains('\0') {
            return Err("Invalid table name.".into());
        }
        Ok(format!(
            "{}.{}",
            self.ident(&table.schema),
            self.ident(&table.name)
        ))
    }
    pub fn query<'a>(
        &'a mut self,
        sql: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Vec<ResultSet>>> {
        Box::pin(async move {
            let mut sets = Vec::new();
            let mut current = ResultSet::default();
            let mut bytes = 0usize;
            // Raw SQL uses the text protocol in PostgreSQL/MySQL. Decoding unchecked
            // strings preserves decimal precision, dates, UUIDs, and custom types.
            macro_rules! collect {
            ($connection:expr, $cell:expr) => {{
                let mut stream = sqlx::raw_sql(sql).fetch_many($connection);
                while let Some(item) = stream.try_next().await.map_err(sql_error)? {
                    match item {
                        sqlx::Either::Right(row) => {
                            if current.columns.is_empty() { current.columns = row.columns().iter().map(|c| c.name().to_owned()).collect(); }
                            if current.rows.len() < 500 && bytes < 4*1024*1024 {
                                let mut values = Vec::new();
                                for index in 0..row.len() {
                                    let value: Option<String> = $cell(&row,index)?;
                                    bytes += value.as_ref().map_or(0,String::len);
                                    if bytes > 4*1024*1024 { current.truncated = true; break; }
                                    values.push(value);
                                }
                                if values.len() == row.len() { current.rows.push(values); }
                            } else { current.truncated = true; }
                        }
                        sqlx::Either::Left(done) => {
                            current.affected = done.rows_affected();
                            sets.push(std::mem::take(&mut current));
                            if sets.len() >= 20 { return Err("Limit: 20 statements per execution. Earlier statements may already have committed.".into()); }
                        }
                    }
                }
            }}
        }
            match self {
                Self::Pg(connection) => {
                    collect!(connection, |row: &sqlx::postgres::PgRow, index: usize| row
                        .try_get_unchecked::<Option<String>, _>(index)
                        .map_err(sql_error))
                }
                Self::My(connection) => {
                    collect!(connection, |row: &sqlx::mysql::MySqlRow, index: usize| {
                        match row.try_get_unchecked::<Option<String>, _>(index) {
                            Ok(value) => Ok(value),
                            Err(_) => row
                                .try_get_unchecked::<Option<Vec<u8>>, _>(index)
                                .map(|v| v.map(|bytes| format!("0x{}", hex(&bytes))))
                                .map_err(sql_error),
                        }
                    })
                }
                Self::Lite(connection) => collect!(connection, sqlite_cell),
            }
            if !current.columns.is_empty() {
                sets.push(current);
            }
            Ok(sets)
        })
    }
    async fn rows(&mut self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        let set = self
            .query(sql)
            .await?
            .into_iter()
            .last()
            .unwrap_or_default();
        if set.truncated {
            return Err(
                "Metadata exceeds the 500-row limit. Narrow the database or use SQL.".into(),
            );
        }
        Ok(set.rows)
    }
    pub async fn tables(&mut self) -> Result<Vec<Table>> {
        let sql = match self {
            Self::Pg(_) => "SELECT table_schema,table_name,CASE WHEN table_type='BASE TABLE' THEN 'table' ELSE 'view' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
            Self::My(_) => "SELECT table_schema,table_name,CASE WHEN table_type='BASE TABLE' THEN 'table' ELSE 'view' END FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY 1,2",
            Self::Lite(_) => "SELECT 'main',name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        };
        Ok(self
            .rows(sql)
            .await?
            .into_iter()
            .map(|row| Table {
                schema: text(&row, 0),
                name: text(&row, 1),
                kind: text(&row, 2),
            })
            .collect())
    }
    pub async fn columns(&mut self, table: &Table) -> Result<Vec<Column>> {
        // Verify the relation and its kind on the server; caller-supplied kinds
        // must never turn a view into an editable table.
        if !self
            .tables()
            .await?
            .iter()
            .any(|t| t.schema == table.schema && t.name == table.name && t.kind == table.kind)
        {
            return Err("Table not found. Refresh the schema.".into());
        }
        let sql = match self {
            Self::Pg(_) => format!("SELECT a.attname,format_type(a.atttypid,a.atttypmod),CASE WHEN EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) THEN '1' ELSE '0' END,CASE WHEN a.attnotnull THEN '0' ELSE '1' END,CASE WHEN a.attgenerated='' THEN '1' ELSE '0' END FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname={} AND c.relname={} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",literal(&table.schema),literal(&table.name)),
            Self::My(_) => format!("SELECT column_name,column_type,CASE WHEN column_key='PRI' THEN '1' ELSE '0' END,CASE WHEN is_nullable='YES' THEN '1' ELSE '0' END,CASE WHEN extra LIKE '%GENERATED%' THEN '0' ELSE '1' END FROM information_schema.columns WHERE table_schema={} AND table_name={} ORDER BY ordinal_position",literal(&table.schema),literal(&table.name)),
            Self::Lite(_) => format!("SELECT name,type,CASE WHEN pk>0 THEN '1' ELSE '0' END,CASE WHEN \"notnull\"=0 THEN '1' ELSE '0' END,CASE WHEN hidden=0 THEN '1' ELSE '0' END FROM pragma_table_xinfo({}) ORDER BY cid",literal(&table.name)),
        };
        let columns = self
            .rows(&sql)
            .await?
            .into_iter()
            .map(|row| {
                let data_type = text(&row, 1);
                let binary = ["blob", "binary", "bytea", "bit"]
                    .iter()
                    .any(|name| data_type.to_lowercase().contains(name));
                Column {
                    name: text(&row, 0),
                    data_type,
                    primary_key: text(&row, 2) == "1",
                    nullable: text(&row, 3) == "1",
                    editable: text(&row, 4) == "1" && !binary,
                }
            })
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Err("No columns found.".into());
        }
        Ok(columns)
    }
    pub async fn transactional(&mut self, table: &Table) -> Result<bool> {
        if !matches!(self, Self::My(_)) {
            return Ok(true);
        }
        let rows = self.rows(&format!("SELECT engine FROM information_schema.tables WHERE table_schema={} AND table_name={}",literal(&table.schema),literal(&table.name))).await?;
        Ok(rows
            .first()
            .is_some_and(|r| text(r, 0).eq_ignore_ascii_case("innodb")))
    }
    pub async fn browse(
        &mut self,
        table: &Table,
        columns: &[Column],
        offset: u32,
    ) -> Result<ResultSet> {
        let fields = columns
            .iter()
            .map(|c| {
                let name = self.ident(&c.name);
                if matches!(self, Self::Lite(_)) && !c.data_type.to_lowercase().contains("blob") {
                    format!("CAST({name} AS TEXT) AS {name}")
                } else {
                    name
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        let keys = columns
            .iter()
            .filter(|c| c.primary_key)
            .map(|c| self.ident(&c.name))
            .collect::<Vec<_>>();
        let order = if keys.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", keys.join(","))
        };
        Ok(self
            .query(&format!(
                "SELECT {fields} FROM {}{order} LIMIT 200 OFFSET {offset}",
                self.table_name(table)?
            ))
            .await?
            .into_iter()
            .last()
            .unwrap_or_default())
    }
    pub async fn apply(&mut self, table: &Table, changes: &[RowChange]) -> Result<u64> {
        let columns = self.columns(table).await?;
        if table.kind != "table"
            || !columns.iter().any(|c| c.primary_key)
            || columns.iter().any(|c| c.primary_key && !c.editable)
            || !self.transactional(table).await?
        {
            return Err(
                "Editing requires a transactional table with a supported primary key.".into(),
            );
        }
        let begin = if matches!(self, Self::Lite(_)) {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN"
        };
        self.query(begin).await?;
        let result = self.apply_rows(table, &columns, changes).await;
        match result {
            Ok(count) => {
                self.query("COMMIT").await?;
                Ok(count)
            }
            Err(e) => {
                self.query("ROLLBACK").await.map_err(|_| {
                    "Edit failed and rollback could not be confirmed. Reconnect and reload."
                })?;
                Err(e)
            }
        }
    }
    async fn apply_rows(
        &mut self,
        table: &Table,
        columns: &[Column],
        changes: &[RowChange],
    ) -> Result<u64> {
        let mut count = 0;
        for change in changes {
            if change.original.len() != columns.len() || change.values.is_empty() {
                return Err("Invalid row change.".into());
            }
            let mut bindings = Vec::<Option<String>>::new();
            let mut assignments = Vec::new();
            for (name, value) in &change.values {
                let column = columns
                    .iter()
                    .find(|c| c.name == *name && c.editable && !c.primary_key)
                    .ok_or("This column cannot be edited in the grid.")?;
                if value.as_ref().is_some_and(|v| v.len() > 1024 * 1024) {
                    return Err("Cell exceeds 1 MiB.".into());
                }
                bindings.push(value.clone());
                let placeholder = if matches!(self, Self::Pg(_)) {
                    format!("CAST(${} AS {})", bindings.len(), column.data_type)
                } else {
                    "?".into()
                };
                assignments.push(format!("{}={placeholder}", self.ident(name)));
            }
            let mut conditions = Vec::new();
            for (index, column) in columns
                .iter()
                .enumerate()
                .filter(|(_, c)| c.primary_key || change.values.contains_key(&c.name))
            {
                bindings.push(change.original[index].clone());
                let name = self.ident(&column.name);
                conditions.push(match self {
                    Self::Pg(_) => format!("{name}::text IS NOT DISTINCT FROM ${}", bindings.len()),
                    Self::My(_) => format!("CAST({name} AS CHAR) <=> ?"),
                    Self::Lite(_) => format!("CAST({name} AS TEXT) IS ?"),
                });
            }
            let sql = format!(
                "UPDATE {} SET {} WHERE {}",
                self.table_name(table)?,
                assignments.join(","),
                conditions.join(" AND ")
            );
            let affected = match self {
                Self::Pg(connection) => {
                    let mut query = sqlx::query(&sql);
                    for value in &bindings {
                        query = query.bind(value);
                    }
                    query
                        .execute(connection)
                        .await
                        .map_err(sql_error)?
                        .rows_affected()
                }
                Self::My(connection) => {
                    let mut query = sqlx::query(&sql);
                    for value in &bindings {
                        query = query.bind(value);
                    }
                    query
                        .execute(connection)
                        .await
                        .map_err(sql_error)?
                        .rows_affected()
                }
                Self::Lite(connection) => {
                    let mut query = sqlx::query(&sql);
                    for value in &bindings {
                        query = query.bind(value);
                    }
                    query
                        .execute(connection)
                        .await
                        .map_err(sql_error)?
                        .rows_affected()
                }
            };
            if affected != 1 {
                return Err(
                    "The row changed or no longer exists. No edits were applied; reload and retry."
                        .into(),
                );
            }
            count += 1;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }
    fn fixture(engine: Engine, host: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: crate::store::id(),
            project_id: "test-project".into(),
            name: "Test".into(),
            engine,
            host: host.into(),
            port: if engine == Engine::Postgres {
                5432
            } else {
                3306
            },
            database: "aurea_test".into(),
            username: "aurea".into(),
            tls: false,
            saved_password: false,
        }
    }
    async fn exercise(mut db: DbConnection) {
        db.query("CREATE TABLE aurea_rows (id INTEGER PRIMARY KEY, label VARCHAR(100), amount DECIMAL(20,4)); INSERT INTO aurea_rows VALUES (1,'first',1234567890123456.1234),(2,NULL,2)").await.unwrap();
        let tables = db.tables().await.unwrap();
        let table = tables
            .into_iter()
            .find(|t| t.name == "aurea_rows")
            .expect("created table must be discoverable");
        let columns = db.columns(&table).await.unwrap();
        assert!(columns[0].primary_key);
        let before = db.browse(&table, &columns, 0).await.unwrap();
        assert_eq!(before.rows.len(), 2);
        assert_eq!(before.rows[1][1], None);
        let change = RowChange {
            original: before.rows[0].clone(),
            values: BTreeMap::from([(
                "label".into(),
                Some("quote ' ; DROP TABLE aurea_rows; --".into()),
            )]),
        };
        assert_eq!(db.apply(&table, &[change]).await.unwrap(), 1);
        let after = db.browse(&table, &columns, 0).await.unwrap();
        assert_eq!(
            after.rows[0][1].as_deref(),
            Some("quote ' ; DROP TABLE aurea_rows; --")
        );
        let first = RowChange {
            original: after.rows[1].clone(),
            values: BTreeMap::from([("label".into(), Some("must roll back".into()))]),
        };
        let stale = RowChange {
            original: before.rows[0].clone(),
            values: BTreeMap::from([("label".into(), Some("stale".into()))]),
        };
        assert!(db.apply(&table, &[first, stale]).await.is_err());
        assert_eq!(
            db.browse(&table, &columns, 0).await.unwrap().rows[1][1],
            None
        );
        let forged = Table {
            schema: table.schema.clone(),
            name: "aurea_rows; DROP TABLE aurea_rows".into(),
            kind: "table".into(),
        };
        assert!(db.columns(&forged).await.is_err());
        db.query("DROP TABLE aurea_rows").await.unwrap();
    }
    #[test]
    fn sqlite_edits_are_atomic_and_parameterized() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("test.db"), "").unwrap();
            let mut config = fixture(Engine::Sqlite, "");
            config.database = "test.db".into();
            exercise(DbConnection::open(&config, "", dir.path()).await.unwrap()).await;
        });
    }
    #[test]
    fn sqlite_limits_and_views() {
        runtime().block_on(async {
            let dir=tempfile::tempdir().unwrap();std::fs::write(dir.path().join("test.db"),"").unwrap();
            let mut config=fixture(Engine::Sqlite,"");config.database="test.db".into();
            let mut db=DbConnection::open(&config,"",dir.path()).await.unwrap();
            let result=db.query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600) SELECT x FROM n").await.unwrap();
            assert_eq!(result[0].rows.len(),500);assert!(result[0].truncated);
            db.query("CREATE TABLE base(id INTEGER PRIMARY KEY, value TEXT); CREATE VIEW view_rows AS SELECT * FROM base").await.unwrap();
            let table=db.tables().await.unwrap().into_iter().find(|t|t.name=="view_rows").unwrap();
            assert_eq!(table.kind,"view");
            assert!(db.apply(&table,&[]).await.is_err());
            config.database="../outside.db".into();assert!(DbConnection::open(&config,"",dir.path()).await.is_err());
        });
    }
    #[test]
    #[ignore = "Run with docker compose --profile database-test run --rm database-test"]
    fn network_engines() {
        runtime().block_on(async {
            for (engine, host) in [
                (Engine::Postgres, "db-postgres"),
                (Engine::Mysql, "db-mysql"),
                (Engine::Mariadb, "db-mariadb"),
            ] {
                let config = fixture(engine, host);
                let mut db = DbConnection::open(&config, "aurea-test-only", Path::new("/tmp"))
                    .await
                    .unwrap();
                db.query("DROP TABLE IF EXISTS aurea_rows").await.unwrap();
                let result = db
                    .query("SELECT CAST(1234567890123456.1234 AS DECIMAL(20,4)) AS exact_value")
                    .await
                    .unwrap();
                assert_eq!(
                    result[0].rows[0][0].as_deref(),
                    Some("1234567890123456.1234")
                );
                exercise(db).await;
            }
        });
    }
}
