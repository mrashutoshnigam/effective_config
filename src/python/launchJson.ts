import * as path from 'node:path';
import { parseTree, getNodeValue, printParseErrorCode, ParseError } from 'jsonc-parser';
import type { Diagnostic, SourceLocation } from '../engine/types';
import { getLineCol, stripBom } from '../sources/jsonLayer';

/** A Python debug configuration from `.vscode/launch.json`, used as a profile. */
export interface PythonLaunchConfig {
  /** Configuration name. */
  name: string;
  /** The configuration's `env` entries, values stringified. */
  env: Record<string, string>;
  /** Absolute path of the configuration's `envFile`, when it is a string. */
  envFile?: string;
}

/**
 * Parses `.vscode/launch.json` (comments and trailing commas allowed, BOM ignored) and returns the
 * Python (`debugpy` or `python`) configurations that have a string `name`.
 * @param text File contents.
 * @param filePath Path recorded in diagnostics' locations.
 * @param workspaceRoot Workspace folder; substituted for `${workspaceFolder}` and used to resolve relative `envFile` paths.
 * @returns Configurations in source order and diagnostics. Invalid JSON or a non-object root yields no
 * configurations and one error; empty text or missing/non-array `configurations` yields neither.
 */
export function parsePythonLaunchConfigs(
  text: string,
  filePath: string,
  workspaceRoot: string,
): { configs: PythonLaunchConfig[]; diagnostics: Diagnostic[] } {
  text = stripBom(text);
  const loc = (offset: number): SourceLocation => ({ filePath, ...getLineCol(text, offset) });
  const fail = (message: string, offset: number): { configs: PythonLaunchConfig[]; diagnostics: Diagnostic[] } =>
    ({ configs: [], diagnostics: [{ severity: 'error', message, location: loc(offset) }] });

  if (text.trim() === '') {
    return { configs: [], diagnostics: [] };
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return fail(`JSON parse error: ${printParseErrorCode(errors[0].error)}`, errors[0].offset);
  }
  if (!root) {
    return { configs: [], diagnostics: [] };
  }
  if (root.type !== 'object') {
    return fail('root must be an object', root.offset);
  }

  const listNode = root.children?.find((p) => p.children?.[0]?.value === 'configurations')?.children?.[1];
  const configs: PythonLaunchConfig[] = [];
  if (listNode?.type !== 'array') {
    return { configs, diagnostics: [] };
  }
  for (const node of listNode.children ?? []) {
    if (node.type !== 'object') {
      continue;
    }
    const raw = getNodeValue(node) as Record<string, unknown>;
    if ((raw.type !== 'debugpy' && raw.type !== 'python') || typeof raw.name !== 'string') {
      continue;
    }
    const env: Record<string, string> = {};
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      for (const [k, v] of Object.entries(raw.env)) {
        env[k] = String(v);
      }
    }
    const config: PythonLaunchConfig = { name: raw.name, env };
    if (typeof raw.envFile === 'string') {
      config.envFile = path.resolve(workspaceRoot, raw.envFile.split('${workspaceFolder}').join(workspaceRoot));
    }
    configs.push(config);
  }
  return { configs, diagnostics: [] };
}
