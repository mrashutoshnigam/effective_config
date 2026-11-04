# Effective Config Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code extension that shows the merged .NET configuration for a chosen project/profile/environment as a tree with per-value provenance, masking, copy/export and auto-refresh.

**Architecture:** Pure TypeScript engine (`src/engine`, `src/sources`, `src/dotnet` — no `vscode` import) turns files into `Layer[]` and merges them into `MergedEntry[]` → `ConfigNode` tree. A thin host (`src/extension.ts`, `src/panel`) wires VS Code APIs (commands, watchers, clipboard, documents) and owns masking. A plain-TS webview (`src/webview`) only renders state messages and posts user intents back.

**Tech Stack:** TypeScript 5, esbuild, `jsonc-parser`, Vitest (+ jsdom for webview), `@vscode/test-cli` + `@vscode/test-electron`, Node 20.

**Spec:** `docs/superpowers/specs/2026-11-04-effective-config-design.md`

## Global Constraints

- Extension `name`: `effective-config`; `displayName`: `Effective Config Viewer`; command prefix `effectiveConfig.`.
- `engines.vscode`: `^1.85.0` (placeholder — owner finalizes; do not add publisher, license, telemetry, icon, `capabilities.untrustedWorkspaces` — parked).
- Nothing under `src/engine`, `src/sources`, `src/dotnet` may import `vscode`.
- No network calls, no telemetry.
- Every exported function/type/class gets a TSDoc comment.
- Every test name states the behavior and expected outcome (e.g. `"overrides lower layer value — winner is Development file"`).
- Merge label shown in UI verbatim: `Simulated — default WebApplication.CreateBuilder order`.
- Default mask patterns verbatim: `*Password*`, `*Secret*`, `*Key*`, `ConnectionStrings:*` (glob, case-insensitive, `*` = any chars incl. `:`).
- Default JSON layers verbatim: `appsettings.json`, `appsettings.{env}.json`, `appsettings.secrets.json`. A layer is sensitive when its pattern contains `secret` (case-insensitive).
- Webview CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-<nonce>'`.
- Commit messages follow the owner's format: one-line imperative summary, blank line, one bullet per file `- <file>: <change>`, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Test helpers (`L`, `E`, `M`, `P`) are local to each test file and build the minimal `Layer` / `MergedEntry` / `ProjectInfo` the test needs; their argument shapes differ per file.

## Review Focus

1. **Env file name casing** — `appsettings.development.json` with env `Development`: matched case-insensitively (loads), plus a warning diagnostic "would not load on case-sensitive file systems". Test in Task 6.
2. **Empty / whitespace-only / BOM-prefixed JSON file** (common while a file is being created) — empty or whitespace-only → no entries + one `info` diagnostic "empty file"; BOM before `{}` → parsed normally, no diagnostic. Test in Task 2.
3. **Env var that differs only in case from a JSON key** (`LOGGING__LOGLEVEL__DEFAULT`) — overrides `Logging:LogLevel:Default`, display casing stays `Logging:LogLevel:Default`. Test in Task 3.
4. **launchSettings.json with comments / profile without `environmentVariables` / non-`Project` command names** — parsed without error; profile with no env var keeps env Development. Test in Task 5.
5. **Secret revealed then file changes** — after refresh, reveal state persists by key path, but a value whose winning layer changed is re-masked. Test in Task 8.

---

## File Structure

