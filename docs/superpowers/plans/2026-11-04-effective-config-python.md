# Effective Config Viewer — Python Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Python provider (`.env` files, launch.json profiles, OS env) to the existing extension, sharing the engine, panel and webview.

**Architecture:** A new pure `PythonProvider` (src/python, no `vscode`) implements `ConfigProvider` using a new python-dotenv parser (src/sources/dotenv.ts). The engine gains value-expansion references (with sensitivity propagation) and a configurable env-var separator. The host picks the provider by `ProjectInfo.kind`, discovers Python projects, and takes the merge label and project watch globs from the provider instead of .NET constants.

**Tech Stack:** unchanged — TypeScript, esbuild, jsonc-parser, Vitest (+jsdom), @vscode/test-cli against local VS Code.

**Spec:** `docs/superpowers/specs/2026-11-04-effective-config-python.md` (addendum to `docs/superpowers/specs/2026-11-04-effective-config-design.md`)

## Global Constraints

- Nothing under `src/engine`, `src/sources`, `src/dotnet`, `src/python` may import `vscode`.
- Every exported function/type/class gets a TSDoc comment; every test name states behavior and expected outcome.
- Default mask patterns verbatim: `*Password*`, `*Secret*`, `*Key*`, `*TOKEN*`, `ConnectionStrings:*`.
- Default Python env files verbatim: `.env`, `.env.{env}`, `.env.local`, `.env.{env}.local`.
- Default env-name variables verbatim: `APP_ENV`, `ENV`, `ENVIRONMENT`, `PYTHON_ENV`.
- Python merge labels verbatim: `Simulated — python-dotenv order (OS variables win)` / `Simulated — python-dotenv order (files override OS)`. .NET label unchanged: `Simulated — default WebApplication.CreateBuilder order`.
- New settings (exact names, defaults): `effectiveConfig.python.envFiles` (list above), `effectiveConfig.python.fileOverridesOs` (`false`), `effectiveConfig.python.envPrefixes` (`[]`), `effectiveConfig.python.nestedDelimiter` (`"__"`), `effectiveConfig.python.environmentVariables` (list above).
- Python environment defaults are lowercase: `development`, `staging`, `production`.
- Secrets never reach the webview, clipboard, export or diagnostics unless revealed/confirmed — including values expanded from secrets.
- Commit format: summary line, blank line, one `- \`<file>\`: <change>` bullet per file, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Version bump to `0.2.0` happens in Task 6 only.

## Review Focus

1. **`.env.example` / `.env.sample` committed with placeholder secrets** — must not appear as an environment or a layer. Test in Task 3.
2. **`DATABASE_URL=postgres://u:${DB_PASSWORD}@h`** — the expanded URL is masked even though its key matches no pattern. Tests in Task 1 (propagation) and Task 4 (end to end).
3. **Windows CRLF `.env` files and a trailing line without newline** — parse identically to LF. Test in Task 2.
4. **A folder with both a `.csproj` and `pyproject.toml`** — right-clicking `appsettings.json` opens .NET, `.env` opens Python. Test in Task 5.
5. **`launch.json` with comments, non-Python configs, `${workspaceFolder}` envFile, and a missing envFile** — only Python configs become profiles; missing envFile is a warning, not an error. Test in Task 3/4.

---

## File Structure

```
src/engine/types.ts        + LayerKind 'dotenv' | 'envFile'; LayerEntry.references; Contribution.references
src/engine/merge.ts        + sensitivity propagation through references
src/engine/keys.ts         keyToEnvVarName(key, separator = '__'); delimitedNameToKey(name, delimiter)
src/engine/export.ts       toEnvLines(entries, valueOf, separator = '__')
src/sources/dotenv.ts      parseDotenv, expandDotenvValue
src/python/environments.ts DEFAULT_ENV_FILES, DEFAULT_ENV_NAME_VARIABLES, listPythonEnvironments
src/python/launchJson.ts   parsePythonLaunchConfigs
src/python/projectDiscovery.ts findPythonProjects (pure, FileSystem-based)
src/python/pythonProvider.ts PythonProvider
src/provider.ts            ProjectInfo.kind; ProjectDescription.mergeLabel, envVarSeparator, watchGlobs
src/dotnet/dotnetProvider.ts  returns mergeLabel / envVarSeparator / watchGlobs
src/dotnet/projectDiscovery.ts findOwningProject(filePath, projects, preferredKind?)
src/panel/*, src/extension.ts, src/webview/toolbar.ts, package.json, README.md, CHANGELOG.md
test/fixtures/PyApp/ (pyproject.toml, .env, .env.development, .env.production, .env.local, .env.example, .env.profile, .vscode/launch.json)
test/fixtures/Mixed/ (Mixed.csproj, appsettings.json, pyproject.toml, .env)
```

