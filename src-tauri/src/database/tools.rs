use super::*;
use crate::process::{executable, run};
use portable_pty::CommandBuilder;
use std::{
    ffi::OsStr,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Instant,
};
#[derive(Clone, Deserialize, Serialize)]
pub struct ToolRequest {
    pub action: String,
    pub engine: Engine,
    pub version: String,
    pub connection_id: Option<String>,
}
#[derive(Serialize)]
pub struct NativeVersion {
    pub value: String,
    pub label: String,
}
pub fn image(engine: Engine, version: &str) -> Result<String> {
    if version.is_empty()
        || version.len() > 100
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !version.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err("Use a valid official image tag, such as 17-alpine or 8.4.".into());
    }
    let repository = match engine {
        Engine::Postgres => "postgres",
        Engine::Mysql => "mysql",
        Engine::Mariadb => "mariadb",
        Engine::Sqlite => {
            return Err(
                "SQLite runs directly in the IDE; use its native CLI for a separate console."
                    .into(),
            )
        }
    };
    Ok(format!("{repository}:{version}"))
}
fn native_package(engine: Engine, package: &str) -> bool {
    match engine {
        Engine::Postgres => package
            .strip_prefix("postgresql-client-")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())),
        Engine::Mysql => ["mysql-client", "default-mysql-client"].contains(&package),
        Engine::Mariadb => package == "mariadb-client",
        Engine::Sqlite => package == "sqlite3",
    }
}
fn windows_package(engine: Engine, package: &str) -> bool {
    match engine {
        Engine::Postgres => package
            .strip_prefix("PostgreSQL.PostgreSQL.")
            .is_some_and(|v| {
                !v.is_empty() && v.len() <= 2 && v.bytes().all(|b| b.is_ascii_digit())
            }),
        Engine::Mysql => package == "Oracle.MySQL",
        Engine::Mariadb => package == "MariaDB.Server",
        Engine::Sqlite => package == "SQLite.SQLite",
    }
}
#[tauri::command]
pub async fn db_native_versions(engine: Engine) -> Result<Vec<NativeVersion>> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::env::temp_dir();
        if cfg!(windows) {
            let packages = if engine == Engine::Postgres {
                let output = run("winget", &[OsStr::new("search"), OsStr::new("--id"), OsStr::new("PostgreSQL.PostgreSQL"), OsStr::new("--source"), OsStr::new("winget"), OsStr::new("--accept-source-agreements")], &root)?;
                let mut names = output.split_whitespace().filter(|s| windows_package(engine, s)).map(str::to_owned).collect::<Vec<_>>();
                names.sort(); names.dedup(); names
            } else { vec![match engine {Engine::Mysql=>"Oracle.MySQL",Engine::Mariadb=>"MariaDB.Server",_=>"SQLite.SQLite"}.into()] };
            let mut versions = Vec::new();
            for package in packages.into_iter().take(20) {
                let output = run("winget", &[OsStr::new("show"), OsStr::new("--id"), OsStr::new(&package), OsStr::new("--exact"), OsStr::new("--versions"), OsStr::new("--source"), OsStr::new("winget"), OsStr::new("--accept-source-agreements")], &root)?;
                versions.extend(output.lines().map(str::trim).filter(|s|s.starts_with(|c:char|c.is_ascii_digit()) && s.bytes().all(|b|b.is_ascii_alphanumeric() || b".-_+".contains(&b))).map(|v|NativeVersion{value:format!("{package}={v}"),label:format!("{package} {v}")}));
            }
            return Ok(versions);
        }
        let pattern=match engine {Engine::Postgres=>"^postgresql-client-[0-9]+$",Engine::Mysql=>"^(mysql-client|default-mysql-client)$",Engine::Mariadb=>"^mariadb-client$",Engine::Sqlite=>"^sqlite3$"};
        let output=run("apt-cache",&[OsStr::new("search"),OsStr::new("--names-only"),OsStr::new(pattern)],&root).map_err(|_|"Native installation needs APT on this Linux distribution. Install the client with your distribution's package manager, then reopen Aurea.")?;
        let mut versions=Vec::new();
        for package in output.lines().filter_map(|s|s.split_whitespace().next()).filter(|p|native_package(engine,p)).take(30) {
            let entries=run("apt-cache",&[OsStr::new("madison"),OsStr::new(package)],&root)?;
            for line in entries.lines() {
                if let Some(version)=line.split('|').nth(1).map(str::trim) { if !version.is_empty() {versions.push(NativeVersion{value:format!("{package}={version}"),label:format!("{package} · {version}")});} }
            }
        }
        versions.dedup_by(|a,b|a.value==b.value);
        Ok(versions)
    }).await.map_err(error)?
}
pub fn command(
    store: &Store,
    state: &DatabaseState,
    project_id: &str,
    request: &ToolRequest,
) -> Result<CommandBuilder> {
    let root = store.project(project_id)?.path;
    match request.action.as_str() {
        "pull" => {
            let mut command = CommandBuilder::new(executable("docker")?);
            command.args(["pull", &image(request.engine, &request.version)?]);
            Ok(command)
        }
        "install-native" => {
            let (package, version) = request
                .version
                .split_once('=')
                .ok_or("Choose a package version first.")?;
            if version.is_empty()
                || version.len() > 100
                || !version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:+~_-".contains(&b))
            {
                return Err("Invalid package version.".into());
            }
            if cfg!(windows) {
                if !windows_package(request.engine, package) {
                    return Err("Invalid native package.".into());
                }
                let mut command = CommandBuilder::new(executable("winget")?);
                command.args([
                    "install",
                    "--exact",
                    "--id",
                    package,
                    "--version",
                    version,
                    "--source",
                    "winget",
                    "--interactive",
                ]);
                Ok(command)
            } else {
                if !native_package(request.engine, package) {
                    return Err("Invalid native package.".into());
                }
                let apt = executable("apt-get")?;
                let mut command = CommandBuilder::new(executable("sudo")?);
                command.arg(apt);
                command.args(["install", "--", &request.version]);
                Ok(command)
            }
        }
        "native-console" | "docker-console" => {
            let current = config(
                store,
                project_id,
                request
                    .connection_id
                    .as_deref()
                    .ok_or("Choose a connection.")?,
            )?;
            if current.engine != request.engine {
                return Err("Client engine does not match the connection.".into());
            }
            let secret = if current.engine == Engine::Sqlite {
                String::new()
            } else if let Some(value) = state.passwords.lock().map_err(error)?.get(&current.id) {
                value.clone()
            } else if current.saved_password {
                credential(&current.id)?
                    .get_password()
                    .map_err(|_| "Unlock the system vault or re-enter the password.")?
            } else {
                return Err("Re-enter the connection password first.".into());
            };
            let program = match current.engine {
                Engine::Postgres => "psql",
                Engine::Mysql => "mysql",
                Engine::Mariadb => "mariadb",
                Engine::Sqlite => "sqlite3",
            };
            let docker = request.action == "docker-console";
            let mut command = CommandBuilder::new(if docker {
                executable("docker")?
            } else {
                executable(program)?
            });
            let host = if docker
                && !cfg!(target_os = "linux")
                && ["127.0.0.1", "localhost", "::1"].contains(&current.host.as_str())
            {
                "host.docker.internal"
            } else {
                &current.host
            };
            if docker {
                command.args(["run", "--rm", "-it"]);
                if cfg!(target_os = "linux")
                    && ["127.0.0.1", "localhost", "::1"].contains(&current.host.as_str())
                {
                    command.args(["--network", "host"]);
                } else {
                    command.args(["--add-host", "host.docker.internal:host-gateway"]);
                }
                if current.engine == Engine::Postgres {
                    command.args(["--env", "PGPASSWORD", "--env", "PGSSLMODE"]);
                } else {
                    command.args(["--env", "MYSQL_PWD"]);
                }
                command.arg(image(current.engine, &request.version)?);
                command.arg(program);
            }
            match current.engine {
                Engine::Postgres => {
                    if current.database.contains('=')
                        || current.database.starts_with("postgres:")
                        || current.database.starts_with("postgresql:")
                    {
                        return Err(
                            "The native console requires a database name, not a connection string."
                                .into(),
                        );
                    }
                    command.env("PGPASSWORD", secret);
                    command.env(
                        "PGSSLMODE",
                        if current.tls {
                            "verify-full"
                        } else {
                            "disable"
                        },
                    );
                    command.args([
                        "--host",
                        host,
                        "--port",
                        &current.port.to_string(),
                        "--username",
                        &current.username,
                        "--dbname",
                        &current.database,
                    ]);
                }
                Engine::Mysql | Engine::Mariadb => {
                    command.env("MYSQL_PWD", secret);
                    command.args([
                        "--host",
                        host,
                        "--port",
                        &current.port.to_string(),
                        "--user",
                        &current.username,
                    ]);
                    if current.engine == Engine::Mysql {
                        command.arg(if current.tls {
                            "--ssl-mode=VERIFY_IDENTITY"
                        } else {
                            "--ssl-mode=DISABLED"
                        });
                    } else if current.tls {
                        command.args(["--ssl", "--ssl-verify-server-cert"]);
                    } else {
                        command.arg("--skip-ssl");
                    }
                    command.arg(format!("--database={}", current.database));
                }
                Engine::Sqlite => {
                    command.arg(scoped_sqlite(&root, &current.database)?);
                }
            }
            Ok(command)
        }
        _ => Err("Unknown database tool action.".into()),
    }
}
fn scoped_sqlite(root: &Path, relative: &str) -> Result<std::path::PathBuf> {
    crate::files::scoped_path(root, relative)
}
#[derive(Deserialize, Serialize)]
pub struct DockerDatabase {
    pub id: String,
    pub name: String,
    pub image: String,
    pub ports: serde_json::Value,
}
#[tauri::command]
pub async fn db_docker_containers(
    store: tauri::State<'_, Store>,
    project_id: String,
) -> Result<Vec<DockerDatabase>> {
    let root = store.project(&project_id)?.path;
    tauri::async_runtime::spawn_blocking(move||{
        let output=run("docker",&[OsStr::new("ps"),OsStr::new("-q"),OsStr::new("--no-trunc"),OsStr::new("--filter"),OsStr::new("label=com.docker.compose.project.working_dir")],&root)?;
        let mut result=Vec::new();
        for id in output.lines().take(200){
            crate::process::docker_args("logs",id)?;
            let output=run("docker",&[OsStr::new("inspect"),OsStr::new("--format"),OsStr::new(r#"{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}},"directory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}"#),OsStr::new(id)],&root)?;
            let value:serde_json::Value=serde_json::from_str(&output).map_err(error)?;
            if value["directory"].as_str().and_then(|s|Path::new(s).canonicalize().ok()).as_ref()==Some(&root){
                result.push(serde_json::from_value(value).map_err(error)?);
            }
        }
        Ok(result)
    }).await.map_err(error)?
}
#[derive(Deserialize)]
pub struct CreateServer {
    pub engine: Engine,
    pub version: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}
fn simple_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
#[tauri::command]
pub async fn db_create_server(
    store: tauri::State<'_, Store>,
    project_id: String,
    request: CreateServer,
) -> Result<String> {
    let root = store.project(&project_id)?.path;
    let image = image(request.engine, &request.version)?;
    if request.port == 0
        || !simple_name(&request.database)
        || !simple_name(&request.username)
        || request.password.len() < 8
        || request.password.len() > 4096
        || request.password.contains('\0')
        || (request.engine != Engine::Postgres && request.username.eq_ignore_ascii_case("root"))
    {
        return Err(
            "Use simple database/user names, a valid port, and a password of 8–4096 characters."
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move||{
        let suffix=id();let name=format!("aurea-db-{suffix}");let volume=format!("{name}-data");
        let (port,path)=match request.engine{Engine::Postgres=>(5432,"/var/lib/postgresql"),_=>(3306,"/var/lib/mysql")};
        let mut command=Command::new(executable("docker")?);
        command.current_dir(&root).args(["run","--detach","--pull=missing","--name",&name,"--label",&format!("com.docker.compose.project.working_dir={}",root.display()),"--label","dev.aurea.database=true","--publish",&format!("127.0.0.1:{}:{port}",request.port),"--volume",&format!("{volume}:{path}")]);
        match request.engine{
            Engine::Postgres=>{
                command.env("POSTGRES_PASSWORD",&request.password).args(["--env","POSTGRES_PASSWORD","--env",&format!("POSTGRES_USER={}",request.username),"--env",&format!("POSTGRES_DB={}",request.database),"--env","PGDATA=/var/lib/postgresql/aurea"]);
            }
            Engine::Mysql|Engine::Mariadb=>{
                let prefix=if request.engine==Engine::Mysql{"MYSQL"}else{"MARIADB"};
                command.env(format!("{prefix}_PASSWORD"),&request.password).env(format!("{prefix}_ROOT_PASSWORD"),uuid::Uuid::new_v4().to_string());
                command.args(["--env",&format!("{prefix}_PASSWORD"),"--env",&format!("{prefix}_ROOT_PASSWORD"),"--env",&format!("{prefix}_DATABASE={}",request.database),"--env",&format!("{prefix}_USER={}",request.username)]);
            }
            Engine::Sqlite=>return Err("SQLite does not need a server.".into())
        }
        command.arg(image).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(error)?;
        let stdout=child.stdout.take().ok_or("No Docker output.")?;
        let stderr=child.stderr.take().ok_or("No Docker error output.")?;
        let drain = |mut reader: Box<dyn Read + Send>| -> std::io::Result<()> {
            let mut bytes = [0;8192];
            while reader.read(&mut bytes)? != 0 {}
            Ok(())
        };
        let out = thread::spawn(move || drain(Box::new(stdout)));
        let err = thread::spawn(move || drain(Box::new(stderr)));
        let start=Instant::now();
        let status=loop{
            if let Some(status)=child.try_wait().map_err(error)?{break status;}
            if start.elapsed()>Duration::from_secs(300){let _=child.kill();let _=child.wait();return Err(format!("Docker exceeded five minutes. Check container {name} before retrying; it may already exist."));}
            thread::sleep(Duration::from_millis(100));
        };
        out.join().map_err(|_|"Unable to read Docker output.")?.map_err(error)?;
        err.join().map_err(|_|"Unable to read Docker output.")?.map_err(error)?;
        if !status.success(){return Err(format!("Docker could not start {name}. Check the image tag, available port and Docker daemon. An empty container or volume may remain."));}
        Ok(format!("{name} created on 127.0.0.1:{}. Wait for initialization, then connect. Volume: {volume}.",request.port))
    }).await.map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_official_images_and_valid_tags_are_accepted() {
        assert_eq!(
            image(Engine::Postgres, "17-alpine").unwrap(),
            "postgres:17-alpine"
        );
        for tag in ["--privileged", "user/image", "17; echo bad", "latest\n", ""] {
            assert!(image(Engine::Mysql, tag).is_err());
        }
        assert!(!native_package(Engine::Postgres, "postgresql-client-17;id"));
        assert!(!native_package(Engine::Mysql, "curl"));
        assert!(native_package(Engine::Postgres, "postgresql-client-17"));
    }
}