```
package.json, tsconfig.json, esbuild.mjs, vitest.config.ts, .vscode-test.mjs, .gitignore, .vscodeignore, README.md, CHANGELOG.md
src/
  engine/types.ts        shared types (Layer, MergedEntry, ConfigNode, Diagnostic…)
  engine/keys.ts         key normalize/compare, env-var ↔ key mapping
  engine/merge.ts        mergeLayers
  engine/tree.ts         buildTree, flattenTree
  engine/mask.ts         isSensitiveKey, globToRegExp
  engine/export.ts       toNestedJson, toEnvLines
  sources/jsonLayer.ts   parseJsonLayer (jsonc → entries with positions)
  sources/envVars.ts     envVarEntries, filterOsEnv
  sources/commandLine.ts parseCommandLineArgs
  dotnet/fileSystem.ts   FileSystem interface + nodeFileSystem
  dotnet/launchSettings.ts parseLaunchSettings
  dotnet/userSecrets.ts  readUserSecretsId, userSecretsPath
  dotnet/environments.ts listEnvironments, resolveJsonLayerFiles
  dotnet/dotnetProvider.ts DotnetProvider (implements ConfigProvider)
  provider.ts            ConfigProvider interface
  panel/messages.ts      host ↔ webview message types
  panel/viewModel.ts     toViewModel (masking applied), RevealState
  panel/ConfigPanel.ts   webview host, watchers, actions
  extension.ts           activate: commands, menus, test API
  webview/main.ts        bootstraps, handles messages
  webview/render.ts      DOM rendering (tree/flat/search)
  webview/styles.css
test/unit/**.test.ts, test/webview/**.test.ts, test/integration/**.test.ts
test/fixtures/WebApp/ (WebApp.csproj, appsettings*.json, Properties/launchSettings.json)
test/fixtures/Worker/  (Worker.csproj, appsettings.json only)
```

---

### Task 1: Scaffold project

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `src/extension.ts`, `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `build`, `watch`, `test:unit`, `test:integration`, `lint` (= `tsc --noEmit`), `package` (= `vsce package`).

- [ ] **Step 1:** `git init`; add `.gitignore` (`node_modules`, `dist`, `out`, `.vscode-test`, `*.vsix`).
- [ ] **Step 2:** `package.json` with name/displayName per Global Constraints, `main: ./dist/extension.js`, `activationEvents: []` (contributed commands activate implicitly), deps `jsonc-parser`; devDeps `typescript`, `esbuild`, `vitest`, `jsdom`, `@types/vscode@1.85`, `@types/node@20`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`. Run `npm install`.
- [ ] **Step 3:** `esbuild.mjs` builds two bundles: `src/extension.ts` → `dist/extension.js` (cjs, node, external `vscode`) and `src/webview/main.ts` → `dist/webview.js` (iife, browser); copies `src/webview/styles.css` → `dist/webview.css`. `tsconfig.json`: strict, `module: Node16`, `target: ES2022`, `lib: [ES2022, DOM]`.
- [ ] **Step 4:** `src/extension.ts` exports empty `activate`/`deactivate` with TSDoc. `test/unit/smoke.test.ts`: `"vitest runs — 1 + 1 equals 2"`.
- [ ] **Step 5:** Run `npm run build && npm run lint && npm run test:unit`. Expected: build emits `dist/extension.js`, `dist/webview.js`; 1 test passes.
- [ ] **Step 6:** Commit `Scaffold effective-config VS Code extension`.

---

### Task 2: Types, keys and JSON layer parsing

**Files:**
- Create: `src/engine/types.ts`, `src/engine/keys.ts`, `src/sources/jsonLayer.ts`
- Test: `test/unit/keys.test.ts`, `test/unit/jsonLayer.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export type LayerKind = 'json' | 'userSecrets' | 'envOs' | 'envProfile' | 'commandLine';
export interface SourceLocation { filePath: string; line: number; column: number } // 0-based
export interface LayerEntry { key: string; value: string | null; location?: SourceLocation }
export interface Layer { id: string; label: string; kind: LayerKind; sensitive: boolean; filePath?: string; entries: LayerEntry[] }
export interface Diagnostic { severity: 'error' | 'warning' | 'info'; message: string; location?: SourceLocation }
export interface Contribution { layerId: string; layerLabel: string; value: string | null; location?: SourceLocation }
export interface MergedEntry { key: string; value: string | null; winner: Contribution; overridden: Contribution[]; sensitive: boolean }
export type NodeFlag = 'mixedArray' | 'valueAndChildren';
export interface ConfigNode { segment: string; path: string; entry?: MergedEntry; children: ConfigNode[]; isArray: boolean; flags: NodeFlag[] }
```
- Produces (`keys.ts`): `normalizeKey(key: string): string` (lower-case), `compareKeys(a: string, b: string): number` (numeric-aware, case-insensitive; numbers before text), `envVarNameToKey(name: string): string` (`__`→`:`), `keyToEnvVarName(key: string): string` (`:`→`__`), `splitKey(key: string): string[]`.
- Produces (`jsonLayer.ts`): `parseJsonLayer(text: string, filePath: string): { entries: LayerEntry[]; diagnostics: Diagnostic[] }`.

