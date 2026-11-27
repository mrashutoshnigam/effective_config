import * as vscode from 'vscode';
import { readSettings, type Settings, type SettingsSource } from './settings';

/** Returns a copy of `process.env` without undefined values. */
export function osEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Gives raw access to the `effectiveConfig` settings section; a language reads its own keys through
 * it, so its settings need no change to the shared {@link Settings} type.
 * @param scope Resource whose folder settings apply, for settings with `resource` scope; omitted, the
 * workspace values are read.
 * @returns A source reading the current values.
 */
export function settingsSource(scope?: vscode.Uri): SettingsSource {
  const section = vscode.workspace.getConfiguration('effectiveConfig', scope);
  return { get: <T>(key: string) => section.get<T>(key) };
}

/** Reads the current extension settings with defaults applied. */
export function currentSettings(): Settings {
  return readSettings(settingsSource());
}
