# Changelog

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