- [ ] **Step 1: Write failing tests**
```ts
// keys.test.ts
expect(envVarNameToKey('Logging__LogLevel__Default')).toBe('Logging:LogLevel:Default');
expect(keyToEnvVarName('A:B:0')).toBe('A__B__0');
expect(['10','2','b','A'].sort(compareKeys)).toEqual(['2','10','A','b']);
// jsonLayer.test.ts
const { entries } = parseJsonLayer('{ // c\n "A": { "B": true, "N": null, "X": 1.50, "Arr": ["x","y"], "E": {} }, }', 'f.json');
expect(entries.map(e => [e.key, e.value])).toEqual([
  ['A:B','True'], ['A:N',''], ['A:X','1.50'], ['A:Arr:0','x'], ['A:Arr:1','y'], ['A:E', null]]);
expect(entries[0].location).toEqual({ filePath: 'f.json', line: 1, column: 13 }); // position of value token "true"
// broken JSON → entries [] and one error diagnostic with location.line of the first parse error
// '' / '   ' / '\uFEFF{}' → entries []; '' and '   ' add one 'info' diagnostic "empty file"; BOM + '{}' adds none
// top-level array '[1]' → error diagnostic "root must be an object"
```
- [ ] **Step 2:** Run `npx vitest run test/unit/keys.test.ts test/unit/jsonLayer.test.ts` — FAIL (modules missing).
- [ ] **Step 3:** Implement. `parseJsonLayer` uses `jsonc-parser.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })`, walks nodes building `:` paths; line/column via `getLineCol` helper computed from offsets; empty array also yields `[path, null]`. Value conversion: string as-is, number = raw source text, boolean `True`/`False`, null → `''`.
- [ ] **Step 4:** Run tests — PASS.
- [ ] **Step 5:** Commit `Add engine types, key helpers and JSON layer parser`.

---

### Task 3: Merge engine and masking

