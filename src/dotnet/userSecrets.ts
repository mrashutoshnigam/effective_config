import * as path from 'node:path';

/**
 * Extracts `<UserSecretsId>` from project file text.
 * @param csprojText Contents of the `.csproj`.
 * @returns The trimmed id (first occurrence), or undefined when absent or blank.
 */
export function readUserSecretsId(csprojText: string): string | undefined {
  const match = /<UserSecretsId>([\s\S]*?)<\/UserSecretsId>/i.exec(csprojText);
  const id = match?.[1].trim();
  return id ? id : undefined;
}

/**
 * Computes where .NET stores the user secrets file for an id.
 * @param id The `UserSecretsId`.
 * @param platform Host platform; `win32` uses `%APPDATA%\Microsoft\UserSecrets`, others `~/.microsoft/usersecrets`.
 * @param env Environment variables (`APPDATA` is read on Windows, falling back to `<home>\AppData\Roaming`).
 * @param homeDir The user's home directory.
 * @returns The path of `secrets.json`, using the platform's separators.
 */
export function userSecretsPath(
  id: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Microsoft', 'UserSecrets', id, 'secrets.json');
  }
  return path.posix.join(homeDir, '.microsoft', 'usersecrets', id, 'secrets.json');
}
