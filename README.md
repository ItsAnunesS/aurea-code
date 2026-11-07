# Aurea Code

A minimal desktop IDE built with **Rust + Tauri 2**, TypeScript, CodeMirror, and xterm.js. Supports Linux x86_64 (AppImage) and Windows x86_64 (NSIS `.exe` and MSI installers). English is the default language for the application, native menus, messages, and new workspace defaults. Existing user-created names and data are preserved.

## Features

- Three-stage startup: update check, project launcher, and a dedicated IDE for the open project. No plugins or marketplace.
- Persistent workspaces with multiple local projects and separate Codex/Claude profiles.
- File explorer, file creation, and editing with JS/TS, JSON, and Rust syntax highlighting, search, and undo/redo. Other UTF-8 files open as plain text.
- Open-file synchronization every three seconds and on focus. External changes reload automatically when there are no local edits. Saving rejects detected conflicts. Maximum file size: 2 MiB.
- Real PTY terminals for shells, Codex, Claude, and `docker compose up --build`, with up to eight sessions. Each terminal identifies its project and account.
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

The smoke test uses temporary projects and an isolated data directory. It verifies English UI defaults, workspaces, profiles, file saving/synchronization, real Git and PTY operations, and switching between two projects. A fixture CLI tests Docker scoping and rejects actions on another project's containers. It does not use real agent accounts or mount the host Docker socket. Screenshots are saved under `artifacts/`.

For a browser-only preview, run `docker compose up dev` and visit `http://localhost:1420`. The preview is explicitly labelled and does not simulate access to files, Git, Docker, or agents.

To run the desktop app on your computer with access to its display and local tools:

```sh
npm ci
npm run tauri -- dev
```

Docker volumes isolate `node_modules` and Rust build outputs from the host. The installed application uses your Docker CLI; building inside Docker does not grant access to host containers.

## First use

1. At startup, Aurea checks the latest stable GitHub release. If an update exists, open its download page or continue. When offline, retry or continue without checking. Installation is managed by Gear Lever on Linux or the installer on Windows.
2. In the launcher, create a workspace or use **Personal**.
3. Under **AI accounts**, create a Codex or Claude profile for each account. You can link a profile to multiple workspaces.
4. Use **Open folder** to select an existing folder, or create one through the native dialog.
5. Select a profile in the IDE and click **Start agent**. Sign in through the official CLI. Aurea does not provide or bypass provider subscriptions.
6. Install `git`, `docker`, `codex`, and/or `claude` as native executables on `PATH`. **Environment** shows detected paths. On Windows, this version requires `.exe` executables rather than npm `.cmd` wrappers. Restart Aurea after installing tools.

The IDE shows tools only for the open project. Use **← Projects** to return to the launcher. Unsaved changes and active terminals require confirmation; sessions close before switching projects.

Codex receives a separate `CODEX_HOME` for each profile; Claude receives a separate `CLAUDE_CONFIG_DIR`. Common inherited authentication variables are removed from agent sessions so a parent API key does not silently override the selected account. Sign-in, tokens, approvals, and history remain managed by the official CLIs. Switching profiles starts a new session without changing existing sessions.

Metadata lives in Tauri's application data directory (`dev.aurea.code`). `workspace.json` does not store tokens. Profile directories use Unix permissions `0700`; Windows uses the protection of your user data directory. Profiles separate configuration, not operating system permissions. Enterprise policies, credential helpers, and CLI settings still apply. Native operating system dialogs and external tool output may follow your system or tool language settings.

Closing the window keeps the app in the system tray when available. Use **File → Quit** or the tray menu to exit. Running terminals and unsaved edits require confirmation. GNOME may need an AppIndicator extension to display the tray. Launching the executable again restores the existing window.

## Builds and Gear Lever

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

Packaging fails if metadata is missing or the `.zsync` filename, size, or URL does not match the AppImage. The `.zsync` URL points to the immutable `releases/download/v<version>/...` asset.

Open the AppImage in Gear Lever and integrate it. Gear Lever detects the GitHub source from the embedded metadata. Enable automatic update checks in Gear Lever preferences; check frequency, notifications, and installation are controlled there. Aurea does not modify these settings or install Gear Lever.

### Windows

On a Windows host or runner with the Tauri prerequisites:

```powershell
npm ci
npm run tauri -- build --bundles nsis,msi --ci -- --locked
```

Installers are written to `src-tauri/target/release/bundle/`. Code signing certificates are not configured, so Windows may show an unknown publisher warning. Windows updates are installed manually in this version.

### GitHub Actions and publishing

The default branch is `release`. `.github/workflows/build.yml` builds and tests both platforms on branch pushes and pull requests. All Rust tests, Clippy, formatting checks, TypeScript checks, and Linux desktop smoke tests remain required.

CI caches Rust dependencies and build outputs separately for Linux and Windows. Linux uses `compose.ci.yaml` to bind cache directories from the runner into Docker. Docker build layers, npm downloads, and bundler tools are cached too. Cache keys include the toolchain/environment and lockfiles, with compatible fallback keys for dependency reuse. Debug information and incremental compilation are disabled for CI test builds to reduce cache size; release optimization is unchanged. The frontend is compiled once by Tauri's `beforeBuildCommand` rather than twice. Already-compressed installer artifacts are uploaded without additional compression.

For a release, push the version commit to `release` and wait for both builds to pass before pushing its `v<version>` tag. The tag workflow checks the version and looks for a successful push build of the **exact same commit** on `release`, with both platform artifacts still available. It publishes those tested artifacts without recompiling. A missing, failed, expired, or mismatched build triggers fresh builds and tests for both platforms. Publishing never reuses pull-request or fork artifacts. The first build with an empty cache still compiles dependencies; later builds can reuse them.

Keep versions aligned in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and their lockfiles. Run `node scripts/check-version.mjs` before tagging. Do not reuse tags or replace published assets. The update source is fixed to `ItsAnunesS/aurea-code`; forks must update the source in the updater, native release command, packaging script, and verifier.

## MVP limitations

- Codex/Claude integration uses their real interactive CLIs. It does not mirror web/desktop history or provide a graphical app-server/Agent SDK chat.
- No semantic autocomplete/LSP, debugger, VS Code extensions, online collaboration, branch/remote management, or graphical Git conflict resolution. Use the terminal for advanced operations.
- The explorer hides `.git`, `node_modules`, `target`, and symbolic links. Binary editing is unsupported. Synchronization follows the open file; refresh the explorer to reload its tree.
- Git and Docker commands use separate arguments without shell interpolation. UI commands are restricted to the implemented operations. Interactive terminals retain normal execution capabilities and user permissions. Only open trusted projects: configuration, hooks, agents, and Compose can execute code.
- Closing a terminal stops its main process. Docker services and deliberately detached processes may keep running. Save-conflict detection is not a distributed lock against concurrent external writers.
- Validate sign-in and account switching with your CLI versions and credential policies. Aurea does not read or display tokens.

References: [Tauri](https://v2.tauri.app/), [Codex state directories](https://learn.chatgpt.com/docs/config-file/environment-variables), [Claude settings](https://code.claude.com/docs/en/settings), [AppImage updates](https://docs.appimage.org/packaging-guide/optional/updates.html), [Gear Lever](https://github.com/mijorus/gearlever).
