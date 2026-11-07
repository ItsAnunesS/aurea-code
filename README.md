# Aurea Code

A minimal desktop IDE built with **Rust + Tauri 2**, TypeScript, CodeMirror, and xterm.js. Releases currently support Linux x86_64 (AppImage) only. Windows builds and releases are temporarily suspended. English is the default language for the application, native menus, messages, and new workspace defaults. Existing user-created names and data are preserved.

## Features

- Three-stage startup: update check, project launcher, and a dedicated IDE for the open project. No plugins or marketplace.
- Persistent workspaces with multiple local projects.
- File explorer, file creation, and editing with syntax highlighting detected from filenames and extensions (JavaScript/TypeScript, Rust, Python, Go, HTML/CSS, YAML, SQL, Shell, Markdown, and more). Language support loads on demand from bundled assets, including offline. Unknown UTF-8 formats open as plain text. Search and undo/redo are included.
- Compact workbench with a vertical tool bar, Git and Docker panels alongside the editor, and resizable explorer/terminal panels. Panel sizes are remembered locally.
- Quick file access (Ctrl+P), command palette (Ctrl+Shift+P), explorer toggle (Ctrl+B), terminal toggle (Ctrl+backtick), and close current tab (Ctrl+W). File search refreshes on each opening, respects explorer exclusions, and scans up to 100 folders / 5,000 files with an explicit limit notice.
- File-type icons identify languages and special files (environment, Docker, Git, dependency manifests, and lockfiles) consistently in the explorer and tabs.
- Editor tabs preserve each file’s unsaved text, cursor, scroll position, and undo history. Single-click opens a temporary tab; opening another file replaces that tab. Double-click or editing pins it. Closing a dirty tab, leaving the project, or quitting requires confirmation before discarding edits, including edits in background tabs.
- Documentation preview with Code / Split / Preview modes and live updates for Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`). Text documentation (`.txt`, `.rst`, `.adoc`, `.asciidoc`, and extensionless README/LICENSE) has a plain-text reading view. Markdown includes tables, lists, and code blocks; embedded HTML is escaped and images appear as placeholders. Project-relative links open in the editor; HTTP(S) links open in the default browser.
- Environment files (`.env`, `.env.*`, and `*.env`) conceal values by default. Each value has an eye button to reveal or hide it for editing. Reopening or reloading from disk hides values again. This is visual masking, not encryption: saving and copying retain the original values.
- Open-file synchronization every three seconds and on focus. External changes reload automatically when there are no local edits. Saving rejects detected conflicts. Maximum file size: 2 MiB.
- Real PTY terminals for shells and `docker compose up --build`, with up to eight sessions. Each terminal identifies its project.
- Database workspace for PostgreSQL, MySQL/MariaDB, and SQLite: per-project connections, schema/table/column explorer, SQL console, editable table grid, result sets, page sorting, and CSV export.
- Native database clients through the system package manager or versioned official Docker clients; connect published project containers or provision a local development server with a persistent volume.
- Git status, diffs, staging, history, and commits with normal repository hooks. Open the repository root as a project; subfolders do not inherit a parent project's Git repository.
- Docker only shows Compose containers whose `com.docker.compose.project.working_dir` label matches the open project. Every action verifies ownership again in the backend. Unlabelled containers stay hidden. Compose requires a file at the project root and does not search parent folders.
- Native menus, keyboard shortcuts, folder selection, file manager integration, single-instance behavior, and system tray support.
- AppImage update metadata and a `.zsync` file for Gear Lever.

## Development

Use Node 22, Rust 1.99.1, and the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/). The Docker image includes GTK, WebKitGTK, AppIndicator, Rust, Node, and AppImage tools.

Docker is the preferred environment for checks and packaging:

```sh
docker compose build dev
docker compose run --rm dev npm ci
docker compose run --rm dev npm run check
docker compose run --rm dev cargo test --locked --manifest-path src-tauri/Cargo.toml
docker compose run --rm dev cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
docker compose run --rm dev cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

