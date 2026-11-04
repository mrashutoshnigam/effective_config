import { describe, it, expect } from 'vitest';
import { normalizeKey, compareKeys, envVarNameToKey, keyToEnvVarName, splitKey } from '../../src/engine/keys';

describe('keys', () => {
  it('envVarNameToKey converts "__" to ":" — Logging__LogLevel__Default becomes Logging:LogLevel:Default', () => {
    expect(envVarNameToKey('Logging__LogLevel__Default')).toBe('Logging:LogLevel:Default');
  });

  it('envVarNameToKey leaves a single underscore untouched — A_B stays A_B', () => {
    expect(envVarNameToKey('A_B')).toBe('A_B');
  });

  it('keyToEnvVarName converts ":" to "__" — A:B:0 becomes A__B__0', () => {
    expect(keyToEnvVarName('A:B:0')).toBe('A__B__0');
  });

  it('normalizeKey lower-cases the key — Logging:LogLevel becomes logging:loglevel', () => {
    expect(normalizeKey('Logging:LogLevel')).toBe('logging:loglevel');
  });

  it('splitKey splits on ":" — A:B:0 yields [A, B, 0]', () => {
    expect(splitKey('A:B:0')).toEqual(['A', 'B', '0']);
  });

  it('splitKey of a single segment — "A" yields ["A"]', () => {
    expect(splitKey('A')).toEqual(['A']);
  });

  it('splitKey of empty string — yields [""] (one empty segment)', () => {
    expect(splitKey('')).toEqual(['']);
  });

  it('compareKeys sorts numeric by value before text, text case-insensitively — [10,2,b,A] -> [2,10,A,b]', () => {
    expect(['10', '2', 'b', 'A'].sort(compareKeys)).toEqual(['2', '10', 'A', 'b']);
  });

  it('compareKeys treats differing case as equal — "a" vs "A" returns 0', () => {
    expect(compareKeys('a', 'A')).toBe(0);
  });

  it('compareKeys puts numbers before text — "0" < "a" and "a" > "0"', () => {
    expect(compareKeys('0', 'a')).toBeLessThan(0);
    expect(compareKeys('a', '0')).toBeGreaterThan(0);
  });

  it('compareKeys compares numerically — "9" < "10"', () => {
    expect(compareKeys('9', '10')).toBeLessThan(0);
  });

  it('compareKeys on equal-valued numerics with leading zeros — "01" vs "1" returns 0', () => {
    expect(compareKeys('01', '1')).toBe(0);
  });

  it('compareKeys orders plain text ordinally — "abc" < "abd"', () => {
    expect(compareKeys('abc', 'abd')).toBeLessThan(0);
  });

  it('compareKeys treats negative or decimal segments as text — they sort after numerics', () => {
    expect(['b', '1.5', '-1', '3'].sort(compareKeys)).toEqual(['3', '-1', '1.5', 'b']);
  });
});
