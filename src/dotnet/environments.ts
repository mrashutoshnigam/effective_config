/** The default JSON layer patterns, lowest priority first; `{env}` is replaced by the environment name. */
export const DEFAULT_JSON_LAYERS: string[] = ['appsettings.json', 'appsettings.{env}.json', 'appsettings.secrets.json'];

const WELL_KNOWN_ENVIRONMENTS = ['Development', 'Staging', 'Production'];

/** Escapes a string for literal use in a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lists the environment names a project can be simulated for.
 * @param fileNames File names in the project directory.
 * @param jsonLayers JSON layer patterns; names are taken from files matching `{env}` patterns,
 * excluding files that equal a pattern without `{env}` (e.g. `appsettings.secrets.json`).
 * @returns Development, Staging, Production (found casing wins) followed by the other found names
 * sorted case-insensitively; de-duplicated case-insensitively.
 */
export function listEnvironments(fileNames: string[], jsonLayers: string[]): string[] {
  const fixed = new Set(jsonLayers.filter((p) => !p.includes('{env}')).map((p) => p.toLowerCase()));
  const regexes = jsonLayers
    .filter((p) => p.includes('{env}'))
    .map((p) => new RegExp(`^${p.split('{env}').map(escapeRegExp).join('(.+)')}$`, 'i'));

  const found = new Map<string, string>();
  for (const file of fileNames) {
    if (fixed.has(file.toLowerCase())) {
      continue;
    }
    for (const re of regexes) {
      const name = re.exec(file)?.[1];
      if (name && !found.has(name.toLowerCase())) {
        found.set(name.toLowerCase(), name);
      }
    }
  }

  const result = WELL_KNOWN_ENVIRONMENTS.map((env) => found.get(env.toLowerCase()) ?? env);
  const known = new Set(WELL_KNOWN_ENVIRONMENTS.map((e) => e.toLowerCase()));
  const rest = [...found.entries()]
    .filter(([lower]) => !known.has(lower))
    .map(([, name]) => name)
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  return [...result, ...rest];
}

/**
 * Matches JSON layer patterns to files in a directory listing, ignoring case.
 * @param fileNames File names in the project directory.
 * @param jsonLayers JSON layer patterns, lowest priority first.
 * @param env Environment name substituted for `{env}`.
 * @returns One entry per pattern, in order: the found file name (undefined when missing) and
 * whether its casing differs from the expected name (it would not load on case-sensitive file systems).
 */
export function resolveJsonLayerFiles(
  fileNames: string[],
  jsonLayers: string[],
  env: string,
): { pattern: string; fileName?: string; caseMismatch: boolean }[] {
  return jsonLayers.map((pattern) => {
    const expected = pattern.split('{env}').join(env);
    const lower = expected.toLowerCase();
    const fileName = fileNames.includes(expected) ? expected : fileNames.find((f) => f.toLowerCase() === lower);
    return { pattern, fileName, caseMismatch: fileName !== undefined && fileName !== expected };
  });
}