To test the real desktop window in a virtual display, first build the release binary:

```sh
docker compose run --rm dev npm run tauri -- build --no-bundle --ci -- --locked
docker compose build ui-test
docker compose run --rm ui-test
```

The smoke test uses temporary projects and an isolated data directory. It verifies English UI defaults, workspaces, file saving/synchronization, real Git and PTY operations, and switching between two projects. A fixture CLI tests Docker scoping and rejects actions on another project's containers. It does not mount the host Docker socket. Screenshots are saved under `artifacts/`.

For a browser-only preview, run `docker compose up dev` and visit `http://localhost:1420`. The preview is explicitly labelled and does not simulate access to files, Git, or Docker.

To run the desktop app on your computer with access to its display and local tools:

```sh
npm ci
npm run tauri -- dev
```

Docker volumes isolate `node_modules` and Rust build outputs from the host. The installed application uses your Docker CLI; building inside Docker does not grant access to host containers.

## First use

1. The standalone `aurea-code` updater checks the signed GitHub update manifest, downloads and verifies a newer installer, installs it, and restarts. Only then does it start the separate `aurea-ide` executable at the project launcher. If checking or installation fails, retry or explicitly open the installed version. Close the IDE (including its tray instance) before updating. On Windows, installation may request elevation according to the original installation scope.
2. In the launcher, create a workspace or use **Personal**.
3. Use **Open folder** to select an existing folder, or create one through the native dialog.
4. Open files from the explorer or click **Terminal** to start a shell in the project directory.
5. Install `git` and `docker` as native executables on `PATH`. **Environment** shows detected paths. On Windows, this version requires `.exe` executables rather than npm `.cmd` wrappers. Restart Aurea after installing tools.

The IDE shows tools only for the open project. Use **← Projects** to return to the launcher. Unsaved changes and active terminals require confirmation; sessions close before switching projects.

Workspace and project metadata lives in Tauri's application data directory (`dev.aurea.code`) in `workspace.json`. Existing workspaces and projects remain compatible. The data directory uses Unix permissions `0700`; Windows uses the protection of your user data directory. Native operating system dialogs and external tool output may follow your system or tool language settings.

Closing the window keeps the app in the system tray when available. Use **File → Quit** or the tray menu to exit. Running terminals and unsaved edits require confirmation. GNOME may need an AppIndicator extension to display the tray. Launching the executable again restores the existing window.

## Databases

Open **Data** in the IDE tool bar. Add a connection and select **Connect**. Network connections verify TLS certificates and hostnames by default; explicitly uncheck TLS for a local server that does not use TLS. SQLite opens an existing file relative to the project, including an empty file created in the explorer.

Connection metadata is stored in application data, scoped to the project. Passwords remain in memory for the application session unless **Remember password** is selected. Saved passwords use the operating system credential vault (Secret Service on Linux; Windows Credential Manager). A locked or unavailable vault produces an error, never a plaintext fallback. Docker server passwords are supplied through process environment variables to the official images; Docker administrators can inspect the resulting container environment. They are never written to project files or command-line arguments.

- Browse tables and views, inspect columns and primary keys, and page through 200 rows at a time. Clicking a column heading sorts the loaded page.
- Double-click a supported non-key cell (or press Enter) to stage a value or SQL NULL. **Apply changes** confirms the target and commits the batch in one transaction. The primary key and original edited values detect conflicting updates; a conflict rolls back the entire batch. MySQL/MariaDB grid editing requires InnoDB. Views, missing/unsupported primary keys, generated columns, and binary columns are read-only in the grid. Use SQL for inserts, deletes, schema changes, and unsupported values.
- **Run SQL** or Ctrl+Enter executes the selection, or the complete script when there is no selection. Each run uses a new database session; include explicit transactions in one script. Results are limited to 500 rows per statement, 4 MiB total, and fewer than 20 statements per run. Operations time out after 30 seconds. Cancel stops the client request; earlier statements may already have committed.
- **Save SQL as…** writes a new project file. Pending SQL scripts and grid edits require confirmation before leaving the project. **Export CSV** saves the loaded result page as a new project file, escaping spreadsheet formulas. Neither action overwrites existing files.
- Metadata discovery is currently limited to 500 tables/views or columns per request. SSH tunnels, database migrations, row insertion/deletion controls, and vendor-specific administration tools are not included.

