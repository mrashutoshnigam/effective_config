import { describe, it, expect } from 'vitest';
import { isWebviewMessage, WEBVIEW_MESSAGE_TYPES, type WebviewMessage } from '../../src/panel/messages';

describe('isWebviewMessage', () => {
  const valid: WebviewMessage[] = [
    { type: 'ready' },
    { type: 'refresh' },
    { type: 'exportMenu' },
    { type: 'select' },
    { type: 'select', projectId: 'p', profile: 'web', environment: 'Production' },
    { type: 'select', profile: null },
    { type: 'reveal', path: 'A:B', revealed: true },
    { type: 'openSource', locationId: 'r1:3' },
    { type: 'copy', path: 'A', what: 'value' },
    { type: 'copy', path: 'A', what: 'keyPath' },
    { type: 'copy', path: 'A', what: 'envVarName' },
    { type: 'export', format: 'json', revealAll: false },
    { type: 'export', format: 'env', revealAll: true },
  ];

  it.each(valid)('accepts a well-formed message %j', (message) => {
    expect(isWebviewMessage(message)).toBe(true);
  });

  const invalid: unknown[] = [
    undefined, null, 'ready', 42, [], {}, { type: 'nope' }, { type: 5 },
    { type: 'select', projectId: 1 },
    { type: 'select', profile: 3 },
    { type: 'select', environment: {} },
    { type: 'reveal', path: 'A' },
    { type: 'reveal', path: 1, revealed: true },
    { type: 'reveal', path: 'A', revealed: 'yes' },
    { type: 'openSource' },
    { type: 'openSource', locationId: 7 },
    { type: 'copy', path: 'A', what: 'everything' },
    { type: 'copy', what: 'value' },
    { type: 'export', format: 'xml', revealAll: false },
    { type: 'export', format: 'json' },
    { type: 'export', format: 'json', revealAll: 'no' },
    { type: '__proto__' },
    { type: 'toString' },
  ];

  it.each(invalid)('rejects a malformed message %j', (message) => {
    expect(isWebviewMessage(message)).toBe(false);
  });

  it('knows exactly the message types of the protocol — a new type must be added with its validator', () => {
    expect([...WEBVIEW_MESSAGE_TYPES].sort()).toEqual(['copy', 'export', 'exportMenu', 'openSource', 'ready', 'refresh', 'reveal', 'select']);
  });
});
