import { parseTree, getNodeValue, printParseErrorCode, ParseError } from 'jsonc-parser';
import type { Diagnostic, SourceLocation } from '../engine/types';
import { getLineCol, stripBom } from '../sources/jsonLayer';

/** One profile of `Properties/launchSettings.json`. */
export interface LaunchProfile {
  /** Profile name (the key under `profiles`). */
  name: string;
  /** The profile's environment variables, values stringified. */
  environmentVariables: Record<string, string>;
  /** The profile's `commandLineArgs`, when present. */
  commandLineArgs?: string;
  /** Value of `ASPNETCORE_ENVIRONMENT`, else `DOTNET_ENVIRONMENT` (names case-insensitive), when present. */
  environmentName?: string;
}

/** Result of parsing a launchSettings.json file. */
export interface LaunchSettingsParseResult {
  /** Profiles in source order. */
  profiles: LaunchProfile[];
  /** Problems found while parsing. */
  diagnostics: Diagnostic[];
}

/**
 * Looks up an environment variable by name, ignoring case.
 * @param vars Variables to search.
 * @param name Name to find.
 * @returns The value, or undefined.
 */
function lookup(vars: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const found = Object.keys(vars).find((k) => k.toLowerCase() === target);
  return found === undefined ? undefined : vars[found];
}

/**
 * Parses `launchSettings.json` (comments and trailing commas allowed, BOM ignored).
 * Every profile under `profiles` is returned regardless of its `commandName`.
 * @param text File contents.
 * @param filePath Path recorded in diagnostics' locations.
 * @returns Profiles and diagnostics. Invalid JSON or a non-object root yields no profiles and
 * one error; empty text or a missing `profiles` object yields no profiles and no diagnostics.
 */
export function parseLaunchSettings(text: string, filePath: string): LaunchSettingsParseResult {
  text = stripBom(text);
  const loc = (offset: number): SourceLocation => ({ filePath, ...getLineCol(text, offset) });
  const fail = (message: string, offset: number): LaunchSettingsParseResult =>
    ({ profiles: [], diagnostics: [{ severity: 'error', message, location: loc(offset) }] });

  if (text.trim() === '') {
    return { profiles: [], diagnostics: [] };
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return fail(`JSON parse error: ${printParseErrorCode(errors[0].error)}`, errors[0].offset);
  }
  if (!root) {
    return { profiles: [], diagnostics: [] };
  }
  if (root.type !== 'object') {
    return fail('root must be an object', root.offset);
  }

  const profilesNode = root.children
    ?.find((p) => p.children?.[0]?.value === 'profiles')?.children?.[1];
  const profiles: LaunchProfile[] = [];
  if (profilesNode?.type !== 'object') {
    return { profiles, diagnostics: [] };
  }
  for (const prop of profilesNode.children ?? []) {
    const [nameNode, valueNode] = prop.children ?? [];
    if (!nameNode || valueNode?.type !== 'object') {
      continue;
    }
    const raw = getNodeValue(valueNode) as Record<string, unknown>;
    const envRaw = raw.environmentVariables;
    const environmentVariables: Record<string, string> = {};
    if (envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)) {
      for (const [k, v] of Object.entries(envRaw)) {
        environmentVariables[k] = String(v);
      }
    }
    const profile: LaunchProfile = { name: String(nameNode.value), environmentVariables };
    if (typeof raw.commandLineArgs === 'string') {
      profile.commandLineArgs = raw.commandLineArgs;
    }
    const environmentName = lookup(environmentVariables, 'ASPNETCORE_ENVIRONMENT')
      ?? lookup(environmentVariables, 'DOTNET_ENVIRONMENT');
    if (environmentName !== undefined) {
      profile.environmentName = environmentName;
    }
    profiles.push(profile);
  }
  return { profiles, diagnostics: [] };
}
