/** Default Python env file patterns, lowest priority first; `{env}` is replaced by the environment name. */
export const DEFAULT_ENV_FILES: string[] = ['.env', '.env.{env}', '.env.local', '.env.{env}.local'];

/** Default names of the OS/env variables that select the active environment, in priority order. */
export const DEFAULT_ENV_NAME_VARIABLES: string[] = ['APP_ENV', 'ENV', 'ENVIRONMENT', 'PYTHON_ENV'];

const WELL_KNOWN_ENVIRONMENTS = ['development', 'staging', 'production'];
const EXCLUDED_NAMES = new Set(['local', 'example', 'sample', 'template', 'defaults']);
const ENV_PREFIX = '.env.';

/**
 * Lists the environment names a Python project can be simulated for.
 * @param fileNames File names in the project directory.
 * @returns `development`, `staging`, `production` (found casing wins) followed by the other names `X`
 * taken from `.env.X` files (prefix matched case-insensitively), excluding `local`, `example`,
 * `sample`, `template`, `defaults` and names ending in `.local`; de-duplicated case-insensitively
 * (first found wins) and sorted case-insensitively.
 */
export function listPythonEnvironments(fileNames: string[]): string[] {
  const found = new Map<string, string>();
  for (const file of fileNames) {
    if (file.length <= ENV_PREFIX.length || file.slice(0, ENV_PREFIX.length).toLowerCase() !== ENV_PREFIX) {
      continue;
    }
    const name = file.slice(ENV_PREFIX.length);
    const lower = name.toLowerCase();
    if (EXCLUDED_NAMES.has(lower) || lower.endsWith('.local') || found.has(lower)) {
      continue;
    }
    found.set(lower, name);
  }

  const known = new Set(WELL_KNOWN_ENVIRONMENTS);
  const rest = [...found.entries()]
    .filter(([lower]) => !known.has(lower))
    .map(([, name]) => name)
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  return [...WELL_KNOWN_ENVIRONMENTS.map((env) => found.get(env) ?? env), ...rest];
}
