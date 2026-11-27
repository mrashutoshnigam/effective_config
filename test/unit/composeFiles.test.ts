import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { activeProfiles, listComposeEnvFiles, readComposeScope, resolveComposeFiles } from '../../src/compose/composeFiles';
import { VarMap } from '../../src/sources/dotenvProviderBase';
import { memoryFs } from './support/memoryFs';

/** Project directory of the in-memory tests. */
const DIR = '/p';

/**
 * Resolves a file name inside {@link DIR} the way the code under test does.
 * @param name File name.
 * @returns The absolute path.
 */
const at = (name: string): string => path.join(DIR, name);

describe('listComposeEnvFiles', () => {
  /**
   * Validates the env-file dropdown, which simulates `--env-file`. Expected: `.env` first, then the
   * other `.env.*` and `*.env` files sorted case-insensitively; unrelated files are left out.
   */
  it('lists .env first, then .env.* and *.env files sorted', () => {
    expect(listComposeEnvFiles(['app.env', '.env.prod', 'x.txt', '.env'])).toEqual(['.env', '.env.prod', 'app.env']);
  });

  /**
   * Validates that the default `--env-file` is always offered, as Compose reads `.env` by default.
   * Expected: `['.env']` for an empty directory.
   */
  it('offers .env even when the directory has none', () => {
    expect(listComposeEnvFiles([])).toEqual(['.env']);
  });
});

describe('readComposeScope', () => {
  /**
   * Validates the interpolation scope: the shell wins over the env file (Compose's documented
   * precedence), and an env file line may use an earlier line. Expected: OS `A` wins, and `B=${A}-x`
   * after `A=1` in the file expands with the scope value.
   */
  it('puts the OS over the env file and expands lines against earlier ones', async () => {
    const fs = memoryFs({ '/p/.env': 'A=1\nB=${A}-x\nC=${D}\n' });
    const fileOnly = await readComposeScope(fs, DIR, '.env', {});
    expect(fileOnly.vars.get('B')).toBe('1-x');
    expect(fileOnly.envFileFound).toBe(true);
    expect(fileOnly.envFilePath).toBe(at('.env'));
    expect(fileOnly.diagnostics).toEqual([]);

    const withOs = await readComposeScope(fs, DIR, '.env', { A: 'os' });
    expect(withOs.vars.get('A')).toBe('os');
    expect(withOs.vars.get('B')).toBe('os-x');
  });

  /**
   * Validates missing env files. Expected: a missing `.env` is normal and silent; a missing named env
   * file gives a warning naming it; in both cases the OS variables are still in scope.
   */
  it('warns only when a named env file other than .env is missing', async () => {
    const fs = memoryFs({});
    const dotenv = await readComposeScope(fs, DIR, '.env', { X: '1' });
    expect(dotenv).toMatchObject({ envFileFound: false, diagnostics: [] });
    expect(dotenv.vars.get('X')).toBe('1');

    const named = await readComposeScope(fs, DIR, '.env.prod', {});
    expect(named.diagnostics).toEqual([{ severity: 'warning', message: 'env file not found: .env.prod' }]);
  });
});

describe('resolveComposeFiles', () => {
  /**
   * Validates default discovery of the `compose.*` family. Expected: the primary file then its override
   * file, in load order, with the project directory being the first file's directory.
   */
  it('loads compose.yaml with compose.override.yml', async () => {
    const fs = memoryFs({ '/p/compose.yaml': '', '/p/compose.override.yml': '' });
    const set = await resolveComposeFiles(fs, at('compose.yaml'), [], new VarMap(), 'linux');
    expect(set).toEqual({ files: [at('compose.yaml'), at('compose.override.yml')], projectDir: path.dirname(at('compose.yaml')), diagnostics: [] });
  });

  /**
   * Validates that an override file of the other family is not paired. Expected: `docker-compose.yml`
   * alone, even with a `compose.override.yaml` beside it.
   */
  it('loads docker-compose.yml alone when it has no override of its family', async () => {
    const fs = memoryFs({ '/p/docker-compose.yml': '', '/p/compose.override.yaml': '' });
    const set = await resolveComposeFiles(fs, at('docker-compose.yml'), [], new VarMap(), 'linux');
    expect(set.files).toEqual([at('docker-compose.yml')]);
  });

  /**
   * Validates `COMPOSE_FILE` with the platform's default separator. Expected: `;` splits on Windows.
   */
  it('splits COMPOSE_FILE on ; on win32', async () => {
    const fs = memoryFs({ '/p/compose.yaml': '', '/p/a.yaml': '', '/p/b.yaml': '' });
    const scope = VarMap.from({ COMPOSE_FILE: 'a.yaml;b.yaml' });
    const set = await resolveComposeFiles(fs, at('compose.yaml'), [], scope, 'win32');
    expect(set.files).toEqual([at('a.yaml'), at('b.yaml')]);
  });

  /**
   * Validates `COMPOSE_PATH_SEPARATOR`. Expected: on Linux a `,` separator splits `a.yaml,b.yaml`.
   */
  it('splits COMPOSE_FILE on COMPOSE_PATH_SEPARATOR', async () => {
    const fs = memoryFs({ '/p/compose.yaml': '', '/p/a.yaml': '', '/p/b.yaml': '' });
    const scope = VarMap.from({ COMPOSE_FILE: 'a.yaml,b.yaml', COMPOSE_PATH_SEPARATOR: ',' });
    const set = await resolveComposeFiles(fs, at('compose.yaml'), [], scope, 'linux');
    expect(set.files).toEqual([at('a.yaml'), at('b.yaml')]);
  });

  /**
   * Validates the `effectiveConfig.compose.files` setting, which acts like `-f`. Expected: it wins over
   * `COMPOSE_FILE`; a listed file that does not exist gives an error naming it and is skipped, while
   * the others are still loaded.
   */
  it('prefers the setting files over COMPOSE_FILE and reports a missing one', async () => {
    const fs = memoryFs({ '/p/compose.yaml': '', '/p/a.yaml': '', '/p/b.yaml': '' });
    const scope = VarMap.from({ COMPOSE_FILE: 'a.yaml' });
    const set = await resolveComposeFiles(fs, at('compose.yaml'), ['b.yaml', 'missing/c.yaml'], scope, 'linux');
    expect(set.files).toEqual([at('b.yaml')]);
    expect(set.diagnostics).toEqual([{ severity: 'error', message: 'compose file not found: missing/c.yaml' }]);
  });
});

describe('activeProfiles', () => {
  /**
   * Validates parsing of `COMPOSE_PROFILES`. Expected: comma-separated names, trimmed, empties dropped;
   * none when the variable is unset.
   */
  it('splits COMPOSE_PROFILES on commas, trimming and dropping empties', () => {
    expect(activeProfiles(VarMap.from({ COMPOSE_PROFILES: ' debug, ,tools' }))).toEqual(['debug', 'tools']);
    expect(activeProfiles(new VarMap())).toEqual([]);
  });
});
