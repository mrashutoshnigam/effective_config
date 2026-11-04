import { describe, it, expect } from 'vitest';
import { readUserSecretsId, userSecretsPath } from '../../src/dotnet/userSecrets';

describe('readUserSecretsId', () => {
  it('extracts and trims the id — returns the text between the tags', () => {
    expect(readUserSecretsId('<Project><PropertyGroup><UserSecretsId> abc-123 </UserSecretsId></PropertyGroup></Project>')).toBe('abc-123');
  });

  it('returns undefined when the element is absent', () => {
    expect(readUserSecretsId('<Project></Project>')).toBeUndefined();
  });

  it('returns undefined when the element is empty or whitespace', () => {
    expect(readUserSecretsId('<UserSecretsId>  </UserSecretsId>')).toBeUndefined();
  });

  it('extracts an id spanning multiple lines of csproj — first occurrence wins', () => {
    expect(readUserSecretsId('<A>\n<UserSecretsId>one</UserSecretsId>\n<UserSecretsId>two</UserSecretsId>\n</A>')).toBe('one');
  });
});

describe('userSecretsPath', () => {
  it('builds the %APPDATA% path on win32 — backslash separators', () => {
    expect(userSecretsPath('id', 'win32', { APPDATA: 'C:\\A' }, 'C:\\H')).toBe('C:\\A\\Microsoft\\UserSecrets\\id\\secrets.json');
  });

  it('builds the home-relative lower-case path on linux — forward slashes', () => {
    expect(userSecretsPath('id', 'linux', {}, '/home/u')).toBe('/home/u/.microsoft/usersecrets/id/secrets.json');
  });

  it('uses the same home-relative path on darwin', () => {
    expect(userSecretsPath('id', 'darwin', {}, '/Users/u')).toBe('/Users/u/.microsoft/usersecrets/id/secrets.json');
  });

  it('falls back to home AppData\\Roaming on win32 when APPDATA is unset', () => {
    expect(userSecretsPath('id', 'win32', {}, 'C:\\H')).toBe('C:\\H\\AppData\\Roaming\\Microsoft\\UserSecrets\\id\\secrets.json');
  });
});
