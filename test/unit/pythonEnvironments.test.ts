import { describe, it, expect } from 'vitest';
import { DEFAULT_ENV_FILES, DEFAULT_ENV_NAME_VARIABLES, listPythonEnvironments } from '../../src/python/environments';

describe('python defaults', () => {
  it('exposes the default env files verbatim', () => {
    expect(DEFAULT_ENV_FILES).toEqual(['.env', '.env.{env}', '.env.local', '.env.{env}.local']);
  });
  it('exposes the default env-name variables verbatim', () => {
    expect(DEFAULT_ENV_NAME_VARIABLES).toEqual(['APP_ENV', 'ENV', 'ENVIRONMENT', 'PYTHON_ENV']);
  });
});

describe('listPythonEnvironments', () => {
  it('lists well-known lowercase names first, found casing wins, excludes local/example/.local — others sorted', () => {
    expect(listPythonEnvironments(['.env', '.env.test', '.env.local', '.env.example', '.env.production.local', '.env.Staging']))
      .toEqual(['development', 'Staging', 'production', 'test']);
  });
  it('returns only the well-known names when no env files exist', () => {
    expect(listPythonEnvironments([])).toEqual(['development', 'staging', 'production']);
  });
  it('excludes sample, template and defaults regardless of case', () => {
    expect(listPythonEnvironments(['.env.SAMPLE', '.env.Template', '.env.defaults', '.env.LOCAL', '.env.x.LOCAL']))
      .toEqual(['development', 'staging', 'production']);
  });
  it('matches the .env. prefix case-insensitively and de-duplicates case-insensitively — first found wins', () => {
    expect(listPythonEnvironments(['.ENV.QA', '.env.qa', '.env.Qa', '.env.alpha', '.env.Beta']))
      .toEqual(['development', 'staging', 'production', 'alpha', 'Beta', 'QA']);
  });
  it('ignores files that are not .env.X and empty names', () => {
    expect(listPythonEnvironments(['.env', '.env.', 'env.test', 'app.env.test', 'x.env']))
      .toEqual(['development', 'staging', 'production']);
  });
});
