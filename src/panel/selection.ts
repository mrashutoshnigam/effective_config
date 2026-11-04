import type { ProjectDescription, Selection } from '../provider';
import type { WebviewMessage } from './messages';

/** The `select` message sent by the webview. */
export type SelectMessage = Extract<WebviewMessage, { type: 'select' }>;

/** Environment used when a profile does not define one. */
const DEFAULT_ENVIRONMENT = 'Development';

/**
 * Computes the selection that follows a `select` message (pure; no side effects).
 * - A different project resets to that project's default selection.
 * - A profile name selects it and takes its environment (`Development` when the profile sets none or is unknown).
 * - A `null` profile clears the profile and keeps the environment.
 * - An explicit environment always overrides whatever the steps above chose.
 * @param current The current selection.
 * @param message The select message.
 * @param description Description of the target project; needed when the project changed or a profile name is given.
 * @param projectChanged True when the message switches to a different project.
 * @returns The new selection (never mutates `current`).
 */
export function nextSelection(
  current: Selection,
  message: SelectMessage,
  description: ProjectDescription | undefined,
  projectChanged = false,
): Selection {
  let selection: Selection = projectChanged && description ? { ...description.defaultSelection } : { ...current };
  if (message.profile !== undefined) {
    if (message.profile === null) {
      selection = { environment: selection.environment };
    } else {
      const profileEnvironments = description?.profileEnvironments ?? {};
      const fromProfile = Object.hasOwn(profileEnvironments, message.profile) ? profileEnvironments[message.profile] : undefined;
      selection = { profile: message.profile, environment: fromProfile ?? DEFAULT_ENVIRONMENT };
    }
  }
  if (message.environment !== undefined) {
    selection = { ...selection, environment: message.environment };
  }
  return selection;
}
