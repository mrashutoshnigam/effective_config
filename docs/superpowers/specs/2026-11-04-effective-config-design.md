# Effective Config Viewer — Design

Status: agreed 2026-11-04 (grilling session). Marketplace details (publisher, license, telemetry, workspace trust, CI/Open VSX, listing assets, min VS Code version) are parked — decided later by the owner.

## Purpose

VS Code extension that shows the **final merged configuration** a .NET app would see for a chosen environment, as a hierarchy, with provenance for every value. Target: public Marketplace.

## Scope

- v1: .NET only. Python / `.env` later behind the same provider interface.
- v1.1: compare two environments side by side (diff of two merge results; masked values compared by hash).
- Read-only. Editing = click-through to the source file.

## Merge model

Simulated in TypeScript (no build, no runtime). UI labels it: "Simulated — default `WebApplication.CreateBuilder` order".

Layers, lowest priority first:

1. `appsettings.json`
2. `appsettings.{Env}.json`
3. `appsettings.secrets.json` (only when present)
4. User Secrets — Development only; `UserSecretsId` from the `.csproj`; path `%APPDATA%\Microsoft\UserSecrets\<id>\secrets.json` (Windows) or `~/.microsoft/usersecrets/<id>/secrets.json` (macOS/Linux)
5. Environment variables — OS vars (filtered), then the selected `launchSettings.json` profile's `environmentVariables`
6. Command-line args — profile `commandLineArgs`, `--key=value` and `--key value` only

JSON layer list is configurable (`effectiveConfig.dotnet.jsonLayers`, `{env}` placeholder).

.NET semantics reproduced:

- Keys case-insensitive; display casing from the lowest layer defining the key.
- Arrays merge by index (`["a","b","c"]` + `["x"]` = `["x","b","c"]`); arrays whose items come from more than one layer are flagged.
- Env var `__` maps to `:`.
- OS env vars included only if their first key segment matches a top-level key from the JSON/user-secrets layers, or the name starts with `ASPNETCORE_` / `DOTNET_`.
- A key that has a direct value and child keys (e.g. env `Foo=x` over JSON section `Foo:Bar`) shows both, flagged "section also has a direct value".
- Values stored as .NET does: `true` → `"True"`, `null` → `""`, numbers as raw text, empty object/array → section with null value.
- Child ordering: numeric-aware, case-insensitive (like `ConfigurationKeyComparer`).

Parsing: `jsonc-parser` (comments, trailing commas, positions). A broken file is skipped; an error banner names the file and line.

## UI

- Webview panel in an editor tab. Opened from: Command Palette, Explorer context menu on `appsettings*.json` / `*.csproj`, editor-title button on `appsettings*.json`.
- One project per panel; project switcher. Content root = `.csproj` directory. From a file: owning project; from palette: quick pick of projects containing `appsettings.json`.
- Profile dropdown (from `Properties/launchSettings.json`), environment dropdown. Profile preselects env from `ASPNETCORE_ENVIRONMENT` (else `DOTNET_ENVIRONMENT`); user can override. No launchSettings → no profile, env Development.
- Environment list: `appsettings.*.json` files found (minus non-env layers such as `secrets`) ∪ Development/Staging/Production ∪ custom free text.
- Tree view default; flat `Section:Key = value` toggle; search by key or value (tree keeps ancestors of matches).
- Each value: winning source + override chain; click a source → opens file at line.
- Masking: values from secret layers, and keys matching configurable patterns (default `*Password*`, `*Secret*`, `*Key*`, `ConnectionStrings:*`), masked by default; per-value reveal.
- Copy value / key path / env var name (`A__B__C`). Export merged result as nested JSON or flat `KEY=value`; masked stays masked unless "reveal all" confirmed.
- Auto-refresh on change of `appsettings*.json`, `launchSettings.json`, `.csproj`, user secrets file; preserves expand/reveal state. Manual refresh for OS env.

## Architecture

- Pure TS merge engine (no `vscode` import): layers in → merged entries with override chains out.
- `DotnetProvider` discovers layers via a filesystem abstraction (testable).
- Webview renders only; host owns data and masking (raw secret values are sent to the webview only on reveal).

## Testing

- Vitest unit tests on engine/sources/provider (edge cases above).
- Fixture projects under `test/fixtures/`.
- Integration tests with `@vscode/test-electron`: open fixture workspace, run command, assert panel state.

## Known limitations (to document)

Custom providers, Azure Key Vault / App Configuration, `Program.cs` reordering, `Directory.Build.props` `UserSecretsId`, legacy `SQLCONNSTR_`-style prefixes, command-line switch mappings — not reflected.