**Files:**
- Create: `src/engine/merge.ts`, `src/engine/mask.ts`
- Test: `test/unit/merge.test.ts`, `test/unit/mask.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `normalizeKey`, `compareKeys`.
- Produces: `mergeLayers(layers: Layer[], maskPatterns: string[]): MergedEntry[]` (layers lowest-first; result sorted by key with `compareKeys` per segment). `globToRegExp(glob: string): RegExp`, `isSensitiveKey(key: string, patterns: string[]): boolean`.

- [ ] **Step 1: Write failing tests**
```ts
// "overrides lower layer value — winner is Development, base in overridden"
const r = mergeLayers([L('base',{ 'A:B':'1' }), L('dev',{ 'a:b':'2' })], []);
expect(r).toHaveLength(1);
expect(r[0]).toMatchObject({ key: 'A:B', value: '2', winner: { layerId: 'dev' }, overridden: [{ layerId: 'base', value: '1' }] });
// "env var differing only in case keeps lowest-layer display casing" (Review Focus 3): key stays 'Logging:LogLevel:Default'
// "arrays merge by index": base Arr:0..2 = a,b,c; dev Arr:0 = x → values x,b,c
// "sensitive when winner layer sensitive OR key matches pattern"
expect(isSensitiveKey('Db:AdminPassword', ['*Password*'])).toBe(true);
expect(isSensitiveKey('ConnectionStrings:Main', ['ConnectionStrings:*'])).toBe(true);
expect(isSensitiveKey('connectionstrings', ['ConnectionStrings:*'])).toBe(false);
// "empty layer list returns []"
```
(`L(id, record)` is a local test helper building a `Layer`.)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement with a `Map<normalizedKey, MergedEntry>`; first insertion fixes display `key`; later layers push the previous winner onto `overridden` (oldest first). `sensitive = winnerLayer.sensitive || isSensitiveKey(key, patterns)`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `Add layer merge engine with provenance and masking rules`.

---

### Task 4: Tree, flattening and export

**Files:**
- Create: `src/engine/tree.ts`, `src/engine/export.ts`
- Test: `test/unit/tree.test.ts`, `test/unit/export.test.ts`

**Interfaces:**
- Consumes: `MergedEntry`, `ConfigNode`, `splitKey`, `compareKeys`.
- Produces: `buildTree(entries: MergedEntry[]): ConfigNode` (root `segment: ''`, `path: ''`), `flattenTree(root: ConfigNode): ConfigNode[]` (nodes with `entry`, in order). `toNestedJson(entries: MergedEntry[], valueOf: (e: MergedEntry) => string | null): string` (2-space indent; all-numeric children → array), `toEnvLines(entries, valueOf): string` (`A__B=value` lines, `\n`-joined).

- [ ] **Step 1: Write failing tests**
```ts
// "node with value and children is flagged valueAndChildren"
const t = buildTree([E('Foo','x'), E('Foo:Bar','1')]);
expect(t.children[0]).toMatchObject({ segment: 'Foo', entry: { value: 'x' }, flags: ['valueAndChildren'] });
// "array with items from two layers flagged mixedArray": Arr:0 winner dev, Arr:1 winner base → isArray true, flags ['mixedArray']
// "single-layer array not flagged"
// "flattenTree returns value nodes in compareKeys order": ['A:2','A:10','b']
expect(toEnvLines([E('A:B','1')], e => e.value)).toBe('A__B=1');
expect(JSON.parse(toNestedJson([E('A:0','x'), E('A:1','y'), E('B:C','z')], e => e.value))).toEqual({ A: ['x','y'], B: { C: 'z' } });
// "toNestedJson with value-and-children key emits object and drops scalar" — documented lossy case: {"Foo":{"Bar":"1"}}
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. `mixedArray` = array node whose descendant entries' `winner.layerId` set size > 1.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `Add config tree builder, search filter and exporters`.

---

### Task 5: Env var, command-line and launchSettings sources

**Files:**
- Create: `src/sources/envVars.ts`, `src/sources/commandLine.ts`, `src/dotnet/launchSettings.ts`
- Test: `test/unit/envVars.test.ts`, `test/unit/commandLine.test.ts`, `test/unit/launchSettings.test.ts`

**Interfaces:**
- Produces:
  - `envVarEntries(vars: Record<string, string>): LayerEntry[]` (keys via `envVarNameToKey`).
  - `filterOsEnv(vars: Record<string, string>, topLevelKeys: Set<string> /* normalized */): Record<string, string>` — keep if first segment (normalized) ∈ `topLevelKeys` or name starts with `ASPNETCORE_`/`DOTNET_` (case-insensitive).
  - `parseCommandLineArgs(args: string): { entries: LayerEntry[]; diagnostics: Diagnostic[] }` — quote-aware split; `--k=v`, `--k v`; anything else → one `warning` "unsupported argument form: <arg>"; `__` inside key also maps to `:`.
  - `interface LaunchProfile { name: string; environmentVariables: Record<string, string>; commandLineArgs?: string; environmentName?: string }`; `parseLaunchSettings(text: string, filePath: string): { profiles: LaunchProfile[]; diagnostics: Diagnostic[] }` — jsonc tolerant; `environmentName` = `ASPNETCORE_ENVIRONMENT` ?? `DOTNET_ENVIRONMENT` (case-insensitive lookup).