### Clients and Docker servers

The graphical workspace uses bundled Rust drivers and works without downloading CLI tools. **Clients & versions** manages optional interactive command-line clients separately:

- **Native** lists the package versions available in APT on Debian/Ubuntu or winget on Windows. Installation runs visibly in the integrated terminal, with normal package verification and system elevation. Windows vendor packages can also contain server components. Other Linux distributions require manual installation with their own package manager. Installed native clients must be accessible on PATH; restart the app after installation when necessary.
- **Docker** accepts an explicit tag from the official postgres, mysql, or mariadb repository. Download the image or start an ephemeral interactive client for the selected connection. Linux loopback connections use host networking; Windows uses the Docker host gateway. Remote Docker contexts may require an explicitly reachable connection host. SQLite is embedded and offers an optional native console, not a Docker server.
- **Connect Docker container** lists running project containers with published PostgreSQL/MySQL ports. It reads names, images, labels, and published ports only; enter credentials explicitly. Use a direct connection for containers outside the project, remote Docker contexts, or custom ports.
- **Create Docker server** downloads the selected official image if needed and creates a uniquely named container and volume. Ports bind to 127.0.0.1; existing data and containers are never replaced. The connection is saved for the current session; click **Connect** after server initialization. The project Docker panel can manage the container. Removing a connection does not delete the server or its volume.

Network integration tests use temporary PostgreSQL, MySQL, and MariaDB servers with no published ports:

~~~sh
docker compose --profile database-test run --rm database-test
docker compose --profile database-test rm --stop --force db-postgres db-mysql db-mariadb
~~~

SQLite, scope, conflict/rollback, query-limit, and CSV tests also run in the normal checks. The desktop smoke test exercises connection creation, SQL execution, grid edits, and SQL-file saving with a temporary SQLite database. Native package installation and Windows credential-vault interaction require platform validation.

## Builds and Gear Lever

The package contains two executables: `aurea-code` (updater) and `aurea-ide` (launcher and IDE). Both are built together; the desktop shortcut starts the updater. The updater stays hidden while the IDE runs to keep Linux AppImage mounts alive. Their windows and native command handlers are separate; workspace/project data remains in `dev.aurea.code`.

