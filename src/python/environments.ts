/** Default Python env file patterns, lowest priority first; `{env}` is replaced by the environment name. */
export const DEFAULT_ENV_FILES: string[] = ['.env', '.env.{env}', '.env.local', '.env.{env}.local'];

/** Default names of the OS/env variables that select the active environment, in priority order. */
export const DEFAULT_ENV_NAME_VARIABLES: string[] = ['APP_ENV', 'ENV', 'ENVIRONMENT', 'PYTHON_ENV'];

export { listDotenvEnvironments as listPythonEnvironments } from '../sources/dotenvEnvironments';
