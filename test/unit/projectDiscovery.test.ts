import { describe, it, expect } from 'vitest';
import { findOwningProject } from '../../src/dotnet/projectDiscovery';
import type { ProjectInfo } from '../../src/provider';

/** Builds a project rooted at `dir`. */
function P(dir: string, kind: 'dotnet' | 'python' = 'dotnet'): ProjectInfo {
  return { id: `${dir}/x.${kind}`, name: 'x', dir, projectFile: `${dir}/x.${kind}`, kind };
}

describe('findOwningProject', () => {
  it('picks the deepest containing project — nested project wins over its parent', () => {
    expect(findOwningProject('/r/src/Api/appsettings.json', [P('/r/src'), P('/r/src/Api')])?.dir).toBe('/r/src/Api');
  });

  it('returns undefined when no project contains the file', () => {
    expect(findOwningProject('/other/appsettings.json', [P('/r/src')])).toBeUndefined();
  });

  it('does not match sibling directories sharing a name prefix — /r/src/Api2 is not in /r/src/Api', () => {
    expect(findOwningProject('/r/src/Api2/a.json', [P('/r/src/Api')])).toBeUndefined();
  });

  it('matches Windows paths case-insensitively with mixed separators', () => {
    expect(findOwningProject('C:\\R\\Src\\api\\appsettings.json', [P('c:/r/src/Api')])?.dir).toBe('c:/r/src/Api');
  });

  it('matches the project file itself — a .csproj in the project dir is owned', () => {
    expect(findOwningProject('/r/src/Api/x.csproj', [P('/r/src/Api')])?.dir).toBe('/r/src/Api');
  });

  it('returns undefined for an empty project list', () => {
    expect(findOwningProject('/r/a.json', [])).toBeUndefined();
  });

  it('same-folder .NET and Python projects — .env prefers python, appsettings prefers dotnet', () => {
    const projects = [P('/r/app', 'dotnet'), P('/r/app', 'python')];
    expect(findOwningProject('/r/app/.env', projects, 'python')?.kind).toBe('python');
    expect(findOwningProject('/r/app/appsettings.json', projects, 'dotnet')?.kind).toBe('dotnet');
    expect(findOwningProject('/r/app/.env', [...projects].reverse(), 'python')?.kind).toBe('python');
  });

  it('deeper project wins over a preferred-kind project in a parent folder', () => {
    const projects = [P('/r', 'python'), P('/r/app', 'dotnet')];
    expect(findOwningProject('/r/app/.env', projects, 'python')?.kind).toBe('dotnet');
  });

  it('falls back to the only project at the depth when the preferred kind is absent', () => {
    expect(findOwningProject('/r/app/.env', [P('/r/app', 'dotnet')], 'python')?.kind).toBe('dotnet');
  });

  it('keeps the first project at equal depth when no preferred kind is given', () => {
    const projects = [P('/r/app', 'python'), P('/r/app', 'dotnet')];
    expect(findOwningProject('/r/app/x', projects)?.kind).toBe('python');
  });
});
