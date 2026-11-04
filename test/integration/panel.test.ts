import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ViewNode, ViewState } from '../../src/panel/messages';

/** Shape of the API returned by the extension's `activate`. */
interface ExtensionApi {
  /** The view state of the most recently active panel, if any. */
  getPanelState(): ViewState | undefined;
}

/** Absolute path of the fixtures folder (the test workspace root). */
const FIXTURES = vscode.workspace.workspaceFolders![0].uri.fsPath;

/** Temp copy of the WebApp fixture used by the edit test; removed after the test. */
const TMP_DIR = path.join(FIXTURES, '.tmp-WebApp');

/** Removes the temp fixture copy, retrying because Windows file watchers may briefly hold the folder. */
function removeTmp(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    const s = await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId.includes('WebApp'));
    assert.strictEqual(s.environment, 'Development');
    assert.strictEqual(find(s.root, 'Logging:LogLevel:Default')!.value, 'Trace');
  });

  it('secret from appsettings.secrets.json is masked in panel state — masked true, value null', async () => {
    const s = await openAndGetState(api, fixture('WebApp/appsettings.json'), (x) => x.projectId.includes('WebApp'));
    const node = find(s.root, 'ConnectionStrings:Default');
    assert.ok(node, 'ConnectionStrings:Default exists');
    assert.strictEqual(node.masked, true);
    assert.strictEqual(node.value, null);
  });

  it('editing appsettings.Development.json refreshes panel within 2 s — new value appears', async () => {
    removeTmp();
    fs.cpSync(fixture('WebApp'), TMP_DIR, { recursive: true });
    try {
      const s = await openAndGetState(api, path.join(TMP_DIR, 'appsettings.json'), (x) => x.projectId.startsWith(TMP_DIR));
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

  it('Worker project shows no profile and no error diagnostics — profile undefined, Development env', async () => {
    const s = await openAndGetState(api, fixture('Worker/appsettings.json'), (x) => x.projectId.includes('Worker'));
    assert.strictEqual(s.profile, undefined);
    assert.strictEqual(s.environment, 'Development');
    assert.deepStrictEqual(
      s.diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
  });
});
