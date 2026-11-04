import { describe, it, expect } from 'vitest';
import { nextSelection } from '../../src/panel/selection';
import type { ProjectDescription } from '../../src/provider';

const description: ProjectDescription = {
  profiles: ['WebApp', 'Staging', 'NoEnv'],
  environments: ['Development', 'Staging'],
  profileEnvironments: { WebApp: 'Development', Staging: 'Staging', NoEnv: undefined },
  defaultSelection: { profile: 'WebApp', environment: 'Development' },
};

describe('nextSelection', () => {
  it('uses the new project default selection when the project changed — profile and environment reset', () => {
    const other: ProjectDescription = { ...description, defaultSelection: { environment: 'Production' } };
    expect(nextSelection({ profile: 'Staging', environment: 'Staging' }, { type: 'select', projectId: 'p2' }, other, true))
      .toEqual({ environment: 'Production' });
  });

  it('takes the profile environment when a profile is chosen — Staging profile selects Staging', () => {
    expect(nextSelection({ environment: 'Development' }, { type: 'select', profile: 'Staging' }, description))
      .toEqual({ profile: 'Staging', environment: 'Staging' });
  });

  it('falls back to Development when the profile sets no environment', () => {
    expect(nextSelection({ environment: 'Staging' }, { type: 'select', profile: 'NoEnv' }, description))
      .toEqual({ profile: 'NoEnv', environment: 'Development' });
  });

  it('falls back to Development for a prototype key like "constructor" — inherited properties are ignored', () => {
    expect(nextSelection({ environment: 'Staging' }, { type: 'select', profile: 'constructor' }, description))
      .toEqual({ profile: 'constructor', environment: 'Development' });
  });

  it('falls back to Development when no description is available', () => {
    expect(nextSelection({ environment: 'Staging' }, { type: 'select', profile: 'WebApp' }, undefined))
      .toEqual({ profile: 'WebApp', environment: 'Development' });
  });

  it('clears the profile for a null profile and keeps the environment', () => {
    expect(nextSelection({ profile: 'Staging', environment: 'Staging' }, { type: 'select', profile: null }, undefined))
      .toEqual({ environment: 'Staging' });
  });

  it('applies an explicit environment on top of the current selection — profile kept', () => {
    expect(nextSelection({ profile: 'WebApp', environment: 'Development' }, { type: 'select', environment: 'QA' }, undefined))
      .toEqual({ profile: 'WebApp', environment: 'QA' });
  });

  it('lets an explicit environment override the profile environment in the same message', () => {
    expect(nextSelection({ environment: 'Development' }, { type: 'select', profile: 'Staging', environment: 'QA' }, description))
      .toEqual({ profile: 'Staging', environment: 'QA' });
  });

  it('lets an explicit environment override the new project default', () => {
    expect(nextSelection({ environment: 'Staging' }, { type: 'select', projectId: 'p2', environment: 'QA' }, description, true))
      .toEqual({ profile: 'WebApp', environment: 'QA' });
  });

  it('returns an equal copy and never mutates the input when the message selects nothing', () => {
    const current = { profile: 'WebApp', environment: 'Development' };
    const result = nextSelection(current, { type: 'select' }, undefined);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });
});
