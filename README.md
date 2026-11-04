# Effective Config Viewer

Shows the **final merged configuration** a .NET app would see for a chosen environment, as a hierarchy, with the source of every value.

## Getting started

Prerequisites: Node.js 20+ and VS Code 1.85+.

```bash
npm install
npm run build
```

### Run from source (F5)

1. Open this folder in VS Code.
2. Press **F5** (Run and Debug → **Run Extension (sample projects)**). It builds the extension and opens an Extension Development Host on `test/fixtures`.
   Use **Run Extension (pick a folder)** to open your own .NET solution instead.
3. In the new window, open the panel (see below).

Without the debugger:

```bash
code --extensionDevelopmentPath="<path to this repo>" "<path to your .NET solution>"
```

### Install as a normal extension

```bash
npx vsce package --allow-missing-repository
code --install-extension effective-config-0.1.0.vsix
```

Reload VS Code; the extension is then available in every workspace.

### Open the panel

- Command Palette (`Ctrl+Shift+P`): **Effective Config: Show Merged Configuration**
- Explorer: right-click an `appsettings*.json` or `.csproj` file
- Editor title button while an `appsettings*.json` file is open

Pick the project, launch profile and environment at the top of the panel. Click the eye button to reveal a masked value; click a source label to jump to the line that set it.

### Run the tests

```bash
npm run lint
npm run test:unit
npm run test:integration
```

Integration tests launch the locally installed VS Code (set `VSCODE_EXECUTABLE_PATH` to use a different build).

## What it does

- Opens a webview panel in an editor tab for one .NET project (a `.csproj` directory containing `appsettings.json`), with a project switcher.
- Pick a launch profile (from `Properties/launchSettings.json`) and an environment; the profile preselects the environment from `ASPNETCORE_ENVIRONMENT` (else `DOTNET_ENVIRONMENT`). Without launch settings there is no profile and the environment is `Development`.
- Tree view by default, a flat `Section:Key = value` toggle, and search by key or value.
- Every value shows its winning source and the chain of overridden values; click a source to open the file at the line.
- Open it from the Command Palette (`Effective Config: Show Merged Configuration`), the Explorer context menu on `appsettings*.json` / `*.csproj`, or the editor-title button on `appsettings*.json`.

## Merge order

Lowest priority first:

1. `appsettings.json`
2. `appsettings.{Env}.json`
3. `appsettings.secrets.json` (only when present)
4. User Secrets — Development only; `UserSecretsId` from the `.csproj`; `%APPDATA%\Microsoft\UserSecrets\<id>\secrets.json` (Windows) or `~/.microsoft/usersecrets/<id>/secrets.json` (macOS/Linux)
5. Environment variables — OS variables (filtered), then the selected `launchSettings.json` profile's `environmentVariables`
6. Command-line args — profile `commandLineArgs`, `--key=value` and `--key value` only

The panel labels the result: **Simulated — default WebApplication.CreateBuilder order**. Nothing is built or run; the merge is reproduced in TypeScript.

## Masking and reveal

Values from secret layers, and values whose key matches a mask pattern, are masked by default and are not sent to the webview. Use the per-value reveal control to show one.

## Copy and export

- Copy a value, a key path, or an environment variable name (`A__B__C`).
- Export the merged result as nested JSON or flat `KEY=value`. Masked values stay masked unless you confirm "reveal all".

## Auto-refresh

The panel refreshes when `appsettings*.json`, `launchSettings.json`, the `.csproj` or the user secrets file changes, preserving expanded and revealed state. OS environment variables are re-read on manual refresh.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `effectiveConfig.dotnet.jsonLayers` | `["appsettings.json", "appsettings.{env}.json", "appsettings.secrets.json"]` | JSON configuration layers, lowest priority first. `{env}` is replaced by the selected environment. A layer whose pattern contains `secret` is treated as sensitive. |
| `effectiveConfig.maskPatterns` | `["*Password*", "*Secret*", "*Key*", "ConnectionStrings:*"]` | Case-insensitive glob patterns of keys whose values are masked by default (`*` matches any characters, including `:`). |

## Known limitations

Custom providers, Azure Key Vault / App Configuration, `Program.cs` reordering, `Directory.Build.props` `UserSecretsId`, legacy `SQLCONNSTR_`-style prefixes, command-line switch mappings — not reflected.
