import * as vscode from 'vscode';
import { readSettings, type Settings } from './settings';

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

/** Reads the current extension settings with defaults applied. */
export function currentSettings(): Settings {
  const section = vscode.workspace.getConfiguration('effectiveConfig');
  return readSettings({ get: <T>(key: string) => section.get<T>(key) });
}
