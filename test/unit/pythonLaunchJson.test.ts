import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parsePythonLaunchConfigs } from '../../src/python/launchJson';

const FILE = '/ws/.vscode/launch.json';
const ROOT = path.resolve('/ws');

describe('parsePythonLaunchConfigs', () => {
  it('only debugpy/python configs become profiles — other types skipped', () => {
    const text = JSON.stringify({ configurations: [
      { name: 'A', type: 'debugpy', env: { X: '1' } },
      { name: 'B', type: 'python' },
      { name: 'C', type: 'node' },
      { name: 'D', type: 'Python' },
    ] });
    const { configs, diagnostics } = parsePythonLaunchConfigs(text, FILE, ROOT);
    expect(diagnostics).toEqual([]);
    expect(configs).toEqual([{ name: 'A', env: { X: '1' } }, { name: 'B', env: {} }]);
  });
  it('comments and trailing commas are allowed and a BOM is ignored', () => {
    const text = '﻿{ // c\n "configurations": [ { "name": "A", "type": "debugpy", }, ], }';
    const { configs, diagnostics } = parsePythonLaunchConfigs(text, FILE, ROOT);
    expect(diagnostics).toEqual([]);
    expect(configs.map((c) => c.name)).toEqual(['A']);
  });
  it('env values are stringified and a non-object env is treated as empty', () => {
    const text = JSON.stringify({ configurations: [
      { name: 'A', type: 'python', env: { N: 5, B: true, S: 's' } },
      { name: 'B', type: 'python', env: ['x'] },
      { name: 'C', type: 'python', env: 'x' },
    ] });
    const { configs } = parsePythonLaunchConfigs(text, FILE, ROOT);
    expect(configs[0].env).toEqual({ N: '5', B: 'true', S: 's' });
    expect(configs[1].env).toEqual({});
    expect(configs[2].env).toEqual({});
  });
  it('configs without a string name are skipped', () => {
    const text = JSON.stringify({ configurations: [{ type: 'python' }, { name: 3, type: 'python' }, { name: 'ok', type: 'python' }] });
    expect(parsePythonLaunchConfigs(text, FILE, ROOT).configs.map((c) => c.name)).toEqual(['ok']);
  });
  it('${workspaceFolder} is substituted everywhere in envFile', () => {
    const text = JSON.stringify({ configurations: [{ name: 'A', type: 'python', envFile: '${workspaceFolder}/a/${workspaceFolder}.env' }] });
    expect(parsePythonLaunchConfigs(text, FILE, ROOT).configs[0].envFile).toBe(path.resolve(ROOT, `${ROOT}/a/${ROOT}.env`));
  });
  it('relative envFile is resolved against the workspace root', () => {
    const text = JSON.stringify({ configurations: [{ name: 'A', type: 'python', envFile: 'cfg/.env.dev' }] });
    expect(parsePythonLaunchConfigs(text, FILE, ROOT).configs[0].envFile).toBe(path.resolve(ROOT, 'cfg/.env.dev'));
  });
  it('envFile is omitted when not a string', () => {
    const text = JSON.stringify({ configurations: [{ name: 'A', type: 'python', envFile: 5 }] });
    expect('envFile' in parsePythonLaunchConfigs(text, FILE, ROOT).configs[0]).toBe(false);
  });
  it('missing or non-array configurations yields no configs and no diagnostics', () => {
    for (const text of ['{}', '{"configurations": {}}', '', '   ']) {
      expect(parsePythonLaunchConfigs(text, FILE, ROOT)).toEqual({ configs: [], diagnostics: [] });
    }
  });
  it('invalid JSON yields one error diagnostic with location and no values', () => {
    const { configs, diagnostics } = parsePythonLaunchConfigs('{ "configurations": [ { "name": "A" "env": {"S":"hunter2"} } ] }', FILE, ROOT);
    expect(configs).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].location?.filePath).toBe(FILE);
    expect(JSON.stringify(diagnostics)).not.toContain('hunter2');
  });
  it('non-object root yields one error diagnostic', () => {
    const { configs, diagnostics } = parsePythonLaunchConfigs('[1]', FILE, ROOT);
    expect(configs).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
  });
});