Test helpers are local to each test file.

---

### Task 1: Engine — references, sensitivity propagation, separators

**Files:** Modify `src/engine/types.ts`, `src/engine/merge.ts`, `src/engine/keys.ts`, `src/engine/export.ts`, `src/panel/viewModel.ts`, `src/panel/messages.ts`, `src/panel/actions.ts`, `src/webview/tree.ts`; tests `test/unit/merge.test.ts`, `keys.test.ts`, `export.test.ts`, `viewModel.test.ts`, `actions.test.ts`, `test/webview/render.test.ts`.

**Interfaces — Produces:**
- `LayerKind` adds `'dotenv' | 'envFile'`.
- `LayerEntry.references?: string[]` and `Contribution.references?: string[]` — keys (`:` form) a value was expanded from; copied by `mergeLayers`.
- `mergeLayers` sensitivity rule: a contribution is sensitive if `layer.sensitive || isSensitiveKey(key)` OR any referenced key is sensitive (pattern match on the referenced key, or that key's merged entry is sensitive); propagate to a fixpoint (cycles terminate).
- `keyToEnvVarName(key: string, separator = '__'): string`; `delimitedNameToKey(name: string, delimiter: string): string` (empty delimiter → name unchanged; else split on delimiter, join `:`); `envVarNameToKey(name)` stays `delimitedNameToKey(name, '__')`.
- `toEnvLines(entries, valueOf, separator = '__')`; `copyText(entries, path, what, revealed, separator = '__')`; `exportText(entries, format, revealAll, separator = '__')`.
- `ViewNode.winner.references?: string[]` and each `overridden[i].references?: string[]` — always sent (key names only, never values). Webview chain shows `uses: A, B` after the value.

- [ ] **Step 1: Failing tests**
```ts
// merge: "value expanded from a pattern-matched key is sensitive — DATABASE_URL masked"
const r = mergeLayers([L('f', [{ key: 'DATABASE_URL', value: 'pg://u:pw@h', references: ['DB_PASSWORD'] }, { key: 'DB_PASSWORD', value: 'pw' }])], ['*Password*']);
expect(r.find(e => e.key === 'DATABASE_URL')!.sensitive).toBe(true);
// "transitive reference to a sensitive-layer key is sensitive"; "reference cycle terminates — A↔B not sensitive"
// "references copied onto contributions"
expect(keyToEnvVarName('A:B', '_')).toBe('A_B');
expect(delimitedNameToKey('DB__HOST', '__')).toBe('DB:HOST');
expect(delimitedNameToKey('DB__HOST', '')).toBe('DB__HOST');
// actions: "envVarName uses the given separator"; export: "env lines joined with given separator"
// viewModel: "references passed through for winner and overridden"; render: "chain shows 'uses: DB_PASSWORD'"
```
- [ ] **Step 2:** `npx vitest run test/unit test/webview` — FAIL.
- [ ] **Step 3:** Implement. Propagation: after building accumulators, loop: for each acc, for each contribution with `references`, if any `normalizeKey(ref)` maps to an acc with any sensitive contribution or `isSensitiveKey(ref, patterns)` → mark contribution sensitive; repeat until no change.
- [ ] **Step 4:** `npm run lint && npm run test:unit` — PASS.
- [ ] **Step 5:** Commit `Add value references, sensitivity propagation and env-var separators`.

---

### Task 2: python-dotenv parser and expansion

**Files:** Create `src/sources/dotenv.ts`; test `test/unit/dotenv.test.ts`.

**Interfaces — Produces:**
```ts
export interface DotenvEntry { name: string; value: string; expand: boolean; location: SourceLocation }
export function parseDotenv(text: string, filePath: string): { entries: DotenvEntry[]; diagnostics: Diagnostic[] };
export function expandDotenvValue(value: string, lookup: (name: string) => string | undefined): { value: string; references: string[] };
```
Rules per spec "`.env` parsing". `expand` is false for single-quoted values. `location` = 0-based line/column of the value's first character (after the opening quote for quoted values). Strip a leading BOM (reuse `stripBom` from jsonLayer). Bare `KEY` → skipped + `info` "'KEY' has no value; python-dotenv does not set it". Bad line → `warning` `Cannot parse line <n+1>` with location; continue. `references` = distinct names looked up, in order (including unresolved ones). `${VAR:-default}` uses default when lookup is undefined or empty string.

- [ ] **Step 1: Failing tests**
```ts
const { entries } = parseDotenv('export A=1\nB = two words # c\nC=\'lit ${A}\'\nD="x\\ny ${A}"\nE="multi\nline"\nF\n', '/p/.env');
expect(entries.map(e => [e.name, e.value, e.expand])).toEqual([
  ['A','1',true], ['B','two words',true], ['C','lit ${A}',false], ['D','x\ny ${A}',true], ['E','multi\nline',true]]);
expect(entries[1].location).toEqual({ filePath: '/p/.env', line: 1, column: 4 });
expect(expandDotenvValue('pg://${U}:${P:-none}@h', n => ({ U: 'u' } as Record<string,string>)[n]))
  .toEqual({ value: 'pg://u:none@h', references: ['U', 'P'] });
// "CRLF and missing final newline parse like LF" (Review Focus 3)
// "unparseable line warns with line number and later lines still load"
// "bare KEY skipped with info diagnostic"; "hash inside quotes is not a comment"; "BOM stripped"
// "unterminated double quote warns and stops at end of file"
```
- [ ] **Step 2:** `npx vitest run test/unit/dotenv.test.ts` — FAIL.
- [ ] **Step 3:** Implement with a small line/char scanner (no regex-only parsing for quoted multi-line values).
- [ ] **Step 4:** Run — PASS; `npm run lint`.
- [ ] **Step 5:** Commit `Add python-dotenv compatible parser and variable expansion`.

---

### Task 3: Python environments, launch.json profiles, project discovery

**Files:** Create `src/python/environments.ts`, `src/python/launchJson.ts`, `src/python/projectDiscovery.ts`; tests `test/unit/pythonEnvironments.test.ts`, `pythonLaunchJson.test.ts`, `pythonProjectDiscovery.test.ts`.

**Interfaces — Consumes:** `FileSystem` (src/dotnet/fileSystem.ts), `ProjectInfo` (Task 5 adds `kind`; this task returns objects with `kind: 'python'` — add the optional field to `ProjectInfo` here as `kind?: 'dotnet' | 'python'`, made required in Task 5).
**Produces:**
```ts
// environments.ts
export const DEFAULT_ENV_FILES: string[];            // per Global Constraints
export const DEFAULT_ENV_NAME_VARIABLES: string[];   // per Global Constraints
export function listPythonEnvironments(fileNames: string[]): string[];
// launchJson.ts
export interface PythonLaunchConfig { name: string; env: Record<string, string>; envFile?: string }
export function parsePythonLaunchConfigs(text: string, filePath: string, workspaceRoot: string): { configs: PythonLaunchConfig[]; diagnostics: Diagnostic[] };
// projectDiscovery.ts
export const PYTHON_MARKERS: string[]; // pyproject.toml, requirements.txt, setup.py, setup.cfg, Pipfile
export function findPythonProjects(markerPaths: string[], workspaceRoots: string[], fs: FileSystem): Promise<ProjectInfo[]>;
```
- `listPythonEnvironments`: `development, staging, production` first, then names `X` from files `.env.X` (case-insensitive match of the `.env.` prefix), excluding `local`, `example`, `sample`, `template`, `defaults` and any name ending `.local`; de-dup case-insensitively, remaining sorted case-insensitively.
- `parsePythonLaunchConfigs`: jsonc; `configurations[]` with `type` `debugpy` or `python`; `env` values stringified; `envFile` with `${workspaceFolder}` → `workspaceRoot`, relative → `path.resolve(workspaceRoot, envFile)`; parse error → `error` diagnostic with location; missing `configurations` → none.
- `findPythonProjects`: one project per distinct marker directory whose listing has `.env` or `.env.*`; `id`/`projectFile` = first marker path in `PYTHON_MARKERS` order present in that dir; `name` = dir basename; `dir`; `kind: 'python'`. Fallback per spec for each workspace root with no project at or under it and a `.env` at the root (`id`/`projectFile` = root `.env` path, name = root basename). Sorted by name.

- [ ] **Step 1: Failing tests**
```ts
expect(listPythonEnvironments(['.env', '.env.test', '.env.local', '.env.example', '.env.production.local', '.env.Staging']))
  .toEqual(['development', 'Staging', 'production', 'test']);   // found casing wins (Review Focus 1)
// launch: "only debugpy/python configs become profiles"; "comments allowed"; "${workspaceFolder} substituted"; "relative envFile resolved against workspace root"
// discovery: "marker dir without .env files is not a project"; "fallback root project when no markers"; "both pyproject.toml and requirements.txt → one project, id = pyproject.toml"
```
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS; `npm run lint`.
- [ ] **Step 5:** Commit `Add Python environment list, launch.json profiles and project discovery`.

---

### Task 4: PythonProvider

**Files:** Create `src/python/pythonProvider.ts`; fixtures `test/fixtures/PyApp/*` (see File Structure); test `test/unit/pythonProvider.test.ts`. Modify `src/provider.ts`, `src/dotnet/dotnetProvider.ts`, `test/unit/dotnetProvider.test.ts`.

**Interfaces — Produces:**
```ts
// provider.ts — ProjectDescription gains:
mergeLabel: string; envVarSeparator: string; watchGlobs: string[]; // globs relative to project dir
// DotnetProvider.describe returns: mergeLabel = the .NET label (Global Constraints), envVarSeparator '__', watchGlobs ['appsettings*.json']
export interface PythonProviderOptions {
  fs: FileSystem; osEnv: Record<string, string>; workspaceRoot: string;
  envFiles: string[]; fileOverridesOs: boolean; envPrefixes: string[];
  nestedDelimiter: string; environmentVariables: string[];
}
export class PythonProvider implements ConfigProvider { constructor(options: PythonProviderOptions) }
```
- `describe`: profiles from nearest `.vscode/launch.json` (project dir upward, stopping at `workspaceRoot` inclusive); `profileEnvironments[name]` = env-name per spec order (profile env → profile envFile → `.env` → OS → `'development'`) — never `undefined`; no profiles → `defaultSelection.environment` from `.env` → OS → `'development'`; default profile = first config; `environments` = `listPythonEnvironments(listDir(dir))`; `mergeLabel` per `fileOverridesOs`; `envVarSeparator` = `nestedDelimiter || '__'`; `watchGlobs` = `['.env', '.env.*']`.
- `buildLayers` order and ids/labels:
  - file layers: resolve `envFiles` with `resolveJsonLayerFiles` (generic `{env}` resolver, reuse) → id/label = file name, kind `dotenv`, sensitive when pattern contains `secret`;
  - `envOs` "Environment (OS)" — filtered per spec (key match against file + profile keys, or prefix);
  - `envFile` "Env file (launch.json: <profile>)" — `filePath` set; missing → `warning` "envFile not found: <path>";
  - `envProfile` "Environment (launch.json: <profile>)".
  - `fileOverridesOs=false`: files, envOs, envFile, envProfile. `true`: envOs, envFile, envProfile, files.
- Expansion: process env = full OS env, then envFile values, then profile env (later wins). For file layers in order keep `fileValues`; `lookup(name)` = `fileOverridesOs ? fileValues ?? processEnv : processEnv ?? fileValues` (case-insensitive name match); store expanded value. envFile entries expand against OS then themselves. Entries carry `references` mapped with `delimitedNameToKey`.
- Keys: `delimitedNameToKey(name, nestedDelimiter)`.
- `watchPaths`: every resolved candidate env file path, the launch.json path used (or `<project>/.vscode/launch.json` when none), envFile path, `projectFile`.
- Unknown selected profile → `warning`, proceed without.

- [ ] **Step 1: Failing tests** (fixtures + in-memory fs where needed)
```ts
// "default order puts OS above files — OS value wins": osEnv { DB_HOST: 'os' } vs .env DB_HOST=file → winner layerId 'envOs'
// "fileOverridesOs moves files above OS — file wins"
// "development selection layers in order": ['.env','.env.development','.env.local','envOs','envFile','envProfile']
// "expanded DATABASE_URL references DB_PASSWORD and merges as sensitive" (Review Focus 2)
// "profile env sets environment — profileEnvironments value from APP_ENV"
// "launch.json with non-python config ignored and missing envFile warns" (Review Focus 5)
// "nestedDelimiter '' keeps keys flat"; ".env.example never loaded" (Review Focus 1)
// DotnetProvider: "describe returns .NET label, '__' separator and appsettings glob"
```
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `npm run lint && npm run test:unit` — PASS.
- [ ] **Step 5:** Commit `Add Python provider with .env layers, launch.json profiles and expansion`.

---

### Task 5: Host and UI wiring

**Files:** Modify `src/provider.ts` (`ProjectInfo.kind: 'dotnet' | 'python'` required), `src/dotnet/projectDiscovery.ts`, `src/extension.ts`, `src/panel/ConfigPanel.ts`, `src/panel/messages.ts`, `src/webview/toolbar.ts`, `package.json`; fixtures `test/fixtures/Mixed/*`; tests `test/unit/projectDiscovery.test.ts`, `test/webview/render.test.ts`.

**Interfaces — Produces:**
- `findOwningProject(filePath, projects, preferredKind?: 'dotnet' | 'python')`: deepest dir wins; on equal depth prefer `preferredKind`. Host: file name matching `/^\.env(\..*)?$/i` → `'python'`, else `'dotnet'`.
- `ViewState.projects: { id: string; name: string; kind: 'dotnet' | 'python' }[]`; toolbar option text `[.NET] name` / `[Python] name`.
- ConfigPanel: provider factory by `project.kind` (settings per Global Constraints; `workspaceRoot` = workspace folder containing the project dir, else project dir); `ViewState.label` = `description.mergeLabel`; project-dir watchers from `description.watchGlobs` (replaces `PROJECT_SETTINGS_GLOB`); copy/export pass `description.envVarSeparator`; `DEFAULT_MASK_PATTERNS` includes `*TOKEN*`.
- extension.ts discovery: .NET as today + `findPythonProjects(markers from findFiles('**/{pyproject.toml,requirements.txt,setup.py,setup.cfg,Pipfile}', '**/{node_modules,.venv,venv,env,__pycache__,site-packages,.git,bin,obj}/**'), workspace folder paths, nodeFileSystem)`; messages `No .NET or Python project owns this file.` / `No .NET or Python projects found in this workspace.`; QuickPick placeholder `Select a project`, item label tagged by kind.
- package.json: menus `when` also `resourceFilename =~ /^\.env(\..*)?$/i` (explorer + editor title); five `effectiveConfig.python.*` settings with defaults/descriptions; `maskPatterns` default adds `*TOKEN*`.

- [ ] **Step 1: Failing tests**
```ts
// "same-folder .NET and Python projects — .env prefers python, appsettings prefers dotnet" (Review Focus 4)
// render: "project options show kind tag — '[Python] PyApp'"
```
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement; update existing tests for the changed messages/types. **Step 4:** `npm run build && npm run lint && npm run test:unit` — PASS.
- [ ] **Step 5:** Commit `Wire Python projects into discovery, panel and settings`.

---

### Task 6: Integration tests, docs, version

**Files:** Modify `test/integration/panel.test.ts`, `README.md`, `CHANGELOG.md`, `package.json` (version `0.2.0`).

- [ ] **Step 1: Integration tests** (local VS Code; fixtures from Tasks 4–5; never write outside the workspace)
```ts
// "show on PyApp .env opens Python panel — label is python-dotenv (OS variables win), env from launch profile"
// "expanded DATABASE_URL is masked until revealed — value null then fixture URL"
// "switching profile to the second launch config changes environment"
// "right-click .env in Mixed opens Python; appsettings.json opens .NET"
// "editing .env.development refreshes within 2 s" (temp copy, cleaned in finally)
```
- [ ] **Step 2:** `npm run test:integration` — PASS (existing 9 + new).
- [ ] **Step 3:** README: Python section (projects, layer order, `fileOverridesOs`, OS filter, delimiter, parsing/expansion, profiles, environment detection, settings table rows, Python known limitations verbatim from spec); update intro, "Open the panel" triggers and mask defaults. CHANGELOG `## 0.2.0` bullets. package.json version `0.2.0`.
- [ ] **Step 4:** `npm run lint && npm run test:unit && npm run test:integration && npx vsce package --allow-missing-repository` — all pass (the `.vsix` is gitignored).
- [ ] **Step 5:** Commit `Add Python integration tests and docs, bump to 0.2.0`.
