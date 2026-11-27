import { describe, it, expect } from 'vitest';
import { selectNodePreset } from '../../src/node/presets';

/** Serializes a package.json with the given dependency maps. */
const pkg = (deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string =>
  JSON.stringify({ name: 'app', dependencies: deps, devDependencies: devDeps });

describe('selectNodePreset', () => {
  /**
   * Vite lists `.env.local` below the mode files, exposes `VITE_` to the client and reads the mode
   * from `MODE` before `NODE_ENV`. Expected: the Vite preset with exactly that order.
   */
  it('picks the Vite preset when vite is a dev dependency', () => {
    const { preset, diagnostics } = selectNodePreset(pkg({}, { vite: '^5.0.0' }));
    expect(preset.framework).toBe('vite');
    expect(preset.envFiles).toEqual(['.env', '.env.local', '.env.{env}', '.env.{env}.local']);
    expect(preset.clientPrefix).toBe('VITE_');
    expect(preset.environmentVariables).toEqual(['MODE', 'NODE_ENV']);
    expect(diagnostics).toEqual([]);
  });

  /**
   * Next.js ranks `.env.local` above the mode file, skips `.env.local` under `test`, exposes
   * `NEXT_PUBLIC_` and only knows the three `NODE_ENV` values. Expected: the Next preset.
   */
  it('picks the Next preset when next is a dependency', () => {
    const { preset } = selectNodePreset(pkg({ next: '14.2.0', react: '18.0.0' }));
    expect(preset.framework).toBe('next');
    expect(preset.envFiles).toEqual(['.env', '.env.{env}', '.env.local', '.env.{env}.local']);
    expect(preset.clientPrefix).toBe('NEXT_PUBLIC_');
    expect(preset.environmentVariables).toEqual(['NODE_ENV']);
    expect(preset.environments).toEqual(['development', 'production', 'test']);
    expect(preset.skipLocalInTest).toBe(true);
  });

  /**
   * A project depending on no known framework (here plain express + dotenv) still gets mode files in
   * the common Next/CRA order, `NODE_ENV` and no client prefix. Expected: the generic preset.
   */
  it('falls back to the generic preset for an unknown framework', () => {
    const { preset, diagnostics } = selectNodePreset(pkg({ express: '4.0.0', dotenv: '16.0.0' }));
    expect(preset.framework).toBe('generic');
    expect(preset.envFiles).toEqual(['.env', '.env.{env}', '.env.local', '.env.{env}.local']);
    expect(preset.clientPrefix).toBeUndefined();
    expect(preset.environmentVariables).toEqual(['NODE_ENV']);
    expect(preset.environments).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  /**
   * Create React App follows the Next file order with the `REACT_APP_` prefix. Expected: the CRA preset.
   */
  it('picks the CRA preset when react-scripts is a dependency', () => {
    const { preset } = selectNodePreset(pkg({ 'react-scripts': '5.0.1' }));
    expect(preset.framework).toBe('cra');
    expect(preset.envFiles).toEqual(['.env', '.env.{env}', '.env.local', '.env.{env}.local']);
    expect(preset.clientPrefix).toBe('REACT_APP_');
    expect(preset.environmentVariables).toEqual(['NODE_ENV']);
    expect(preset.environments).toEqual(['development', 'production', 'test']);
    expect(preset.skipLocalInTest).toBe(true);
  });

  /**
   * dotenv-flow ranks `.env.local` below the mode files like Vite, skips it under `test` and has no
   * client prefix. Expected: the dotenv-flow preset with modes taken from the file names.
   */
  it('picks the dotenv-flow preset when dotenv-flow is a dependency', () => {
    const { preset } = selectNodePreset(pkg({ 'dotenv-flow': '4.1.0' }));
    expect(preset.framework).toBe('dotenv-flow');
    expect(preset.envFiles).toEqual(['.env', '.env.local', '.env.{env}', '.env.{env}.local']);
    expect(preset.clientPrefix).toBeUndefined();
    expect(preset.environmentVariables).toEqual(['NODE_ENV']);
    expect(preset.environments).toBeUndefined();
    expect(preset.skipLocalInTest).toBe(true);
  });

  /**
   * A project can depend on several frameworks; the one owning the dev server decides. Expected:
   * next beats everything, react-scripts beats vite, vite beats dotenv-flow.
   */
  it.each([
    [{ next: '1', vite: '1', 'react-scripts': '1', 'dotenv-flow': '1' }, 'next'],
    [{ 'react-scripts': '1', vite: '1' }, 'cra'],
    [{ vite: '1', 'dotenv-flow': '1' }, 'vite'],
  ])('resolves %o to %s', (deps, framework) => {
    expect(selectNodePreset(pkg(deps)).preset.framework).toBe(framework);
  });

  /**
   * A broken or non-object `package.json` must not break the panel. Expected: the generic preset and
   * one warning pointing at the file.
   */
  it.each(['{ "name": ', '[]', 'null'])('falls back to generic with a warning for unusable package.json %j', (text) => {
    const { preset, diagnostics } = selectNodePreset(text, { filePath: '/app/package.json' });
    expect(preset.framework).toBe('generic');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('/app/package.json');
  });

  /**
   * The `effectiveConfig.node.framework` setting overrides detection, even when package.json is
   * unusable. Expected: the named preset, no detection warning; `auto` keeps detection.
   */
  it('honours an explicit framework override and keeps detection for auto', () => {
    expect(selectNodePreset(pkg({ next: '1' }), { framework: 'vite' }).preset.framework).toBe('vite');
    expect(selectNodePreset('not json', { framework: 'cra' })).toMatchObject({ preset: { framework: 'cra' }, diagnostics: [] });
    expect(selectNodePreset(pkg({ next: '1' }), { framework: 'auto' }).preset.framework).toBe('next');
  });
});
