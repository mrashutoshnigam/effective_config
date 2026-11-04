# Effective Config Viewer

Shows the **final merged configuration** a .NET app would see for a chosen environment, as a hierarchy, with the source of every value.

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