- [ ] **Step 1: Write failing tests**
```ts
expect(filterOsEnv({ PATH:'x', Logging__Level:'d', ASPNETCORE_URLS:'u' }, new Set(['logging'])))
  .toEqual({ Logging__Level:'d', ASPNETCORE_URLS:'u' });
expect(parseCommandLineArgs('--A:B=1 --C "two words" --D__E=3').entries.map(e => [e.key, e.value]))
  .toEqual([['A:B','1'], ['C','two words'], ['D:E','3']]);
expect(parseCommandLineArgs('/x=1').diagnostics[0].severity).toBe('warning');
// launchSettings (Review Focus 4): comments + trailing commas parse; profile "IIS Express" with commandName "IISExpress" included;
// profile without environmentVariables → environmentVariables {} and environmentName undefined;
// DOTNET_ENVIRONMENT used only when ASPNETCORE_ENVIRONMENT absent; invalid JSON → profiles [] + error diagnostic
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `Add environment variable, command-line and launchSettings sources`.

---

### Task 6: DotnetProvider

**Files:**
- Create: `src/provider.ts`, `src/dotnet/fileSystem.ts`, `src/dotnet/userSecrets.ts`, `src/dotnet/environments.ts`, `src/dotnet/dotnetProvider.ts`
- Create fixtures: `test/fixtures/WebApp/WebApp.csproj` (with `<UserSecretsId>test-webapp-0001</UserSecretsId>`), `appsettings.json`, `appsettings.Development.json`, `appsettings.staging.json` (lower-case on purpose), `appsettings.secrets.json`, `Properties/launchSettings.json` (profiles `WebApp` → Development with `Logging__LogLevel__Default=Trace` and `commandLineArgs: "--Feature:Enabled=true"`; `Staging` → Staging); `test/fixtures/Worker/Worker.csproj`, `appsettings.json`.
- Test: `test/unit/dotnetProvider.test.ts`, `test/unit/userSecrets.test.ts`, `test/unit/environments.test.ts`

**Interfaces:**
- Produces:
```ts
// provider.ts
export interface ProjectInfo { id: string; name: string; dir: string; projectFile: string }
export interface Selection { profile?: string; environment: string }
export interface ProjectDescription { profiles: string[]; environments: string[]; defaultSelection: Selection }
export interface LayerBuild { layers: Layer[]; diagnostics: Diagnostic[]; watchPaths: string[] }
export interface ConfigProvider {
  describe(project: ProjectInfo): Promise<ProjectDescription>;
  buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild>;
}
// fileSystem.ts
export interface FileSystem { readFile(path: string): Promise<string | undefined>; listDir(dir: string): Promise<string[]> }
export const nodeFileSystem: FileSystem;
// userSecrets.ts
export function readUserSecretsId(csprojText: string): string | undefined;
export function userSecretsPath(id: string, platform: NodeJS.Platform, env: Record<string, string | undefined>, homeDir: string): string;
// environments.ts
export function listEnvironments(fileNames: string[], jsonLayers: string[]): string[]; // found ∪ Development/Staging/Production, de-duped case-insensitively, found casing wins
export function resolveJsonLayerFiles(fileNames: string[], jsonLayers: string[], env: string): { pattern: string; fileName?: string; caseMismatch: boolean }[];
// dotnetProvider.ts
export interface DotnetProviderOptions { fs: FileSystem; osEnv: Record<string, string>; platform: NodeJS.Platform; homeDir: string; jsonLayers: string[] }
export class DotnetProvider implements ConfigProvider { constructor(options: DotnetProviderOptions) }
```
- Layer ids/labels: JSON → id = file name, label = file name; user secrets → `userSecrets` / `User Secrets`; `envOs` / `Environment (OS)`; `envProfile` / `Environment (launchSettings: <profile>)`; `commandLine` / `Command line (<profile>)`.
- Order: JSON layers in `jsonLayers` order → user secrets (only if `environment` equals `Development` case-insensitively and id found) → envOs → envProfile → commandLine. `topLevelKeys` for `filterOsEnv` come from JSON + user-secrets entries.
- `watchPaths`: every JSON candidate path (existing or not), `Properties/launchSettings.json`, project file, user secrets path.

- [ ] **Step 1: Write failing tests** (fixtures + in-memory `FileSystem` for user secrets)
```ts
// "Development selection yields layers in agreed order"
expect(build.layers.map(l => l.id)).toEqual(['appsettings.json','appsettings.Development.json','appsettings.secrets.json','userSecrets','envOs','envProfile','commandLine']);
// "Staging skips user secrets and matches lower-case staging file with warning" (Review Focus 1)
expect(ids).not.toContain('userSecrets'); expect(ids).toContain('appsettings.staging.json');
expect(build.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('case-sensitive') }));
// "secrets layer marked sensitive"; "missing appsettings.secrets.json silently skipped" (Worker)
// "describe: profile WebApp preselects Development; no launchSettings → { environment: 'Development' }"
expect(userSecretsPath('id','win32',{ APPDATA:'C:\\A' },'C:\\H')).toBe('C:\\A\\Microsoft\\UserSecrets\\id\\secrets.json');
expect(userSecretsPath('id','linux',{},'/home/u')).toBe('/home/u/.microsoft/usersecrets/id/secrets.json');
expect(listEnvironments(['appsettings.json','appsettings.QA.json','appsettings.secrets.json'], DEFAULT_LAYERS)).toEqual(['Development','Staging','Production','QA']);
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Use `path.win32`/`path.posix` by `platform` in `userSecretsPath`. Missing user secrets file → `info` diagnostic, no layer.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `Add .NET provider with layer discovery, user secrets and environments`.

