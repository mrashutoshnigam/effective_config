import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ecosystem } from '../../src/ecosystem';
import type { ExtensionApi } from '../../src/extension';
import type { ViewNode, ViewState } from '../../src/panel/messages';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../../src/provider';
import { readFileLayers } from '../../src/sources/fileLayers';
import { nodeFileSystem } from '../../src/sources/fileSystem';
import { parseYamlLayer } from '../../src/sources/yamlLayer';

/** Kind of the fixture language; nothing in the host knows it. */
const YAML_KIND = 'yaml-fixture';

/** The fixture folder holding the YAML files. */
const YAML_DIR = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'YamlLang');

/** The fixture project. */
const YAML_PROJECT: ProjectInfo = {
  id: path.join(YAML_DIR, 'yaml.lang'),
  name: 'YamlLang',
  dir: YAML_DIR,
  projectFile: path.join(YAML_DIR, 'yaml.lang'),
  kind: YAML_KIND,
};

/** Reads the fixture's YAML files the way a future YAML-based language will. */
class YamlFixtureProvider implements ConfigProvider {
  /** @inheritdoc */
  async describe(): Promise<ProjectDescription> {
    return {
      profiles: [],
      environments: ['qa'],
      profileEnvironments: {},
      defaultSelection: { environment: 'qa' },
      mergeLabel: 'Simulated — YAML fixture order',
      envVarSeparator: '__',
      watchGlobs: ['*.yaml'],
    };
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    return readFileLayers({
      fs: nodeFileSystem,
      dir: project.dir,
      patterns: ['config.yaml', 'config.{env}.yaml', 'broken.yaml'],
      environment: selection.environment,
      kind: 'yaml',
      parse: parseYamlLayer,
    });
  }
}

/** The fixture language, registered only for this test. */
const YAML_ECOSYSTEM: Ecosystem = {
  kind: YAML_KIND,
  tag: '[YAML]',
  /** @inheritdoc */
  discover: async () => [YAML_PROJECT],
  /** @inheritdoc */
  createProvider: () => new YamlFixtureProvider(),
};

/**
 * Polls until the panel shows the fixture project.
 * @param api Extension API.
 * @returns The panel's view state.
 * @throws When the panel does not show it within 10 s.
 */
async function waitForYamlState(api: ExtensionApi): Promise<ViewState> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const state = api.getPanelState();
    if (state?.projectId === YAML_PROJECT.id) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error('the panel did not show the YAML project within 10 s');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Finds a node by its key segments.
 * @param root Node to start from.
 * @param segments Key segments to follow.
 * @returns The node, or undefined.
 */
function find(root: ViewNode, ...segments: string[]): ViewNode | undefined {
  return segments.reduce<ViewNode | undefined>((node, segment) => node?.children.find((c) => c.segment === segment), root);
}

describe('YAML layers (integration)', () => {
  /** Removes the fixture ecosystem again; set by the test that adds it. */
  let registration: vscode.Disposable | undefined;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    registration?.dispose();
    registration = undefined;
  });

  /**
   * Validates a YAML layer end to end in the real host: real files through `readFileLayers`, the merge
   * engine and the panel. Expected: merge keys, explicit overrides, arrays and a later file's second
   * document reach the panel with their sources, and the broken file is skipped with one located error
   * while the other files still load.
   */
  it('renders YAML layers with provenance and skips a broken file with a banner', async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'effective-config');
    assert.ok(ext, 'extension effective-config is loaded');
    const api = (await ext.activate()) as ExtensionApi;
    assert.ok(api.registerEcosystem, 'the test-mode registry hook is exposed');
    registration = api.registerEcosystem(YAML_ECOSYSTEM);

    await vscode.commands.executeCommand('effectiveConfig.show', vscode.Uri.file(path.join(YAML_DIR, 'config.yaml')));
    const state = await waitForYamlState(api);

    assert.strictEqual(find(state.root, 'Service', 'Host')?.value, 'service-host', 'an explicit key beats the merge');
    const retries = find(state.root, 'Service', 'Retries');
    assert.strictEqual(retries?.value, '5', 'the environment file overrides the merged value');
    assert.strictEqual(retries?.winner?.layerLabel, 'config.qa.yaml');
    assert.ok(retries?.winner?.locationId, 'the winner can be clicked through to its source');
    assert.deepStrictEqual(retries?.overridden.map((o) => [o.layerLabel, o.value]), [['config.yaml', '3']]);
    assert.strictEqual(find(state.root, 'Feature')?.value, 'false', 'the second document of a file is read');
    assert.strictEqual(find(state.root, 'Servers')?.isArray, true);
    assert.strictEqual(find(state.root, 'Servers', '1')?.value, 'beta');

    assert.strictEqual(find(state.root, 'Good'), undefined, 'nothing is read from the broken file');
    assert.strictEqual(state.diagnostics.length, 1);
    assert.strictEqual(state.diagnostics[0].severity, 'error');
    assert.strictEqual(state.diagnostics[0].location?.filePath, path.join(YAML_DIR, 'broken.yaml'));
    assert.strictEqual(state.diagnostics[0].location?.line, 1);
  });
});
