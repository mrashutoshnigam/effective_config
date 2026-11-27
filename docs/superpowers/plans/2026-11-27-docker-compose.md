# Docker Compose Environment Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `[Compose]` ecosystem that shows the final environment of a chosen Compose service, with the winner and override chain per variable and diagnostics for missing `:?` variables.

**Architecture:** A new `src/compose/` folder with four pure modules (interpolation, compose file and env scope resolution, compose model and merge, provider), plus discovery and ecosystem wiring registered before Python in `src/hostEcosystems.ts`. Compose files are read with the #5 YAML parser, which gains tag and null-key reporting. The provider maps the service picker to `Selection.profile` and the env-file dropdown to `Selection.environment`.

**Tech Stack:** TypeScript, `yaml` 2.9.1, Vitest (unit), `@vscode/test-electron` + Mocha (integration).

**Spec:** `docs/superpowers/specs/2026-11-27-docker-compose-design.md`, which implements issue #7. Read both.

## Global Constraints

- Every new type, function, method and property has a `/** */` doc comment, in the repo's existing style (`@param`, `@returns`). Every test has a doc comment saying what it validates and the expected outcome.
- No diagnostic message or layer label quotes a variable's value. The `:?` author message may be shown.
- No new runtime dependencies.
- Conventional commits (`test:`, `feat:`, `fix:`, `docs:`, `refactor:`), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit failing tests before the implementation.
- Validation before reporting done: `npm run lint`, `npm run test:unit`, `npm run test:integration` all pass, including the existing .NET, Python and Node suites.
- Layer kinds: `composeEnvFile`, `composeEnvironment`. Project kind `compose`, tag `[Compose]`.
- Merge label, verbatim: `Simulated — docker compose (environment: over env_file, OS variables win in interpolation)`.

## Review Focus

1. **Bare `- FOO` with `FOO` set only in the OS environment.** The container gets the OS value, with the `environment (<file>)` layer as winner. Pinned in Task 5.
2. **`$$` next to a variable** (`$${HOME}` gives literal `${HOME}`, with no lookup and no reference). Pinned in Task 2.
3. **An override file that sets one variable without `!reset`.** The base file's other variables survive, and the overridden one shows the base value in its override chain. Pinned in Task 4.
4. **A crafted default nesting** (`${A:-${A:-${A:-…}}}`, 10 000 levels deep). One error diagnostic, no stack overflow or hang. Pinned in Task 2.
5. **CRLF compose files and a BOM.** Locations stay correct, because the YAML parser strips the BOM. Pinned in Task 4.

---

### Task 1: YAML parser reports tags and null scalars

**Files:**
- Modify: `src/sources/yamlLayer.ts` (`parseYamlLayer` signature, `YamlLayerParseResult`, `DocumentFlattener`)
- Test: `test/unit/yamlLayer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface YamlLayerOptions { /** Tags (e.g. `!reset`) accepted on any node and reported in `tags`. */ knownTags?: readonly string[] }
  // added to YamlLayerParseResult:
  tags: { key: string; tag: string; location: SourceLocation }[]; // flattened key of each node carrying a known tag
  nullKeys: string[];                                              // flattened keys whose scalar was null (`FOO:`, `~`, `null`)
  export function parseYamlLayer(text: string, filePath: string, options?: YamlLayerOptions): YamlLayerParseResult
  ```

- [ ] **Step 1: Write failing tests** in `test/unit/yamlLayer.test.ts`:
  - `reports known tags with their flattened key`: `services:\n  web:\n    environment: !reset {}\n` with `{ knownTags: ['!reset', '!override'] }` gives `tags` equal to `[{ key: 'services:web:environment', tag: '!reset', location: { line: 2, column: 17 } }]` (check `filePath` too), and `diagnostics` equal to `[]`.
  - `unknown tags still warn`: the same text with no options gives a diagnostic whose message starts with `YAML warning:`. This is current behaviour; the test pins it.
  - `!override on a sequence keeps its items`: `env_file: !override\n  - a.env\n` gives the entry `env_file:0` = `a.env`, and the tag on `env_file`.
  - `null scalars are listed in nullKeys`: `a:\nb: ~\nc: ""\nd: null\n` gives `nullKeys` `['a', 'b', 'd']`, and all four entries keep value `''`.
