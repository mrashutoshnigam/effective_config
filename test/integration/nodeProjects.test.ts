import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { ViewNode, ViewState } from '../../src/panel/messages';

/** Absolute path of the fixtures folder (the test workspace root). */
const FIXTURES = vscode.workspace.workspaceFolders![0].uri.fsPath;

/**
 * Resolves a path under the fixtures folder.
 * @param relative Path relative to `test/fixtures`.
 * @returns The absolute path.
 */
function fixture(relative: string): string {
  return path.join(FIXTURES, relative);
}

/**
 * Finds a direct child of a view node by its key segment.
 * @param root The parent node.
 * @param segment Key segment to find.
 * @returns The child, or undefined.
 */
function child(root: ViewNode, segment: string): ViewNode | undefined {
  return root.children.find((c) => c.segment === segment);
}

/**
 * Polls until the panel state satisfies a predicate.
 * @param api Extension API.
 * @param accept Predicate the state must satisfy.
 * @returns The matching state.
 * @throws When no matching state appears within 10 s.
 */
async function waitForState(api: ExtensionApi, accept: (s: ViewState) => boolean): Promise<ViewState> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const state = api.getPanelState();
    if (state && accept(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`no matching panel state within 10 s; last project was ${state?.projectId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Runs the show command on a file and waits for the panel of the given project.
 * @param api Extension API.
 * @param file Absolute file path to invoke the command on.
 * @param projectId Expected project id (its package.json path).
 * @returns The panel state.
 */
async function open(api: ExtensionApi, file: string, projectId: string): Promise<ViewState> {
  await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(file));
  return waitForState(api, (s) => s.projectId === projectId);
}

describe('Node .env projects (integration)', () => {
  let api: ExtensionApi;

  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'effective-config');
    assert.ok(ext, 'extension effective-config is loaded');
    api = (await ext.activate()) as ExtensionApi;
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /**
   * Acceptance: the Vite fixture renders Vite's winners with provenance and click-through. Expected:
   * a `node` project labelled with the Vite order in `development`; SHARED won by `.env.development`
   * over `.env.local` and `.env`; DB_PASSWORD masked; opening the winner's source shows
   * `.env.development` at line 0.
   */
  it('ViteApp — Vite winners, provenance and click-through', async () => {
    const s = await open(api, fixture('ViteApp/.env'), fixture('ViteApp/package.json'));
    assert.strictEqual(s.projects.find((p) => p.id === s.projectId)?.kind, 'node');
    assert.strictEqual(s.label, 'Simulated — Vite .env order (OS variables win)');
    assert.strictEqual(s.environment, 'development');

    const shared = child(s.root, 'SHARED')!;
    assert.strictEqual(shared.value, 'from-development');
    assert.strictEqual(shared.winner?.layerLabel, '.env.development');
    assert.deepStrictEqual(shared.overridden.map((o) => o.layerLabel), ['.env', '.env.local']);
    assert.strictEqual(child(s.root, 'DB_PASSWORD')?.masked, true);

    await api.sendMessage({ type: 'openSource', locationId: shared.winner!.locationId! });
    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.fsPath.toLowerCase(), fixture('ViteApp/.env.development').toLowerCase());
    assert.strictEqual(editor?.selection.active.line, 0);
  });

  /**
   * Acceptance: the Next fixture renders Next's winners. Expected: SHARED won by `.env.local` in
   * `development`; selecting `test` drops `.env.local`, so `.env.test` wins.
   */
  it('NextApp — Next winners, and .env.local skipped under test', async () => {
    const s = await open(api, fixture('NextApp/.env'), fixture('NextApp/package.json'));
    assert.strictEqual(s.label, 'Simulated — Next.js .env order (OS variables win)');
    assert.deepStrictEqual(s.environments, ['development', 'production', 'test']);
    assert.strictEqual(child(s.root, 'SHARED')?.winner?.layerLabel, '.env.local');
    assert.strictEqual(child(s.root, 'SHARED')?.value, 'from-env-local');

    await api.sendMessage({ type: 'select', environment: 'test' });
    const t = api.getPanelState()!;
    assert.strictEqual(t.environment, 'test');
    assert.strictEqual(child(t.root, 'SHARED')?.value, 'from-test');
    assert.strictEqual(child(t.root, 'SHARED')?.winner?.layerLabel, '.env.test');
  });
});
