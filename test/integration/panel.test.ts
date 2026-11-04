import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ViewNode, ViewState, WebviewMessage } from '../../src/panel/messages';

/** Shape of the API returned by the extension's `activate`. */
interface ExtensionApi {
  /** The view state of the most recently active panel, if any. */
  getPanelState(): ViewState | undefined;
  /** Test hook: delivers a webview message to the most recent panel and resolves after the render. */
  sendMessage(message: WebviewMessage): Promise<void>;
}

/** Absolute path of the fixtures folder (the test workspace root). */
const FIXTURES = vscode.workspace.workspaceFolders![0].uri.fsPath;

/** Temp copy of the WebApp fixture used by the edit test; removed after the test. */
const TMP_DIR = path.join(FIXTURES, '.tmp-WebApp');

/** Temp copy of the PyApp fixture used by the python edit test; removed after the test. */
const TMP_PY_DIR = path.join(FIXTURES, '.tmp-PyApp');

/** Removes the temp fixture copy, retrying because Windows file watchers may briefly hold the folder. */
function removeTmp(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(TMP_PY_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Resolves a path under the fixtures folder.
 * @param relative Path relative to `test/fixtures`.
 * @returns The absolute path.
 */
function fixture(relative: string): string {
  return path.join(FIXTURES, relative);
}

/**
 * Polls until `fn` returns a truthy value.
 * @param fn Function to poll.
 * @param timeoutMs Maximum wait in milliseconds (default 10 s).
 * @returns The truthy value.
 * @throws When the timeout elapses first.
 */
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) {
      return value as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Finds a node by its full `:`-separated path (case-insensitive).
 * @param node Root to search from.
 * @param nodePath Path to find.
 * @returns The node, or undefined.
 */
function find(node: ViewNode, nodePath: string): ViewNode | undefined {
  if (node.path.toLowerCase() === nodePath.toLowerCase()) {
    return node;
  }
  for (const child of node.children) {
    const hit = find(child, nodePath);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Opens the panel for a file and waits for a state matching the predicate.
 * @param api Extension API.
 * @param file Absolute file path to invoke the command on.
 * @param accept Predicate the state must satisfy (e.g. belongs to the right project).
 * @returns The matching state.
 */
async function openAndGetState(api: ExtensionApi, file: string, accept: (s: ViewState) => boolean): Promise<ViewState> {
  await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(file));
  return waitFor(() => {
    const s = api.getPanelState();
    return s && accept(s) ? s : undefined;
  });
}

describe('Effective Config panel (integration)', () => {
  let api: ExtensionApi;

  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'effective-config');
    assert.ok(ext, 'extension effective-config is loaded');
    api = (await ext.activate()) as ExtensionApi;
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(() => {
    removeTmp();
  });

  it('show command on WebApp appsettings.json opens panel with Development and Trace log level', async () => {
    const s = await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId === fixture('WebApp/WebApp.csproj'));
    assert.strictEqual(s.environment, 'Development');
    assert.strictEqual(find(s.root, 'Logging:LogLevel:Default')!.value, 'Trace');
  });

  it('secret from appsettings.secrets.json is masked in panel state — masked true, value null', async () => {
    const s = await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId === fixture('WebApp/WebApp.csproj'));
    const node = find(s.root, 'ConnectionStrings:Default');
    assert.ok(node, 'ConnectionStrings:Default exists');
    assert.strictEqual(node.masked, true);
    assert.strictEqual(node.value, null);
  });

  it('reveal of a masked secret shows the fixture value, hide masks it again — value then null', async () => {
    const webApp = (x: ViewState): boolean => x.projectId === fixture('WebApp/WebApp.csproj');
    await openAndGetState(api, fixture('WebApp/appsettings.json'), webApp);
    await api.sendMessage({ type: 'reveal', path: 'ConnectionStrings:Default', revealed: true });
    const revealed = find(api.getPanelState()!.root, 'ConnectionStrings:Default')!;
    assert.strictEqual(revealed.masked, false);
    assert.strictEqual(revealed.revealed, true);
    assert.strictEqual(revealed.value, 'Server=placeholder;Database=placeholder');

    await api.sendMessage({ type: 'reveal', path: 'ConnectionStrings:Default', revealed: false });
    const hidden = find(api.getPanelState()!.root, 'ConnectionStrings:Default')!;
    assert.strictEqual(hidden.masked, true);
    assert.strictEqual(hidden.value, null);
  });

  it('selecting the Staging profile makes the environment follow it — profile and environment are Staging', async () => {
    await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId === fixture('WebApp/WebApp.csproj'));
    await api.sendMessage({ type: 'select', profile: 'Staging' });
    const s = api.getPanelState()!;
    assert.strictEqual(s.profile, 'Staging');
    assert.strictEqual(s.environment, 'Staging');
  });

  it('copy value on a masked node leaves the clipboard untouched — sentinel survives', async () => {
    await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId === fixture('WebApp/WebApp.csproj'));
    const sentinel = 'sentinel-clipboard-value';
    await vscode.env.clipboard.writeText(sentinel);
    await api.sendMessage({ type: 'copy', path: 'ConnectionStrings:Default', what: 'value' });
    assert.strictEqual(await vscode.env.clipboard.readText(), sentinel);
  });

  it('copy key path on a section row writes the section path — clipboard is Logging:LogLevel', async () => {
    await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId === fixture('WebApp/WebApp.csproj'));
    await vscode.env.clipboard.writeText('sentinel');
    await api.sendMessage({ type: 'copy', path: 'Logging:LogLevel', what: 'keyPath' });
    assert.strictEqual(await vscode.env.clipboard.readText(), 'Logging:LogLevel');
  });

  it('editing appsettings.Development.json refreshes panel within 2 s — new value appears', async () => {
    removeTmp();
    fs.cpSync(fixture('WebApp'), TMP_DIR, { recursive: true });
    try {
      const s = await openAndGetState(api, path.join(TMP_DIR, 'appsettings.json'), (x) => x.projectId === path.join(TMP_DIR, 'WebApp.csproj'));
      assert.strictEqual(find(s.root, 'Endpoints:0')!.value, 'https://dev.example.test');

      const devFile = path.join(TMP_DIR, 'appsettings.Development.json');
      fs.writeFileSync(devFile, JSON.stringify({ Endpoints: ['https://edited.example.test'] }));

      const refreshed = await waitFor(() => {
        const cur = api.getPanelState();
        return cur && find(cur.root, 'Endpoints:0')?.value === 'https://edited.example.test' ? cur : undefined;
      }, 2000);
      assert.strictEqual(find(refreshed.root, 'Endpoints:0')!.value, 'https://edited.example.test');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      removeTmp();
    }
  });

  it('creating appsettings.QA.json adds QA to the environment list — watcher covers new env files', async () => {
    removeTmp();
    fs.cpSync(fixture('WebApp'), TMP_DIR, { recursive: true });
    try {
      const s = await openAndGetState(api, path.join(TMP_DIR, 'appsettings.json'), (x) => x.projectId === path.join(TMP_DIR, 'WebApp.csproj'));
      assert.ok(!s.environments.some((e) => e.toLowerCase() === 'qa'));
      fs.writeFileSync(path.join(TMP_DIR, 'appsettings.QA.json'), JSON.stringify({ Qa: { On: true } }));
      const refreshed = await waitFor(() => {
        const cur = api.getPanelState();
        return cur && cur.environments.some((e) => e === 'QA') ? cur : undefined;
      }, 5000);
      assert.ok(refreshed.environments.includes('QA'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      removeTmp();
    }
  });

  it('Worker project shows no profile and no error diagnostics — profile undefined, Development env', async () => {
    const s = await openAndGetState(api, fixture('Worker/appsettings.json'), (x) => x.projectId === fixture('Worker/Worker.csproj'));
    assert.strictEqual(s.profile, undefined);
    assert.strictEqual(s.environment, 'Development');
    assert.deepStrictEqual(
      s.diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
  });

  it('show command on PyApp .env opens a python panel — label names python-dotenv and DB_PASSWORD is masked', async () => {
    const s = await openAndGetState(api, fixture('PyApp/.env'), (x) => x.projectId === fixture('PyApp/pyproject.toml'));
    assert.ok(s.label.includes('python-dotenv'), `label was ${s.label}`);
    assert.strictEqual(s.projects.find((p) => p.id === s.projectId)?.kind, 'python');
    const node = find(s.root, 'DB_PASSWORD');
    assert.ok(node, 'DB_PASSWORD exists');
    assert.strictEqual(node.masked, true);
    assert.strictEqual(node.value, null);
    assert.ok(find(s.root, 'FEATURE_FLAGS:BETA'), 'nested key from __ delimiter exists');
  });

  it('copy env var name on a python key uses the configured delimiter — nestedDelimiter "_" copies DB_HOST for DB:HOST', async () => {
    const config = vscode.workspace.getConfiguration('effectiveConfig');
    const previous = config.inspect<string>('python.nestedDelimiter')?.workspaceValue;
    try {
      await config.update('python.nestedDelimiter', '_', vscode.ConfigurationTarget.Workspace);
      await openAndGetState(api, fixture('PyApp/.env'), (x) => x.projectId === fixture('PyApp/pyproject.toml'));
      await api.sendMessage({ type: 'copy', path: 'DB:HOST', what: 'envVarName' });
      assert.strictEqual(await vscode.env.clipboard.readText(), 'DB_HOST');
    } finally {
      await vscode.workspace.getConfiguration('effectiveConfig').update('python.nestedDelimiter', previous, vscode.ConfigurationTarget.Workspace);
      fs.rmSync(fixture('.vscode'), { recursive: true, force: true });
    }
  });

  it('Mixed folder — .env opens the python project and appsettings.json opens the dotnet project', async () => {
    const py = await openAndGetState(api, fixture('Mixed/.env'), (x) => x.projectId === fixture('Mixed/pyproject.toml'));
    assert.strictEqual(find(py.root, 'MIXED_SOURCE')!.value, 'python');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const net = await openAndGetState(api, fixture('Mixed/appsettings.json'), (x) => x.projectId === fixture('Mixed/Mixed.csproj'));
    assert.strictEqual(find(net.root, 'Mixed:Source')!.value, 'dotnet');
  });

  it('project switcher lists both kinds — dotnet and python projects are present', async () => {
    const s = await openAndGetState(api, fixture('Mixed/.env'), (x) => x.projectId === fixture('Mixed/pyproject.toml'));
    const kinds = new Set(s.projects.map((p) => p.kind));
    assert.ok(kinds.has('dotnet') && kinds.has('python'));
  });

  it('PyApp default launch profile — label says OS variables win and environment is development from APP_ENV', async () => {
    const s = await openAndGetState(api, fixture('PyApp/.env'), (x) => x.projectId === fixture('PyApp/pyproject.toml'));
    assert.ok(s.label.includes('OS variables win'), `label was ${s.label}`);
    assert.strictEqual(s.profile, 'PyApp: dev');
    assert.strictEqual(s.environment, 'development');
  });

  it('expanded DATABASE_URL is masked until revealed — value null, then the expanded fixture URL', async () => {
    const py = (x: ViewState): boolean => x.projectId === fixture('PyApp/pyproject.toml');
    const s = await openAndGetState(api, fixture('PyApp/.env'), py);
    const masked = find(s.root, 'DATABASE_URL')!;
    assert.strictEqual(masked.masked, true);
    assert.strictEqual(masked.value, null);

    await api.sendMessage({ type: 'reveal', path: 'DATABASE_URL', revealed: true });
    const revealed = find(api.getPanelState()!.root, 'DATABASE_URL')!;
    assert.strictEqual(revealed.value, 'postgres://app:dev-password-placeholder@localhost/app');

    await api.sendMessage({ type: 'reveal', path: 'DATABASE_URL', revealed: false });
  });

  it('selecting the PyApp: prod profile — environment becomes production and DB_HOST is prod-db', async () => {
    await openAndGetState(api, fixture('PyApp/.env'), (x) => x.projectId === fixture('PyApp/pyproject.toml'));
    await api.sendMessage({ type: 'select', profile: 'PyApp: prod' });
    const s = api.getPanelState()!;
    assert.strictEqual(s.profile, 'PyApp: prod');
    assert.strictEqual(s.environment, 'production');
    assert.strictEqual(find(s.root, 'DB_HOST')!.value, 'prod-db');
  });

  it('editing .env.development refreshes the python panel within 2 s — new DB_HOST appears', async () => {
    removeTmp();
    fs.cpSync(fixture('PyApp'), TMP_PY_DIR, { recursive: true });
    try {
      const projectId = path.join(TMP_PY_DIR, 'pyproject.toml');
      const s = await openAndGetState(api, path.join(TMP_PY_DIR, '.env'), (x) => x.projectId === projectId);
      assert.strictEqual(find(s.root, 'DB_HOST')!.value, 'dev-db');

      fs.writeFileSync(path.join(TMP_PY_DIR, '.env.development'), 'DB_HOST=edited-db\n');

      const refreshed = await waitFor(() => {
        const cur = api.getPanelState();
        return cur && find(cur.root, 'DB_HOST')?.value === 'edited-db' ? cur : undefined;
      }, 2000);
      assert.strictEqual(find(refreshed.root, 'DB_HOST')!.value, 'edited-db');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      removeTmp();
    }
  });
});
