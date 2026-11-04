# Effective Config Viewer

Shows the **final merged configuration** a .NET or Python app would see for a chosen environment, as a hierarchy, with the source of every value.

## Getting started

Prerequisites: Node.js 20+ and VS Code 1.85+.

```bash
npm install
npm run build
```

### Run from source (F5)

1. Open this folder in VS Code.
2. Press **F5** (Run and Debug → **Run Extension (sample projects)**). It builds the extension and opens an Extension Development Host on `test/fixtures`.
   Use **Run Extension (pick a folder)** to open your own .NET solution or Python project instead.
3. In the new window, open the panel (see below).

Without the debugger:

```bash
code --extensionDevelopmentPath="<path to this repo>" "<path to your .NET solution or Python project>"
```

### Install as a normal extension

```bash
npx vsce package --allow-missing-repository
code --install-extension effective-config-0.2.0.vsix
```

Reload VS Code; the extension is then available in every workspace.

### Open the panel

- Command Palette (`Ctrl+Shift+P`): **Effective Config: Show Merged Configuration**
- Explorer: right-click an `appsettings*.json`, `.csproj`, `.env` or `.env.*` file
- Editor title button while an `appsettings*.json`, `.env` or `.env.*` file is open

Pick the project, launch profile and environment at the top of the panel. Click the eye button to reveal a masked value; click a source label to jump to the line that set it.

### Run the tests

```bash
npm run lint
npm run test:unit
npm run test:integration
```

Integration tests launch the locally installed VS Code (set `VSCODE_EXECUTABLE_PATH` to use a different build).

## What it does

