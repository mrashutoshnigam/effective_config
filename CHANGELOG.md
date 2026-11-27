# Changelog

## Unreleased

- Docker Compose provider: folders with `compose.yaml` / `docker-compose.yml` are shown as `[Compose]` projects. The panel shows the environment of the chosen service: `env_file` entries, then `environment` per compose file (base, then override), with the winner and override chain of every variable.
- Compose interpolation (`${VAR:-d}`, `${VAR:?e}`, `${VAR:+r}` and their unset-only forms, nested defaults, `$$`), with the OS over the selected env file. Missing `:?` variables are error diagnostics at their line, quoting the author's message as written so no secret is expanded into it; unset variables are warnings. `env_file` values also see the service's `environment` and earlier `env_file` lines, and a bare `KEY` line takes its value from them, as in compose-go. Relative `env_file` paths in override files resolve from the first compose file's folder.
- The environment picker of a Compose project simulates `--env-file`. `COMPOSE_FILE`, `COMPOSE_PATH_SEPARATOR`, `COMPOSE_PROFILES`, `COMPOSE_ENV_FILES` and the `!reset` / `!override` merge tags are honoured.
- New setting `effectiveConfig.compose.files` lists the compose files to load, like `docker compose -f`. The env file and the env-file dropdown then come from the first listed file's folder.
- Compose files, `COMPOSE_FILE` entries and `env_file` paths outside the workspace are read with an info naming each one; missing `COMPOSE_FILE` entries are watched.
- Compose files get the Explorer and editor-title triggers.
- Internal: `parseYamlLayer` accepts `knownTags` and reports tagged nodes and null scalars.

- Node provider: `package.json` folders with `.env` files are shown as `[Node]` projects, with the `.env` order of the framework found in their dependencies: Vite, Next.js, Create React App, dotenv-flow, or a generic order for unknown frameworks.
- Node mode detection from `MODE` (Vite) and `NODE_ENV`; Next.js, CRA and dotenv-flow skip `.env.local` under `test`; `VITE_`, `NEXT_PUBLIC_` and `REACT_APP_` OS variables are shown even when no file defines them.
- New setting `effectiveConfig.node.framework` forces a framework instead of detecting it.

- Internal: shared `DotenvProviderBase` (env file layers, `{env}` patterns, expansion, OS filtering) now backs the Python provider; behaviour is unchanged.
- Internal: each ecosystem lives in its own folder and is registered with one line in `src/hostEcosystems.ts`.
- "No project" messages no longer name specific languages.
- Internal: `parseYamlLayer` reads YAML layers with line and column provenance (multiple documents, anchors, merge keys). No language uses it yet.

## 0.2.0

- Python provider: merges `.env`, `.env.{env}`, `.env.local` and `.env.{env}.local` with OS variables in python-dotenv order (OS wins by default, `fileOverridesOs` to flip).
- Profiles from `.vscode/launch.json` (`debugpy` / `python`) with `env` and `envFile`, and environment detection from `APP_ENV` / `ENV` / `ENVIRONMENT` / `PYTHON_ENV`.
- `${VAR}` / `${VAR:-default}` expansion with secret propagation: values expanded from secrets stay masked.
- `*TOKEN*` added to the default mask patterns (also affects .NET).
- Mixed workspaces: .NET and Python projects in one project switcher, `.env*` Explorer and editor-title triggers.

## 0.1.0 — initial release

- Merged .NET configuration viewer with tree and flat views, search, and per-value provenance with override chains.
- Simulated default `WebApplication.CreateBuilder` merge order: JSON layers, user secrets, environment variables, command-line args.
- Project, launch profile and environment selection.
- Masking of sensitive values with per-value reveal.
- Copy value, key path or environment variable name; export as JSON or `KEY=value`.
- Auto-refresh on configuration file changes.
