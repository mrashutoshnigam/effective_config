import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * Resolves a locally installed VS Code executable so no build is downloaded.
 * Override with the VSCODE_EXECUTABLE_PATH environment variable.
 */
function localCode() {
  const candidates = [
    process.env.VSCODE_EXECUTABLE_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.find((p) => p && existsSync(p));
}

const executable = localCode();

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: 'test/fixtures',
  ...(executable ? { useInstallation: { fromPath: executable } } : {}),
  mocha: { ui: 'bdd', timeout: 20000 },
});
