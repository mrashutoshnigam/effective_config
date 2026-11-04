import { parseTree, printParseErrorCode, ParseError, Node } from 'jsonc-parser';
import type { Diagnostic, LayerEntry, SourceLocation } from '../engine/types';

/** Result of parsing one JSON(C) configuration file. */
export interface JsonLayerParseResult {
  /** Flattened entries in source order (empty on error). */
  entries: LayerEntry[];
  /** Problems found while parsing. */
  diagnostics: Diagnostic[];
}

/**
 * Removes a leading UTF-8 byte order mark, if present.
 * @param text File contents.
 * @returns The text without a leading BOM.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Converts an offset into a 0-based line/column pair.
 * @param text Text the offset refers to.
 * @param offset 0-based character offset.
 * @returns 0-based `line` and `column`.
 */
export function getLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/**
 * Parses a JSON file with comments and trailing commas (as .NET accepts) into flat
 * `Section:Key` entries, using .NET value conversion: strings as-is, numbers as raw
 * source text, booleans as `True`/`False`, null as `""`, and empty objects/arrays as
 * a single entry with a `null` value. A leading BOM is ignored (positions refer to
 * the text without it).
 * @param text File contents.
 * @param filePath Path recorded in each entry's location.
 * @returns Entries and diagnostics. A broken file yields no entries and one error;
 * an empty file yields no entries and an `info` diagnostic.
 */
export function parseJsonLayer(text: string, filePath: string): JsonLayerParseResult {
  text = stripBom(text);
  const loc = (offset: number): SourceLocation => ({ filePath, ...getLineCol(text, offset) });

  if (text.trim() === '') {
    return { entries: [], diagnostics: [{ severity: 'info', message: 'empty file', location: loc(0) }] };
  }

  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    const first = errors[0];
    return {
      entries: [],
      diagnostics: [{
        severity: 'error',
        message: `JSON parse error: ${printParseErrorCode(first.error)}`,
        location: loc(first.offset),
      }],
    };
  }
  if (!root) {
    return { entries: [], diagnostics: [{ severity: 'info', message: 'empty file', location: loc(0) }] };
  }
  if (root.type !== 'object') {
    return {
      entries: [],
      diagnostics: [{ severity: 'error', message: 'root must be an object', location: loc(root.offset) }],
    };
  }

  const entries: LayerEntry[] = [];
  const add = (key: string, value: string | null, node: Node): void => {
    entries.push({ key, value, location: loc(node.offset) });
  };
  const join = (prefix: string, segment: string): string => (prefix ? `${prefix}:${segment}` : segment);

  let duplicate: Diagnostic | undefined;

  const walk = (node: Node, path: string): void => {
    if (duplicate) {
      return;
    }
    switch (node.type) {
      case 'object': {
        const props = node.children ?? [];
        if (props.length === 0) {
          if (path) {
            add(path, null, node);
          }
          return;
        }
        const seen = new Set<string>();
        for (const prop of props) {
          const [keyNode, valueNode] = prop.children ?? [];
          if (keyNode && valueNode) {
            const fullKey = join(path, String(keyNode.value));
            const lower = String(keyNode.value).toLowerCase();
            if (seen.has(lower)) {
              duplicate = {
                severity: 'error',
                message: `Duplicate key '${fullKey}' (keys are case-insensitive)`,
                location: loc(keyNode.offset),
              };
              return;
            }
            seen.add(lower);
            walk(valueNode, fullKey);
            if (duplicate) {
              return;
            }
          }
        }
        return;
      }
      case 'array': {
        const items = node.children ?? [];
        if (items.length === 0) {
          add(path, null, node);
          return;
        }
        items.forEach((item, i) => walk(item, join(path, String(i))));
        return;
      }
      case 'string':
        add(path, String(node.value), node);
        return;
      case 'number':
        add(path, text.slice(node.offset, node.offset + node.length), node);
        return;
      case 'boolean':
        add(path, node.value ? 'True' : 'False', node);
        return;
      case 'null':
        add(path, '', node);
        return;
    }
  };

  walk(root, '');
  if (duplicate) {
    return { entries: [], diagnostics: [duplicate] };
  }
  return { entries, diagnostics: [] };
}
