import type { SettingsSource } from '../settings';
import { NODE_FRAMEWORK_SETTINGS, type NodeFrameworkSetting } from './presets';

/** The Node settings of the `effectiveConfig` section, with defaults applied. */
export interface NodeSettings {
  /** Framework whose `.env` rules are simulated; `auto` detects it from `package.json`. */
  framework: NodeFrameworkSetting;
}

/**
 * Tells whether a value is one of {@link NODE_FRAMEWORK_SETTINGS}.
 * @param value The raw setting value.
 * @returns True for a known framework setting.
 */
function isFrameworkSetting(value: unknown): value is NodeFrameworkSetting {
  return (NODE_FRAMEWORK_SETTINGS as readonly unknown[]).includes(value);
}

/**
 * Reads the Node settings, falling back to `auto` for a missing or unknown framework.
 * @param source Where the raw values come from.
 * @returns The typed settings.
 */
export function readNodeSettings(source: SettingsSource): NodeSettings {
  const framework = source.get<unknown>('node.framework');
  return { framework: isFrameworkSetting(framework) ? framework : 'auto' };
}
