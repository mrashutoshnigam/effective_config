# Docker Compose environment support — design

Ticket: [#7 E3: Docker Compose environment support](https://github.com/mrashutoshnigam/effective_config/issues/7). Depends on #4 (dotenv provider base, ecosystem registry) and #5 (YAML parser with provenance), both merged.

## Intent

Show the final environment a Compose service's container would receive, with the winning value and the override chain for every variable, so a developer can see why a container got a value without running `docker compose config`.

## Goals

- A new `[Compose]` ecosystem in its own folder (`src/compose/`), registered in `src/hostEcosystems.ts`. No host code changes beyond the registry and `package.json`.
- Reads `compose.yaml` / `compose.yml` / `docker-compose.yaml` / `docker-compose.yml` and their override files.
- Simulates `env_file:` (string, list, and long `{ path, required }` form), `environment:` (map and list forms), `.env` interpolation, `--env-file`, Compose `profiles` and override files.
- Interpolation syntax: `$VAR`, `${VAR}`, `${VAR:-d}`, `${VAR-d}`, `${VAR:?e}`, `${VAR?e}`, `${VAR:+r}`, `${VAR+r}`, nested expressions in defaults, and `$$` as a literal `$`.
- Missing required variables (`:?` / `?`) are reported as error diagnostics at the location of the expression, using the author's message.

## Non-goals

- `extends:`, top-level `include:`, Dockerfile `ENV`, `docker compose run -e`, `secrets:`/`configs:`, `-p` project names. When `extends` or `include` is present, raise one info diagnostic saying it is not simulated.
- Running Docker or calling `docker compose config`. Everything is simulated from files.

## Anti-goals

- No diagnostic or label quotes a variable's value (follow the convention in `src/sources/yamlLayer.ts`). The author's `:?` message is text from the compose file and may be shown.
- Compose files are untrusted input: interpolation must be bounded (nesting depth, output length) so a crafted file cannot hang the extension host. The YAML limits from #5 already cover alias expansion.

## Decided with the user

- **The service picker is the profile.** `ProjectDescription.profiles` lists the project's service names in source order of the merged model. The first service is preselected.
- **The environment dropdown is `--env-file`.** `environments` lists the env files in the project directory (`.env` and every `.env.*` file, plus `*.env`), with `.env` as the default. Selecting one simulates `docker compose --env-file <that file>`. If `COMPOSE_ENV_FILES` is set in the OS environment, its first file becomes the default selection.
- **Compose files follow Compose's own discovery.** The order is: the `effectiveConfig.compose.files` setting when non-empty (like `-f`, paths relative to the project directory, lowest priority first), else `COMPOSE_FILE` (from the OS environment, then the selected env file; split on `COMPOSE_PATH_SEPARATOR`, default `;` on Windows and `:` elsewhere), else the first existing primary file in the order listed under Goals plus its matching override file (`compose.override.yaml|yml` or `docker-compose.override.yaml|yml`).
- **Services gated by a profile stay in the picker.** Selecting one whose profiles are not active (`COMPOSE_PROFILES` from the OS environment, then the env file) adds an info diagnostic naming the profiles it needs. Profiles do not change any values.

## Precedence model

Interpolation scope, highest first: OS environment, then the selected env file. The env file is parsed with the existing dotenv parser and may reference its own earlier variables and the OS environment.

Container environment, lowest priority first, one engine layer each:

1. Each `env_file` entry of the service, in merged order (`kind: 'composeEnvFile'`, label = the env file's relative path). Values in these files are interpolated as Compose v2 does.
2. The service's `environment:` from each compose file, base file first, then each override file (`kind: 'composeEnvironment'`, label = `environment (<compose file name>)`). Values are interpolated against the scope.

Because the base and override `environment:` blocks are separate layers, an override file's value shows the base value as overridden, which gives the override chain the acceptance criteria ask for. Locations come from the YAML parser, so every value jumps to its line and column.

A bare list entry (`- FOO`) or null map value (`FOO:`) takes its value from the interpolation scope. When the scope does not define it, the variable is not set in the container: no entry, and an info diagnostic.

Interpolated values record the variable names they read in `LayerEntry.references`, so the existing masking marks a value as sensitive when it was built from a sensitive variable.

## Settings

- `effectiveConfig.compose.files`: string array, default `[]`. Explicit compose files, like `-f`.

Declared in `package.json` with a description and default. The explorer and editor title menus also match compose file names.

## Discovery

A project is each directory that holds a primary compose file (ignored folders as for Node). Kind `compose`, tag `[Compose]`, `projectFile` = the primary compose file, `ownsFileName` claims compose and override file names. Registered before Python, so a workspace root with `compose.yaml` and `.env` gets no Python fallback project. A directory holding both `package.json` and `compose.yaml` yields both a Node and a Compose project.

## Watch targets

Every compose file that was read or considered, every env file in the dropdown, and every `env_file` path, whether it exists or not.

## Planner's calls (from the builder check)

- **Service list and env files.** `describe()` runs once, before any selection, so it builds the service list from the default env file. `buildLayers()` uses the selected env file. When that env file's `COMPOSE_FILE` loads files where the selected service does not exist, report an error diagnostic and return no layers. The host does not change.
- **Required-variable scope.** Real Compose rejects the whole configuration when any loaded file has an unresolved `:?`/`?` variable. So every scalar in every loaded compose file is interpolation-checked, and each failure is an error diagnostic at its location. Values are only built for the selected service.
- **`!reset` and `!override`.** These merge tags are supported on a service's `environment` and `env_file` in override files. `!reset` drops what lower files set. `!override` replaces it instead of merging. Dropped layers are left out rather than shown as overridden. On other fields the tags are accepted and ignored. If the #5 parser rejects unknown tags, it gets a small, tested extension that keeps the tag on the node.
- **Project directory.** As in Compose, the project directory is the directory of the first compose file loaded. `.env`, the env-file dropdown and relative `env_file` paths resolve from it. `env_file` paths resolve against the compose file that declares them.
- **Case of variable names.** Keys are matched case-insensitively by the engine, as for the Node and Python ecosystems. `PATH` and `Path` merge as one key. This is accepted, and the README notes it.
- **`effectiveConfig.compose.files` scope.** The setting has `resource` scope. A listed file that does not exist gives an error diagnostic, and the other files are still read.

## Left to the builder

- How `env_file` and `environment` merge across compose files: follow the compose-spec merge rules (`environment` merged by variable name; `env_file` per the spec). Check them against the spec and record the source in a code comment.
- Exactly how Compose v2 interpolates inside `env_file` contents and resolves bare `- FOO` entries. Verify against Compose documentation and record the source.
- When a `:?` variable is missing, keep the key with an empty value next to the error diagnostic, so the key stays visible. (Planner's call; change it if Compose docs suggest otherwise.)
- Missing `env_file` entries: `required: false` gives an info diagnostic; otherwise an error diagnostic.
- Module split inside `src/compose/`, merge label wording, fixture layout under `test/fixtures/`.

## Approaches considered

1. **Env dropdown is `--env-file`, Compose's own file discovery, one setting for `-f` (picked).** Switching env files is one click, the picker pair (service, env file) fits the existing `Selection`, and defaults match a plain `docker compose up`.
2. **Settings only** (`compose.envFiles`, `compose.files`, `compose.profiles`). Less UI work, but switching env files means editing settings, and the environment dropdown would be empty.
3. **Shell out to `docker compose config`.** Exact results, but needs Docker installed, loses line provenance, and runs a binary against untrusted workspaces. Rejected.

## Delivery

Per the ticket's delivery rules: TDD, Vitest unit tests for every parser and provider path including errors, a fixture project with overrides, interpolation and a missing `:?` variable, an `@vscode/test-electron` integration test asserting the panel state, README and CHANGELOG updates, doc comments on every new type and function.
