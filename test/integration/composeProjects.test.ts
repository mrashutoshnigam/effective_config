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

describe('Docker Compose projects (integration)', () => {
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
   * Acceptance: the ComposeApp fixture, with an override file and interpolation, shows the winner and
   * override chain per variable, and a missing `:?` variable surfaces as an error. Expected: a `compose`
   * project for service `api` and `.env`; LOG_LEVEL `debug` won by the override's environment over the
   * base environment and `app.env`; VERSION `1.2` from `.env`; DB_PASSWORD masked; FROM_FILE from
   * `app.env`; the WORKER_TAG error; `.env.prod` changes VERSION to `2.0`; opening LOG_LEVEL's winner
   * shows `compose.override.yaml`.
   */
  it('ComposeApp — service environment, override chain, :? error and click-through', async () => {
    const projectId = fixture('ComposeApp/compose.yaml');
    await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(projectId));
    const s = await waitForState(api, (st) => st.projectId === projectId);
    assert.strictEqual(s.projects.find((p) => p.id === s.projectId)?.kind, 'compose');
    assert.strictEqual(s.label, 'Simulated — docker compose (environment: over env_file, OS variables win in interpolation)');
    assert.strictEqual(s.profile, 'api');
    assert.strictEqual(s.environment, '.env');

    const log = child(s.root, 'LOG_LEVEL')!;
    assert.strictEqual(log.value, 'debug');
    assert.strictEqual(log.winner?.layerLabel, 'environment (compose.override.yaml)');
    assert.deepStrictEqual(log.overridden.map((o) => o.layerLabel), ['app.env', 'environment (compose.yaml)']);
    assert.strictEqual(child(s.root, 'VERSION')?.value, '1.2');
    assert.strictEqual(child(s.root, 'DB_PASSWORD')?.masked, true);
    assert.strictEqual(child(s.root, 'FROM_FILE')?.winner?.layerLabel, 'app.env');
    const required = s.diagnostics.find((d) => d.message === 'required variable WORKER_TAG is missing a value: set WORKER_TAG');
    assert.strictEqual(required?.severity, 'error');

    await api.sendMessage({ type: 'select', environment: '.env.prod' });
    const prod = await waitForState(api, (st) => st.environment === '.env.prod');
    assert.strictEqual(child(prod.root, 'VERSION')?.value, '2.0');

    await api.sendMessage({ type: 'openSource', locationId: child(prod.root, 'LOG_LEVEL')!.winner!.locationId! });
    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.fsPath.toLowerCase(), fixture('ComposeApp/compose.override.yaml').toLowerCase());
  });
});
