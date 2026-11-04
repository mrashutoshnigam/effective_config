import { describe, expect, it } from 'vitest';
import { globToRegExp, isSensitiveKey } from '../../src/engine/mask';

describe('globToRegExp', () => {
  it('matches case-insensitively — "*password*" matches "Db:AdminPassword"', () => {
    expect(globToRegExp('*password*').test('Db:AdminPassword')).toBe(true);
  });

  it('treats * as any chars including colon — "ConnectionStrings:*" matches nested key', () => {
    expect(globToRegExp('ConnectionStrings:*').test('ConnectionStrings:Main:Sub')).toBe(true);
  });

  it('is anchored — "Key" does not match "MyKeyX"', () => {
    expect(globToRegExp('Key').test('MyKeyX')).toBe(false);
  });

  it('escapes regex metacharacters — "a.b" does not match "axb"', () => {
    expect(globToRegExp('a.b(c)+[d]').test('a.b(c)+[d]')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('empty glob matches only the empty string', () => {
    expect(globToRegExp('').test('')).toBe(true);
    expect(globToRegExp('').test('x')).toBe(false);
  });
});

describe('isSensitiveKey', () => {
  it('returns true when a wildcard pattern matches — Db:AdminPassword with *Password*', () => {
    expect(isSensitiveKey('Db:AdminPassword', ['*Password*'])).toBe(true);
  });

  it('returns true for prefix pattern — ConnectionStrings:Main with ConnectionStrings:*', () => {
    expect(isSensitiveKey('ConnectionStrings:Main', ['ConnectionStrings:*'])).toBe(true);
  });

  it('returns false when the pattern needs the colon — "connectionstrings" alone does not match', () => {
    expect(isSensitiveKey('connectionstrings', ['ConnectionStrings:*'])).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(isSensitiveKey('Db:Password', [])).toBe(false);
  });

  it('returns true if any one of several patterns matches', () => {
    expect(isSensitiveKey('Api:Secret', ['*Password*', '*Secret*'])).toBe(true);
  });
});