---

### Task 7: Panel host, messages, commands

**Files:**
- Create: `src/panel/messages.ts`, `src/panel/viewModel.ts`, `src/panel/ConfigPanel.ts`, `src/dotnet/projectDiscovery.ts`
- Modify: `src/extension.ts`, `package.json` (`contributes`)
- Test: `test/unit/viewModel.test.ts`, `test/unit/projectDiscovery.test.ts`

**Interfaces:**
- Produces:
```ts
// messages.ts
export interface ViewNode { segment: string; path: string; value?: string | null; masked: boolean; revealed: boolean; sensitive: boolean;
  winner?: { layerLabel: string; locationId?: string }; overridden: { layerLabel: string; value: string | null; masked: boolean; locationId?: string }[];
  isArray: boolean; flags: NodeFlag[]; children: ViewNode[] }
export interface ViewState { projects: { id: string; name: string }[]; projectId: string; profiles: string[]; profile?: string;
  environments: string[]; environment: string; root: ViewNode; diagnostics: Diagnostic[]; label: string }
export type HostMessage = { type: 'state'; state: ViewState };
export type WebviewMessage =
  | { type: 'ready' } | { type: 'select'; projectId?: string; profile?: string | null; environment?: string }
  | { type: 'reveal'; path: string; revealed: boolean } | { type: 'openSource'; locationId: string }
  | { type: 'copy'; path: string; what: 'value' | 'keyPath' | 'envVarName' }
  | { type: 'export'; format: 'json' | 'env'; revealAll: boolean } | { type: 'refresh' };
// viewModel.ts
export function toViewModel(root: ConfigNode, revealed: Set<string>, locations: Map<string, SourceLocation>): ViewNode;
// masked = entry.sensitive && !revealed.has(path); masked values sent as null; overridden values masked by the same rule
export class RevealState { /* tracks path → winner layerId at reveal time */ reveal(path: string, layerId: string): void; hide(path: string): void; current(entries: MergedEntry[]): Set<string> }
// projectDiscovery.ts (pure)
export function findOwningProject(filePath: string, projects: ProjectInfo[]): ProjectInfo | undefined; // deepest dir containing file
// ConfigPanel.ts
export class ConfigPanel { static show(context: vscode.ExtensionContext, project: ProjectInfo, projects: ProjectInfo[]): ConfigPanel; readonly lastState?: ViewState }
```
- `contributes`: commands `effectiveConfig.show` ("Effective Config: Show Merged Configuration", icon `$(list-tree)`); menus `explorer/context` when `resourceFilename =~ /^appsettings.*\.json$/i || resourceExtname == .csproj`, `editor/title` (navigation) when `resourceFilename =~ /^appsettings.*\.json$/i`; configuration `effectiveConfig.dotnet.jsonLayers` (string[], default per Global Constraints), `effectiveConfig.maskPatterns` (string[], default per Global Constraints).
- Project discovery (host): `workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**')`, keep those whose dir has `appsettings.json`. Command with URI → `findOwningProject`; else quick pick (skip pick if exactly one).
- `activate` returns `{ getPanelState(): ViewState | undefined }` for integration tests.

