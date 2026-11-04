# Effective Config Viewer — Python addendum

Status: agreed 2026-11-04. Extends `2026-11-04-effective-config-design.md`; everything there (UI, masking, provenance, copy/export, refresh, architecture) applies unless changed here.

## Scope

Add a Python provider beside the .NET one. Same command, same panel, same engine.

## Projects

- A Python project = a folder containing `.env` or any `.env.*` file AND one marker: `pyproject.toml`, `requirements.txt`, `setup.py`, `setup.cfg`, `Pipfile`.
- Fallback: when no marker-based project exists in a workspace folder whose root has a `.env`, that root is a Python project, unless the root already contains a .NET project at or under it (a .NET repo with a stray `.env`, e.g. for docker-compose, gets no `[Python]` project).
- Ignored folders: `node_modules`, `.venv`, `venv`, `env`, `__pycache__`, `site-packages`, `.git`, `bin`, `obj`.
- Project switcher lists .NET and Python projects together, tagged `[.NET]` / `[Python]`.
- Opened from: Command Palette, Explorer context menu and editor-title button on `.env` / `.env.*` files (plus existing .NET triggers). A file owned by both a .NET and a Python project (same folder) goes to the provider matching the file type.

## Layers (default: OS variables win)

Lowest priority first:

1. `.env`
2. `.env.{env}`
3. `.env.local`
4. `.env.{env}.local`
5. Environment (OS) — filtered (below)
6. Profile `envFile` (from `.vscode/launch.json`)
7. Profile `env` (from `.vscode/launch.json`)

File list configurable: `effectiveConfig.python.envFiles` (default above, `{env}` placeholder). Missing files skipped.

`effectiveConfig.python.fileOverridesOs` (default `false`): when `true` (python-dotenv `override=True`), the file layers 1–4 move above layers 5–7.

UI label: `Simulated — python-dotenv order (OS variables win)`, or `Simulated — python-dotenv order (files override OS)` when `fileOverridesOs` is true.

## OS variable filter

An OS variable is shown only when its key matches (case-insensitively) a key defined in a file or profile layer, or its name starts with a prefix in `effectiveConfig.python.envPrefixes` (default `[]`, case-insensitive).

## Keys

- Keys split on `effectiveConfig.python.nestedDelimiter` (default `__`) into the tree; empty string = flat keys.
- Matching is case-insensitive; display casing from the lowest layer (as for .NET).
- "Copy env var name" and `KEY=value` export join segments with the same delimiter (flat keys export as-is).

## .env parsing (python-dotenv rules)

- `KEY=value`, optional `export ` prefix, whitespace around `=` ignored, blank lines and `#` comment lines ignored.
- Unquoted values: trimmed; ` #` starts an inline comment.
- Single-quoted: literal, no escapes, no expansion.
- Double-quoted: escapes `\n \r \t \\ \" \'`, may span multiple lines, expansion applies.
- `KEY` with no `=` → skipped with an info diagnostic (python-dotenv yields `None` and `load_dotenv` does not set it).
- Expansion in unquoted and double-quoted values: `${VAR}` and `${VAR:-default}`. Lookup: with `fileOverridesOs=false`, process environment (OS + profile env/envFile) first, then keys defined earlier in the same file and lower file layers; with `true`, file values first. Unresolved → default or empty string.
- Unparseable line → warning diagnostic with file and line; the rest of the file still loads.
- Positions: value start line/column for click-through.

## Masking

- Reuse `effectiveConfig.maskPatterns`; add `*TOKEN*` to the defaults (applies to .NET too).
- A `.env*` file layer is sensitive when its pattern contains `secret`.
- A value expanded from a sensitive key (pattern match or sensitive layer) is itself sensitive, transitively — a `DATABASE_URL` built from `${DB_PASSWORD}` is masked.
- The override chain shows which keys an expanded value used.

## Profiles and environment

- Profiles = configurations in the nearest `.vscode/launch.json` (searched from the project folder up to the workspace folder) whose `type` is `debugpy` or `python`. `${workspaceFolder}` in `envFile` is substituted; relative `envFile` resolves against the workspace folder.
- Environment name: first of `APP_ENV`, `ENV`, `ENVIRONMENT`, `PYTHON_ENV` (setting `effectiveConfig.python.environmentVariables`) found in the profile `env`, then profile `envFile`, then `.env`, then OS; else `development`.
- Environment list: `development`, `staging`, `production`, then names from existing `.env.<name>` files, excluding `local`, `example`, `sample`, `template`, `defaults` and `*.local`.

## Known limitations (Python)

`.flaskenv`, Django settings modules, `os.environ` reads in code, conda `environment.yml`, direnv `.envrc`, Poetry/pipenv auto-loading, pydantic `secrets_dir`, and app-specific loaders are not reflected.