- Opens a webview panel in an editor tab for one .NET project (a `.csproj` directory containing `appsettings.json`) or Python project (see [Python](#python)), with a project switcher listing both, tagged `[.NET]` / `[Python]`.
- Pick a launch profile (from `Properties/launchSettings.json`, or `.vscode/launch.json` for Python) and an environment; the profile preselects the environment from `ASPNETCORE_ENVIRONMENT` (else `DOTNET_ENVIRONMENT`). Without launch settings there is no profile and the environment is `Development`.
- Tree view by default, a flat `Section:Key = value` toggle, and search by key or value.
- Every value shows its winning source and the chain of overridden values; click a source to open the file at the line.
- Open it from the Command Palette (`Effective Config: Show Merged Configuration`), the Explorer context menu on `appsettings*.json` / `*.csproj` / `.env*`, or the editor-title button on `appsettings*.json` / `.env*`.

## Merge order

Lowest priority first:

1. `appsettings.json`
2. `appsettings.{Env}.json`
3. `appsettings.secrets.json` (only when present)
4. User Secrets — Development only; `UserSecretsId` from the `.csproj`; `%APPDATA%\Microsoft\UserSecrets\<id>\secrets.json` (Windows) or `~/.microsoft/usersecrets/<id>/secrets.json` (macOS/Linux)
5. Environment variables — OS variables (filtered), then the selected `launchSettings.json` profile's `environmentVariables`
6. Command-line args — profile `commandLineArgs`, `--key=value` and `--key value` only

The panel labels the result: **Simulated — default WebApplication.CreateBuilder order**. Nothing is built or run; the merge is reproduced in TypeScript.

## Python

### Projects

A Python project is a folder containing `.env` or any `.env.*` file and one marker: `pyproject.toml`, `requirements.txt`, `setup.py`, `setup.cfg` or `Pipfile`. When a workspace folder has no marker-based project but its root has a `.env`, that root becomes a Python project, unless a .NET project lives at or under it (a .NET repo with a stray `.env` gets no Python project). `node_modules`, `.venv`, `venv`, `env`, `__pycache__`, `site-packages`, `.git`, `bin` and `obj` are ignored. A file owned by both a .NET and a Python project in the same folder opens in the provider matching the file type.

### Layer order

Lowest priority first (OS variables win by default):

1. `.env`
2. `.env.{env}`
3. `.env.local`
4. `.env.{env}.local`
5. Environment (OS) variables, filtered
6. Profile `envFile` from `.vscode/launch.json`
7. Profile `env` from `.vscode/launch.json`

The file list is configurable with `effectiveConfig.python.envFiles`; missing files are skipped. With `effectiveConfig.python.fileOverridesOs` set to `true` (python-dotenv `override=True`), layers 1-4 move above layers 5-7. The panel labels the result **Simulated — python-dotenv order (OS variables win)**, or **(files override OS)** when that setting is on.

### OS variable filter

An OS variable is shown only when its key matches (case-insensitively) a key defined in a file or profile layer, or its name starts with a prefix listed in `effectiveConfig.python.envPrefixes` (default none).

### Nested keys

Keys are split on `effectiveConfig.python.nestedDelimiter` (default `__`) into the tree; an empty string keeps keys flat. Matching is case-insensitive. Copy env var name and `KEY=value` export join segments with the same delimiter.

### Parsing and expansion

`.env` files follow python-dotenv rules: `KEY=value`, optional `export ` prefix, comments, ` #` inline comments for unquoted values, single-quoted literals, and double-quoted values with escapes (`\n \r \t \\ \" \'`) that may span lines. `${VAR}` and `${VAR:-default}` are expanded in unquoted and double-quoted values; lookup prefers the process environment (OS plus profile) unless `fileOverridesOs` is on, then keys defined earlier in the same or lower file layers. Unresolved references become the default or an empty string. A value expanded from a secret is itself masked (for example a `DATABASE_URL` built from `${DB_PASSWORD}`), and the override chain shows which keys were used. A key without `=` is skipped with an info diagnostic; an unparseable line produces a warning and the rest of the file still loads.

### Profiles and environment detection

Profiles are the `debugpy` / `python` configurations in the nearest `.vscode/launch.json` (searched from the project folder up to the workspace folder). `${workspaceFolder}` in `envFile` is substituted. The environment name is the first of `APP_ENV`, `ENV`, `ENVIRONMENT`, `PYTHON_ENV` (`effectiveConfig.python.environmentVariables`) found in the profile `env`, the profile `envFile`, `.env`, then the OS; otherwise `development`. The environment list is `development`, `staging`, `production` plus names from existing `.env.<name>` files (excluding `local`, `example`, `sample`, `template`, `defaults` and `*.local`).

## Masking and reveal

Values from secret layers, and values whose key matches a mask pattern, are masked by default and are not sent to the webview. Use the per-value reveal control to show one. `*TOKEN*` was added to the default mask patterns, which also applies to .NET projects.

## Copy and export

- Copy a value, a key path, or an environment variable name (`A__B__C`; Python uses its configured delimiter).
- Export the merged result as nested JSON or flat `KEY=value`. Masked values stay masked unless you confirm "reveal all".

## Auto-refresh

The panel refreshes when `appsettings*.json`, `launchSettings.json`, the `.csproj`, the user secrets file, `.env*` files or `.vscode/launch.json` changes, preserving expanded and revealed state. OS environment variables are re-read on manual refresh.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `effectiveConfig.dotnet.jsonLayers` | `["appsettings.json", "appsettings.{env}.json", "appsettings.secrets.json"]` | JSON configuration layers, lowest priority first. `{env}` is replaced by the selected environment. A layer whose pattern contains `secret` is treated as sensitive. |
| `effectiveConfig.python.envFiles` | `[".env", ".env.{env}", ".env.local", ".env.{env}.local"]` | Python env files, lowest priority first. `{env}` is replaced by the selected environment. A file whose pattern contains `secret` is treated as sensitive. |
| `effectiveConfig.python.fileOverridesOs` | `false` | When true, env files override OS variables (python-dotenv `override=True`). |
| `effectiveConfig.python.envPrefixes` | `[]` | OS variables starting with one of these prefixes (case-insensitive) are shown even when no file defines them. |
| `effectiveConfig.python.nestedDelimiter` | `"__"` | Delimiter that splits keys into the tree; empty string for flat keys. |
| `effectiveConfig.python.environmentVariables` | `["APP_ENV", "ENV", "ENVIRONMENT", "PYTHON_ENV"]` | Variables, in order, that name the active environment. |
| `effectiveConfig.maskPatterns` | `["*Password*", "*Secret*", "*Key*", "*TOKEN*", "ConnectionStrings:*"]` | Case-insensitive glob patterns of keys whose values are masked by default (`*` matches any characters, including `:`). |

## Known limitations

.NET: custom providers, Azure Key Vault / App Configuration, `Program.cs` reordering, `Directory.Build.props` `UserSecretsId`, legacy `SQLCONNSTR_`-style prefixes, command-line switch mappings — not reflected.

Python: `.flaskenv`, Django settings modules, `os.environ` reads in code, conda `environment.yml`, direnv `.envrc`, Poetry/pipenv auto-loading, pydantic `secrets_dir`, and app-specific loaders are not reflected.