- [ ] **Step 1: Write failing tests**
```ts
// "sensitive value hidden until revealed": toViewModel(...).children[0] → { masked: true, value: null }; with revealed set → value 'p@ss'
// "overridden secret values also masked"
// "RevealState drops a reveal when winner layer changed" (Review Focus 5)
const rs = new RevealState(); rs.reveal('Db:Password', 'appsettings.json');
expect(rs.current([M('Db:Password', 'userSecrets')]).has('Db:Password')).toBe(false);
expect(findOwningProject('/r/src/Api/appsettings.json', [P('/r/src'), P('/r/src/Api')])?.dir).toBe('/r/src/Api');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `viewModel.ts`, `projectDiscovery.ts`, then `ConfigPanel` (one panel per project id; reuse & reveal if open) and `extension.ts`. `ConfigPanel.render()` = `provider.buildLayers` → `mergeLayers` → `buildTree` → `toViewModel` → `postMessage`. Location ids are opaque (`l<n>`) and resolved host-side for `openSource` (`showTextDocument` with `selection` at line/column). HTML uses Global Constraints CSP, loads `dist/webview.js` / `dist/webview.css`.
- [ ] **Step 4:** Run unit tests — PASS; `npm run build && npm run lint` — clean.
- [ ] **Step 5:** Commit `Add webview panel host, view model and show command`.

---

### Task 8: Webview UI

**Files:**
- Create: `src/webview/main.ts`, `src/webview/render.ts`, `src/webview/styles.css`
- Test: `test/webview/render.test.ts` (vitest `environment: 'jsdom'`)

**Interfaces:**
- Consumes: `ViewState`, `ViewNode`, `WebviewMessage` (Task 7).
- Produces: `filterViewTree(root: ViewNode, query: string): ViewNode | undefined` in `render.ts` — case-insensitive match on `path` or unmasked `value` (masked values never match); keeps ancestors; a matched section keeps all descendants; `undefined` when nothing matches.
- Produces: `render(container: HTMLElement, state: ViewState, ui: UiState, post: (m: WebviewMessage) => void): void`; `interface UiState { mode: 'tree' | 'flat'; query: string; expanded: Set<string> }` persisted with `acquireVsCodeApi().setState`.

Layout: toolbar (project select, profile select incl. "(none)", environment select + "Custom…" text entry, tree/flat toggle, search input, refresh button, export menu: JSON / KEY=value / reveal-all variants), label line (Global Constraints label), diagnostics banner (one row per diagnostic; errors red via `--vscode-errorForeground`), body. Each value row: key, value (or `••••••` + eye button when masked), winner badge (click → `openSource`), expandable override chain, warning icon with tooltip `section also has a direct value` / `array items come from multiple sources`, copy buttons (value / key path / env var name). Colors only from `--vscode-*` variables.

- [ ] **Step 1: Write failing tests**
```ts
// "masked value renders dots and reveal posts message"
render(el, stateWithSecret, ui, post); el.querySelector('[data-action=reveal]')!.click();
expect(post).toHaveBeenCalledWith({ type: 'reveal', path: 'Db:Password', revealed: true });
expect(el.textContent).not.toContain('p@ss');
// "flat mode lists full key paths"; "search 'trace' shows only Logging ancestors"
// "filterViewTree returns undefined when nothing matches"; "search never matches a masked value"
// "valueAndChildren flag shows tooltip 'section also has a direct value'"
// "diagnostic error renders banner with file name and line+1"
// "winner badge click posts openSource with locationId"
```
- [ ] **Step 2:** Run `npx vitest run test/webview` — FAIL.
- [ ] **Step 3:** Implement `render.ts`, then `main.ts` (listens for `state`, posts `ready` on load, keeps `UiState`).
- [ ] **Step 4:** Run — PASS; `npm run build` — clean.
- [ ] **Step 5:** Commit `Add webview UI with tree, flat view, search and masking`.

---

### Task 9: Refresh, copy and export actions

**Files:**
- Modify: `src/panel/ConfigPanel.ts`
- Create: `src/panel/actions.ts`
- Test: `test/unit/actions.test.ts`

**Interfaces:**
- Produces (`actions.ts`, pure): `copyText(entries: MergedEntry[], path: string, what: 'value' | 'keyPath' | 'envVarName', revealed: Set<string>): string | undefined` (masked value → `undefined`, caller shows "Reveal the value before copying"); `exportText(entries, format: 'json' | 'env', revealAll: boolean): string` (masked → `"***"` unless `revealAll`).
- Host behavior: watchers from `LayerBuild.watchPaths` (`createFileSystemWatcher(new RelativePattern(Uri.file(dir), basename))`), debounced 200 ms → re-render keeping `RevealState`; watchers rebuilt when selection changes; `refresh` message re-reads `process.env`. Export with `revealAll` first shows modal `showWarningMessage('Export will include secret values in plain text.', { modal: true }, 'Export')`; result opens as untitled document (`language: 'json'` or `'properties'`). Copy uses `env.clipboard.writeText`. Config change of `effectiveConfig.*` re-renders.

- [ ] **Step 1: Write failing tests**
```ts
expect(copyText([M('Db:Password','x',{ sensitive: true })], 'Db:Password', 'value', new Set())).toBeUndefined();
expect(copyText([M('A:B','1')], 'A:B', 'envVarName', new Set())).toBe('A__B');
expect(exportText([M('Db:Password','x',{ sensitive: true })], 'env', false)).toBe('Db__Password=***');
expect(exportText([M('Db:Password','x',{ sensitive: true })], 'env', true)).toBe('Db__Password=x');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `actions.ts`, wire into `ConfigPanel`.
- [ ] **Step 4:** Run unit tests — PASS; build clean.
- [ ] **Step 5:** Commit `Add auto-refresh, copy and export actions`.

