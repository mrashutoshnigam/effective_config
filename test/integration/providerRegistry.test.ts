import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ecosystem } from '../../src/ecosystem';
import type { ExtensionApi } from '../../src/extension';
import type { ViewNode, ViewState } from '../../src/panel/messages';
import type { ProjectInfo } from '../../src/provider';
import { nodeFileSystem } from '../../src/sources/fileSystem';
import { STUB_KIND, STUB_LABEL, StubProvider, stubOptions } from '../unit/support/stubProvider';

/** The fixture folder of the stub language. */
const STUB_DIR = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'StubLang');

/** The stub language's project in the fixture workspace. */
const STUB_LANG_PROJECT: ProjectInfo = {
  id: path.join(STUB_DIR, 'stub.lang'),
  name: 'StubLang',
  dir: STUB_DIR,
  projectFile: path.join(STUB_DIR, 'stub.lang'),
  kind: STUB_KIND,
};

/** A language the production host does not know, reading real files from the fixture. */
const STUB_ECOSYSTEM: Ecosystem = {
  kind: STUB_KIND,
  tag: '[Stub]',
  /** @inheritdoc */
  discover: async () => [STUB_LANG_PROJECT],
  /** @inheritdoc */
  createProvider: () => new StubProvider(stubOptions(nodeFileSystem)),
};

/**
 * Polls until the panel shows the stub project.
 * @param api Extension API.
 * @returns The panel's view state.
 * @throws When the panel does not show it within 10 s.
 */
async function waitForStubState(api: ExtensionApi): Promise<ViewState> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const state = api.getPanelState();
    if (state?.projectId === STUB_LANG_PROJECT.id) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error('the panel did not show the stub project within 10 s');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

describe('Provider registry (integration)', () => {
  /** Removes the stub ecosystem again; set by the test that adds it. */
  let registration: vscode.Disposable | undefined;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    registration?.dispose();
    registration = undefined;
  });

  /**
   * Validates the registry in the real host: a language added to the production registry is discovered
   * next to .NET and Python, owns its file and renders in the panel. Expected: the panel shows the
   * stub's tag, label, detected environment and merged values, with the secret-looking value masked.
   */
  it('discovers and renders a registered language next to the built-in ones', async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'effective-config');
    assert.ok(ext, 'extension effective-config is loaded');
    const api = (await ext.activate()) as ExtensionApi;
    assert.ok(api.registerEcosystem, 'the test-mode registry hook is exposed');
    registration = api.registerEcosystem(STUB_ECOSYSTEM);

    await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(path.join(STUB_DIR, '.env')));
    const state = await waitForStubState(api);

    assert.deepStrictEqual(state.diagnostics, []);
    assert.strictEqual(state.label, STUB_LABEL);
    assert.strictEqual(state.environment, 'qa');
    assert.strictEqual(state.projects.find((p) => p.kind === STUB_KIND)?.tag, '[Stub]');
    assert.ok(state.projects.some((p) => p.kind === 'dotnet'), '.NET projects are still discovered');
    assert.ok(state.projects.some((p) => p.kind === 'python'), 'Python projects are still discovered');
    assert.strictEqual(child(state.root, 'HOST')?.value, 'stub-qa-host');
    assert.strictEqual(child(state.root, 'API_PASSWORD')?.masked, true);
  });
});
