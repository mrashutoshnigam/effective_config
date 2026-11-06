import type * as vscode from 'vscode';
import { DOTNET_ECOSYSTEM } from './dotnet/ecosystem';
import type { Ecosystem } from './ecosystem';
import { PYTHON_ECOSYSTEM } from './python/ecosystem';

/** The registry behind {@link ECOSYSTEMS}. */
const registry: Ecosystem[] = [DOTNET_ECOSYSTEM, PYTHON_ECOSYSTEM];

/**
 * The ecosystems this extension supports, in discovery order. The first entry is also the default
 * for files no ecosystem claims. Add a new ecosystem here, before Python; its code lives in its own folder.
 */
export const ECOSYSTEMS: readonly Ecosystem[] = registry;

/**
 * Adds an ecosystem at run time, before Python like any other language. Only integration tests use
 * this, through the API that `activate` exposes in test mode.
 * @param ecosystem The ecosystem to add.
 * @returns Removes the ecosystem again.
 */
export function registerEcosystem(ecosystem: Ecosystem): vscode.Disposable {
  registry.splice(registry.indexOf(PYTHON_ECOSYSTEM), 0, ecosystem);
  return {
    dispose: () => {
      const index = registry.indexOf(ecosystem);
      if (index >= 0) {
        registry.splice(index, 1);
      }
    },
  };
}