---

### Task 10: Integration tests and README

**Files:**
- Create: `.vscode-test.mjs`, `test/integration/panel.test.ts`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `activate()` test API `getPanelState()` (Task 7); fixtures (Task 6).

`.vscode-test.mjs`: `files: 'out/test/integration/**/*.test.js'`, `workspaceFolder: 'test/fixtures'`, `mocha: { timeout: 20000 }`; tests compiled with `tsc -p test/integration` to `out/`.

- [ ] **Step 1: Write failing tests** (mocha, inside VS Code)
```ts
// "show command on WebApp appsettings.json opens panel with Development and Trace log level"
await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(fixture('WebApp/appsettings.json')));
const s = await waitFor(() => api.getPanelState());
assert.strictEqual(s.environment, 'Development');
assert.strictEqual(find(s.root, 'Logging:LogLevel:Default')!.value, 'Trace');
// "secret from appsettings.secrets.json is masked in panel state" → masked true, value null
// "editing appsettings.Development.json refreshes panel within 2 s" (write temp copy of fixture, edit, assert new value; restore after)
// "Worker project shows no profile and no secrets layer diagnostics errors"
```
- [ ] **Step 2:** Run `npm run test:integration` — expected PASS (code exists from Tasks 1–9); any failure is a wiring gap: fix it in the owning file and re-run.
- [ ] **Step 3:** Write `README.md`: what it does, merge order list (spec), the simulated label, masking, settings table (`effectiveConfig.dotnet.jsonLayers`, `effectiveConfig.maskPatterns`), Known limitations (verbatim list from spec). `CHANGELOG.md`: `## 0.1.0 — initial release`. No publisher/license/telemetry sections (parked).
- [ ] **Step 4:** Run full suite `npm run lint && npm run test:unit && npm run test:integration && npx vsce package --allow-missing-repository` — all pass, `.vsix` produced.
- [ ] **Step 5:** Commit `Add integration tests, README and changelog`.