- [ ] **Step 2: Run** `npx vitest run test/unit/yamlLayer.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Commit** with `test: specify YAML tag and null-key reporting`.
- [ ] **Step 4: Implement.** Pass `customTags` to `parseAllDocuments` for each known tag on map, seq and scalar. Each is an identity resolver, for example `{ tag, collection: 'map', resolve: (m) => m }` plus `seq` and a scalar variant. Record tags and nulls in `DocumentFlattener` as nodes are visited, including nodes reached through aliases and merges, under the key they are flattened to. Both new fields are always present (empty arrays by default).
- [ ] **Step 5: Run** `npx vitest run test/unit/yamlLayer.test.ts`. Expected: all PASS, and the existing YAML tests are unchanged.
- [ ] **Step 6: Commit** with `feat: report YAML tags and null scalars`.

### Task 2: Compose interpolation

**Files:**
- Create: `src/compose/interpolation.ts`
- Test: `test/unit/composeInterpolation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InterpolationResult {
    value: string;                 // expanded text
    references: string[];          // distinct variable names read, first-seen order
    unset: string[];               // names read with no default that were unset (Compose warns, uses "")
    errors: string[];              // messages: required-variable failures and format errors
  }
  export function interpolate(text: string, lookup: (name: string) => string | undefined): InterpolationResult
  export const MAX_INTERPOLATION_DEPTH = 32;
  export const MAX_INTERPOLATED_LENGTH = 1_000_000;
  ```

Semantics (from the Compose interpolation docs):
- `$$` gives `$`.
- `$VAR` and `${VAR}` give the value, or `''` plus an `unset` entry.
- `${VAR:-d}`: `d` when VAR is unset or empty. `${VAR-d}`: `d` only when unset.
- `${VAR:?e}`: error when unset or empty. `${VAR?e}`: error only when unset.
- `${VAR:+r}`: `r` when VAR is set and non-empty, else `''`. `${VAR+r}`: `r` when set, else `''`.
- `d`, `r` and `e` are interpolated recursively.
- Names match `[A-Za-z_][A-Za-z0-9_]*`. A `$` followed by anything else stays literal.

Exact error copy:
- `required variable NAME is missing a value: e` (when `e` is empty: `required variable NAME is missing a value`)
- `invalid interpolation format for NAME` (an unterminated `${`, with `NAME` being what follows `${`, up to 40 chars)
- `interpolation nests deeper than 32 levels`
- `interpolated value exceeds 1000000 characters`

When an error occurs, `value` is the expansion with the failing expression replaced by `''`.

- [ ] **Step 1: Write failing tests**, one `it` per semantic rule above. Each asserts `value`, `references`, `unset` and `errors` exactly. Also include:
  - `$${HOME}` gives `${HOME}`, with `references` `[]`.
  - `${A:-${B:-x}}`, with neither set, gives `x` and references `['A', 'B']`.
  - `deep nesting is bounded`: `'${A:-'.repeat(10000) + 'x' + '}'.repeat(10000)` returns one error, `interpolation nests deeper than 32 levels`, and doesn't throw.
  - `output length is bounded`: a lookup returning a 600 000-char value for `${A}${A}` gives the length error.
  - `${FOO` gives `invalid interpolation format for FOO`.
- [ ] **Step 2: Run** `npx vitest run test/unit/composeInterpolation.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Commit** with `test: specify Compose variable interpolation`.
- [ ] **Step 4: Implement `interpolate`** as a single left-to-right scanner. Find each `}` with a brace-depth counter, not a regex, so nested defaults work. Recurse for `d`/`r`/`e` with a depth argument, and check the length after each append.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: interpolate Compose variables`.

### Task 3: Compose files, env files and interpolation scope

**Files:**
- Create: `src/compose/composeFiles.ts`
- Test: `test/unit/composeFiles.test.ts`

**Interfaces:**
- Consumes: `parseDotenv`, `DotenvEntry` from `src/sources/dotenv.ts`; `VarMap` from `src/sources/dotenvProviderBase.ts`; `FileSystem`; `interpolate` (Task 2).
- Produces:
  ```ts
  export const PRIMARY_COMPOSE_FILES: readonly string[] = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  export const OVERRIDE_COMPOSE_FILES: readonly string[] = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
  export const DEFAULT_ENV_FILE = '.env';
  /** Env files offered in the dropdown: `.env` first, then other `.env.*` and `*.env` files, sorted case-insensitively. */
  export function listComposeEnvFiles(fileNames: string[]): string[];
  /** Interpolation scope: the env file parsed and interpolated top to bottom against OS + earlier lines, then the OS environment on top. */
  export interface ComposeScope { vars: VarMap; envFilePath: string; envFileFound: boolean; diagnostics: Diagnostic[] }
  export async function readComposeScope(fs: FileSystem, projectDir: string, envFile: string, osEnv: Record<string, string>): Promise<ComposeScope>;
  /** Compose files in load order (base first) and the project directory (first file's directory). */
  export interface ComposeFileSet { files: string[]; projectDir: string; diagnostics: Diagnostic[] }
  export async function resolveComposeFiles(fs: FileSystem, primaryFile: string, settingFiles: string[], scope: VarMap, platform?: NodeJS.Platform): Promise<ComposeFileSet>;
  /** Active profiles from COMPOSE_PROFILES (comma separated, trimmed, empties dropped). */
  export function activeProfiles(scope: VarMap): string[];
  ```

Rules:
- `resolveComposeFiles` picks the files in this order:
  1. `settingFiles` when non-empty, relative to `dirname(primaryFile)`. A missing file gives the error `compose file not found: <relative path>`, and that file is skipped.
  2. Otherwise `COMPOSE_FILE`, split on `COMPOSE_PATH_SEPARATOR`, defaulting to `;` on `win32` and `:` elsewhere.
  3. Otherwise the first existing name of `PRIMARY_COMPOSE_FILES` in `dirname(primaryFile)`, then the override file of the same family (`compose.*` with `compose.override.*`, `docker-compose.*` with `docker-compose.override.*`, either extension).
- `readComposeScope`: a missing env file is not a diagnostic when it is `.env`. Any other missing env file gives a warning, `env file not found: <name>`. Unset references inside the env file give no diagnostics.

- [ ] **Step 1: Write failing tests** with an in-memory `FileSystem`, following `test/unit/nodeProvider.test.ts` style:
  - `listComposeEnvFiles(['app.env', '.env.prod', 'x.txt', '.env'])` gives `['.env', '.env.prod', 'app.env']`, and `[]` input gives `['.env']`.
  - Scope: the OS value wins over the env file. A line `B=${A}-x` after `A=1` gives `1-x`.
  - Default discovery: `compose.yaml` + `compose.override.yml` gives both, in that order. `docker-compose.yml` alone gives one file.
  - `COMPOSE_FILE=a.yaml;b.yaml` on `win32` gives both. On `linux` with `COMPOSE_PATH_SEPARATOR=,`, `a.yaml,b.yaml` gives both.
  - Setting files win over `COMPOSE_FILE`. A missing setting file gives the error diagnostic.
  - `activeProfiles` of `' debug, ,tools'` gives `['debug', 'tools']`.
- [ ] **Step 2: Run** `npx vitest run test/unit/composeFiles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** with `test: specify Compose file and env scope resolution`.
- [ ] **Step 4: Implement** the exports above.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: resolve Compose files and interpolation scope`.

### Task 4: Compose model and service merge

**Files:**
- Create: `src/compose/composeModel.ts`
- Test: `test/unit/composeModel.test.ts`

**Interfaces:**
- Consumes: `parseYamlLayer(text, filePath, { knownTags: ['!reset', '!override'] })` (Task 1); `interpolate` (Task 2).
- Produces:
  ```ts
  export type MergeTag = '!reset' | '!override';
  export interface EnvFileRef { path: string /* absolute */; required: boolean; location: SourceLocation }
  export interface EnvironmentItem { name: string; raw: string | null /* null: take from scope */; location: SourceLocation }
  export interface ServiceFragment { name: string; profiles: string[]; envFiles?: EnvFileRef[]; envFilesTag?: MergeTag; environment?: EnvironmentItem[]; environmentTag?: MergeTag }
  export interface ComposeFileModel { filePath: string; services: ServiceFragment[] /* source order */; diagnostics: Diagnostic[] }
  /** Parses one compose file; also interpolation-checks every scalar against `lookup` and reports each error at its location. */
  export function readComposeFile(text: string, filePath: string, lookup: (name: string) => string | undefined): ComposeFileModel;
  export interface MergedService { name: string; profiles: string[]; envFiles: EnvFileRef[]; environmentLayers: { filePath: string; items: EnvironmentItem[] }[] }
  /** Merges one service across files (base first). Undefined when no file defines it. */
  export function mergeService(models: ComposeFileModel[], name: string): MergedService | undefined;
  /** Service names across all files, first-seen order. */
  export function serviceNames(models: ComposeFileModel[]): string[];
  ```

Rules:
- `environment` is either a map, or a list of `NAME=value` / `NAME`. `NAME=` gives `''`. A map key listed in `nullKeys` gives `raw: null`.
- `env_file` is a string, a list of strings, or a list of `{ path, required }` (`required` defaults to true). Each path resolves against the declaring file's directory.
- `extends` or a top-level `include` gives one info diagnostic per file: `extends and include are not simulated`.
- A `!reset` or `!override` tag on `environment` drops the environment layers of lower files. A tag on `env_file` drops lower files' env files.
- Without tags, `environment` layers stack per file. For merging `env_file` across files, verify the compose-spec merge rule (`merge.md`) and cite it in a comment.
- Interpolation errors give `{ severity: 'error', message, location }`. `unset` names give one warning per name per file: `variable NAME is not set; Compose uses an empty string`.

- [ ] **Step 1: Write failing tests:**
  - Map and list `environment` both give the right items. `FOO:` gives `raw: null`, and `FOO: ""` gives `raw: ''`.
  - The three `env_file` forms. `required: false` is kept.
  - `${DB_PASS:?set DB_PASS}` in `image:` of another service gives the error `required variable DB_PASS is missing a value: set DB_PASS` at that scalar's location.
  - Override without tag (Review Focus 3): the base sets `A`, `B` and the override sets `B`. This gives two environment layers, so `B` is in both and `A` only in the base.
  - `!reset {}` on the override's `environment` gives only the override layer, which is empty.
  - A `<<: *common` merge into `environment` gives items located at the anchor.
  - A CRLF file with a BOM gives locations matching the LF version (Review Focus 5).
  - `serviceNames` order across base and override.
- [ ] **Step 2: Run** `npx vitest run test/unit/composeModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** with `test: specify the Compose service model and merge`.
- [ ] **Step 4: Implement.** Work from the flattened entries: `services:<svc>:environment:<NAME|index>`, `services:<svc>:env_file[:<index>[:path|:required]]`, `services:<svc>:profiles:<index>`.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: read and merge Compose services`.

### Task 5: Compose provider

**Files:**
- Create: `src/compose/composeProvider.ts`
- Test: `test/unit/composeProvider.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `ConfigProvider`, `ProjectInfo`, `Selection` from `src/provider.ts`.
- Produces:
  ```ts
  export interface ComposeProviderOptions { fs: FileSystem; osEnv: Record<string, string>; files: string[] /* setting */; platform?: NodeJS.Platform }
  export class ComposeProvider implements ConfigProvider { constructor(options: ComposeProviderOptions) }
  ```

Behaviour:
- `describe`:
  - `profiles` is `serviceNames`, built with the default env file's scope. `environments` is `listComposeEnvFiles(projectDir listing)`.
  - The default selection is `{ profile: first service, environment: first entry of COMPOSE_ENV_FILES (OS, comma separated) when it is in the list, else '.env' }`.
  - `profileEnvironments` is `{}` and `envVarSeparator` is `'__'`. `mergeLabel` is the Global Constraints copy.
  - `watchGlobs` is the four primary names, the four override names, `.env`, `.env.*` and `*.env`.
- `buildLayers` runs in this order:
  1. Scope from `selection.environment`.
  2. Files.
  3. Models: parse diagnostics, plus required-variable errors from every file.
  4. Selected service. If missing, the error `service 'NAME' is not defined in the loaded compose files` and no layers.
  5. Profile check. The service has profiles and none is active: info `service 'NAME' starts only with profile(s) a, b; active: none` (active list comma separated).
  6. One `composeEnvFile` layer per env file. Label: the path relative to the project dir, with forward slashes. Values come from `parseDotenv`, then `interpolate` against the scope plus earlier lines of the same file (verify Compose v2 behaviour and cite it). A missing file with `required` gives the error `env file not found: <label>`. With `required: false` it gives an info diagnostic with the same text.
  7. One `composeEnvironment` layer per compose file that defines `environment` for the service. Label: `environment (<compose file name>)`.
     - Values come from `interpolate(raw, scope)`.
     - `raw: null` takes the value from the scope.
     - When the scope doesn't define it either, there is no entry, plus info `NAME is not set in the shell or the env file; Compose leaves it unset`.
     - A `:?` failure keeps the key with an empty value (errors were already reported in step 3).
  - Every entry's `references` is the interpolation references. Keys are the variable names, unchanged. `sensitive` is false.
  - `watchPaths` covers every compose file considered, every listed env file and every `env_file` path.

- [ ] **Step 1: Write failing tests** over an in-memory FS modelling the spec fixture (Task 7's files):
  - `describe` gives services `['api', 'worker']`, environments `['.env', '.env.prod', 'app.env']`, and default `{ profile: 'api', environment: '.env' }`.
  - `buildLayers` for `api` / `.env` gives layer labels in order `['app.env', 'environment (compose.yaml)', 'environment (compose.override.yaml)']`.
  - Switching to `.env.prod` changes `IMAGE_TAG`-derived `VERSION`.
  - The `:?` error is present.
  - Review Focus 1: bare `- HOME_DIR`, with OS `HOME_DIR=/home/u`, gives an entry with value `/home/u`.
  - Missing service, profile-gated service and missing optional env file each give their diagnostic.
  - An entry interpolated from `DB_PASSWORD` has `references: ['DB_PASSWORD']`.
- [ ] **Step 2: Run** `npx vitest run test/unit/composeProvider.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** with `test: specify the Compose provider`.
- [ ] **Step 4: Implement `ComposeProvider`.**
- [ ] **Step 5: Run** `npm run test:unit`. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: build Compose service layers`.

### Task 6: Discovery, settings and registration

**Files:**
- Create: `src/compose/projectDiscovery.ts`, `src/compose/settings.ts`, `src/compose/ecosystem.ts`
- Modify: `src/hostEcosystems.ts` (registry `[DOTNET, NODE, COMPOSE, PYTHON]`), `src/hostServices.ts` (`settingsSource(scope?: vscode.Uri)` passes the scope to `getConfiguration`), `package.json`
- Test: `test/unit/composeProjectDiscovery.test.ts`, `test/unit/composeSettings.test.ts`, extend `test/unit/providerRegistry.test.ts` if it asserts the registry order

**Interfaces:**
- Produces:
  ```ts
  export const COMPOSE_KIND = 'compose';
  export const IGNORED_FOLDERS: string[] = ['node_modules', '.git'];
  /** One project per directory holding a primary compose file; projectFile/id = first PRIMARY_COMPOSE_FILES name present; name = directory basename. */
  export function findComposeProjects(markerPaths: string[]): ProjectInfo[];
  export interface ComposeSettings { files: string[] }
  export function readComposeSettings(source: SettingsSource): ComposeSettings; // non-array or non-string items dropped; default []
  export const COMPOSE_ECOSYSTEM: Ecosystem; // tag '[Compose]', ownsFileName: primary or override names, case-insensitive
  ```
- `package.json` changes:
  - `effectiveConfig.compose.files`: array of strings, default `[]`, `"scope": "resource"`. Description: `Compose files to load, lowest priority first, like docker compose -f; relative to the project folder. Empty uses COMPOSE_FILE or the default compose.yaml and override file.`
  - Explorer and editor-title `when` gain `|| resourceFilename =~ /^(docker-)?compose(\.override)?\.ya?ml$/i`.
  - Keywords `docker`, `docker compose`.
  - The description adds `Docker Compose`.

- [ ] **Step 1: Write failing tests:**
  - A directory with both `compose.yaml` and `docker-compose.yml` gives one project with `compose.yaml`. Two directories give two projects, sorted by name.
  - Settings: default and invalid values.
  - The ecosystem `ownsFileName('Compose.Override.YML')` is true.
- [ ] **Step 2: Run** `npx vitest run test/unit/composeProjectDiscovery.test.ts test/unit/composeSettings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** with `test: specify Compose discovery and settings`.
- [ ] **Step 4: Implement.** `discover` uses `vscode.workspace.findFiles('**/{compose,docker-compose}.{yaml,yml}', '**/{node_modules,.git}/**')`. `createProvider(project)` reads settings via `settingsSource(vscode.Uri.file(project.dir))`.
- [ ] **Step 5: Run** `npm run lint && npm run test:unit`. Expected: PASS.
- [ ] **Step 6: Commit** with `feat: register the Compose ecosystem`.

### Task 7: Fixture and integration test

**Files:**
- Create: `test/fixtures/ComposeApp/compose.yaml`, `compose.override.yaml`, `.env`, `.env.prod`, `app.env`
- Create: `test/integration/composeProjects.test.ts` (helpers as in `test/integration/nodeProjects.test.ts`)

Fixture content:
- `compose.yaml` defines services `api` and `worker` (`worker` has `profiles: [jobs]`).
  - `api` has `env_file: app.env` and `environment:` map `LOG_LEVEL: info`, `VERSION: ${IMAGE_TAG:-latest}`, `DB_PASSWORD: ${DB_PASSWORD}`, `HOME_DIR:` (null).
  - `worker.image` is `img:${WORKER_TAG:?set WORKER_TAG}`.
- `compose.override.yaml` sets `api.environment` list form `- LOG_LEVEL=debug`.
- `app.env`: `LOG_LEVEL=warn`, `FROM_FILE=yes`.
- `.env`: `IMAGE_TAG=1.2`, `DB_PASSWORD=hunter2`.
- `.env.prod`: `IMAGE_TAG=2.0`.

- [ ] **Step 1: Write the integration test.** Open `ComposeApp/compose.yaml` and assert:
  - Kind `compose`, the label copy, profile `api` and environment `.env`.
  - `LOG_LEVEL` value `debug`, winner `environment (compose.override.yaml)`, overridden `['app.env', 'environment (compose.yaml)']`.
  - `VERSION` `1.2`. `DB_PASSWORD` masked. `FROM_FILE` winner `app.env`.
  - A diagnostic with message `required variable WORKER_TAG is missing a value: set WORKER_TAG` and severity `error`.
  - Then `sendMessage({ type: 'select', environment: '.env.prod' })` and assert `VERSION` is `2.0`.
  - Then open the `LOG_LEVEL` winner's source and assert the active editor is `compose.override.yaml`.
- [ ] **Step 2: Run** `npm run test:integration`. Expected: the new suite PASSES (Tasks 1–6 are done) and the existing suites pass. If the test passes on first run, temporarily break the winner label to see it fail once, then restore it.
- [ ] **Step 3: Commit** with `test: show Compose service environments in the real host`.

### Task 8: Docs

**Files:**
- Modify: `README.md` (a Docker Compose section matching the Node section's shape: what is read, precedence, interpolation forms, env-file dropdown, `compose.files` setting, `COMPOSE_FILE` / `COMPOSE_PROFILES` / `COMPOSE_ENV_FILES`, the case-insensitive variable-name note, non-goals), `CHANGELOG.md` (`## Unreleased` bullets)

- [ ] **Step 1: Write the docs.** Every claim must match the implemented behaviour.
- [ ] **Step 2: Commit** with `docs: document Docker Compose support`.