Release publication signs the already-built Linux AppImage and produces `latest.json`. The public key is in `tauri.conf.json`; the private key must never enter Git. Before publishing, configure the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY` with the local `.aurea-signing/updater.key` contents, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is encrypted. Back up the private key securely: future updates must use the same key. Local signing material is ignored by Git. Normal branch builds and pull requests do not need signing secrets. Automatic publication requires them and never recompiles the application.

Signatures bind the installer to its version. The update manifest currently advertises only the Linux AppImage. The first release containing the standalone updater must be installed using the existing installation flow; older versions cannot acquire the new updater logic without that update. For development, build both binaries (`cargo build --manifest-path src-tauri/Cargo.toml --bins`) before starting `npm run tauri -- dev`, or run `aurea-ide` directly against Vite to work on the IDE.


### Linux AppImage

```sh
docker compose run --rm dev bash scripts/build-appimage.sh
```

Output under `artifacts/`:

- `Aurea-Code-<version>-x86_64.AppImage`
- `Aurea-Code-<version>-x86_64.AppImage.zsync`
- `SHA256SUMS-linux.txt`

The build uses Debian 12 (glibc 2.36). Verify your target distribution; compatibility with older distributions is not guaranteed. The first build downloads Tauri packaging tools.

Embedded update information:

```text
gh-releases-zsync|ItsAnunesS|aurea-code|latest|Aurea-Code-*-x86_64.AppImage.zsync
```

The package embeds `X-AppImage-Version` from the project version so Gear Lever displays the installed version. Existing installations receive this metadata when the new AppImage is integrated or installed as an update.

Packaging fails if the embedded desktop version is missing or incorrect, if update metadata is missing or the `.zsync` filename, size, or URL does not match the AppImage. The `.zsync` URL points to the immutable `releases/download/v<version>/...` asset.

Open the AppImage in Gear Lever and integrate it. Gear Lever detects the GitHub source from the embedded metadata. Enable automatic update checks in Gear Lever preferences; check frequency, notifications, and installation are controlled there. Aurea does not modify these settings or install Gear Lever.

### GitHub Actions and publishing

The default branch is `release`. `.github/workflows/build.yml` builds and tests Linux only on branch pushes and pull requests. All Rust tests, Clippy, formatting checks, TypeScript checks, and Linux desktop smoke tests remain required.

CI caches Rust dependencies and build outputs for Linux. Linux uses `compose.ci.yaml` to bind cache directories from the runner into Docker. Docker build layers, npm downloads, and bundler tools are cached too. Cache keys include the toolchain/environment and lockfiles, with compatible fallback keys for dependency reuse. Debug information and incremental compilation are disabled for CI test builds to reduce cache size; release optimization is unchanged. The frontend is compiled once by Tauri's `beforeBuildCommand` rather than twice. Already-compressed installer artifacts are uploaded without additional compression.

Every push to `release` automatically prepares a version, runs the Linux checks/build, then signs and publishes that same AppImage with a new tag and GitHub release. Pull requests only validate the app. A manual run on `release` can retry the pipeline. Publishing runs in a separate job after the Linux job succeeds; it downloads only that run's artifact. No second build or manual tag is needed. Runs are serialized to avoid competing version allocations.

Versioning considers commits since the highest reachable stable `vX.Y.Z` tag: `feat` increments minor, `!` or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer increments major, and other changes increment patch. The highest applicable bump wins (including before 1.0). CI stamps the calculated version into package.json, the Tauri config, Cargo.toml, and both lockfiles before compilation. These generated version changes remain in CI; the tag points to the tested source commit. To reproduce a tagged build locally, run `node scripts/release-version.mjs` after checking out that tag. Untagged local builds use the checked-in development version unless that command is run.

Publication signs the AppImage, creates the tag at the exact source commit, uploads all files to a draft release, and makes it public only after every upload succeeds. Interrupted uploads can resume; completed releases and tags are never overwritten. Rerunning an already tagged commit keeps its version. Signing failures stop publication. Existing manual tags are preserved. Gear Lever and the standalone updater continue to use the latest published release.

The update source is fixed to `ItsAnunesS/aurea-code`; forks must update the source in the updater, native release command, packaging script, and verifier.

## MVP limitations

- No semantic autocomplete/LSP, debugger, VS Code extensions, online collaboration, branch/remote management, or graphical Git conflict resolution. Use the terminal for advanced operations.
- The explorer hides `.git`, `node_modules`, `target`, and symbolic links. Binary editing is unsupported. Synchronization follows the open file; refresh the explorer to reload its tree.
- Git and Docker commands use separate arguments without shell interpolation. UI commands are restricted to the implemented operations. Interactive terminals retain normal execution capabilities and user permissions. Only open trusted projects: configuration, hooks, and Compose can execute code.
- Closing a terminal stops its main process. Docker services and deliberately detached processes may keep running. Save-conflict detection is not a distributed lock against concurrent external writers.

References: [Tauri](https://v2.tauri.app/), [AppImage updates](https://docs.appimage.org/packaging-guide/optional/updates.html), [Gear Lever](https://github.com/mijorus/gearlever).
