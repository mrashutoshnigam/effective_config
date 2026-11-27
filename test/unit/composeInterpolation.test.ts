import { describe, it, expect } from 'vitest';
import { MAX_INTERPOLATED_LENGTH, interpolate, type InterpolationResult } from '../../src/compose/interpolation';

/**
 * Builds a lookup over a plain record.
 * @param values Variable values by name; a missing name is unset.
 * @returns The lookup.
 */
const vars = (values: Record<string, string>) => (name: string): string | undefined => values[name];

/**
 * Interpolates against a plain record.
 * @param text Text to expand.
 * @param values Variables that are set.
 * @returns The interpolation result.
 */
const run = (text: string, values: Record<string, string> = {}): InterpolationResult => interpolate(text, vars(values));

describe('interpolate', () => {
  /**
   * Validates the escape for a literal dollar sign. Expected: `$$` gives `$`, nothing is looked up.
   */
  it('turns $$ into $', () => {
    expect(run('a$$b')).toEqual({ value: 'a$b', references: [], unset: [], errors: [] });
  });

  /**
   * Validates that an escaped dollar before braces is not a variable (Review Focus 2). Expected: the
   * literal text `${HOME}`, with no reference even though HOME is set.
   */
  it('keeps $${HOME} literal', () => {
    expect(run('$${HOME}', { HOME: '/h' })).toEqual({ value: '${HOME}', references: [], unset: [], errors: [] });
  });

  /**
   * Validates plain substitution in both spellings. Expected: the value, and the name recorded once.
   */
  it('substitutes $VAR and ${VAR}', () => {
    expect(run('$A-${A}', { A: '1' })).toEqual({ value: '1-1', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates an unset variable without default, which Compose warns about and replaces with an empty
   * string. Expected: `''`, and the name in both `references` and `unset`.
   */
  it('replaces an unset $VAR or ${VAR} with an empty string and lists it as unset', () => {
    expect(run('x$A${B}y')).toEqual({ value: 'xy', references: ['A', 'B'], unset: ['A', 'B'], errors: [] });
  });

  /**
   * Validates that a set but empty variable is not unset. Expected: `''` without an unset entry.
   */
  it('does not list a set but empty variable as unset', () => {
    expect(run('${A}', { A: '' })).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates `:-`, which falls back when the variable is unset or empty. Expected: the default for
   * unset and empty, the value otherwise; never an unset entry.
   */
  it('uses the :- default when unset or empty', () => {
    expect(run('${A:-d}')).toEqual({ value: 'd', references: ['A'], unset: [], errors: [] });
    expect(run('${A:-d}', { A: '' })).toEqual({ value: 'd', references: ['A'], unset: [], errors: [] });
    expect(run('${A:-d}', { A: 'v' })).toEqual({ value: 'v', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates `-`, which falls back only when the variable is unset. Expected: the default for unset,
   * the empty value when set but empty.
   */
  it('uses the - default only when unset', () => {
    expect(run('${A-d}')).toEqual({ value: 'd', references: ['A'], unset: [], errors: [] });
    expect(run('${A-d}', { A: '' })).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates `:?`, which fails when the variable is unset or empty. Expected: the error copy with the
   * author's message, and the expression replaced by `''`; the value when set.
   */
  it('fails :? when unset or empty', () => {
    const failure = { value: 'ab', references: ['A'], unset: [], errors: ['required variable A is missing a value: need A'] };
    expect(run('a${A:?need A}b')).toEqual(failure);
    expect(run('a${A:?need A}b', { A: '' })).toEqual(failure);
    expect(run('a${A:?need A}b', { A: 'v' })).toEqual({ value: 'avb', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates `?`, which fails only when the variable is unset. Expected: an error when unset, the
   * empty value when set but empty.
   */
  it('fails ? only when unset', () => {
    expect(run('${A?need A}')).toEqual({ value: '', references: ['A'], unset: [], errors: ['required variable A is missing a value: need A'] });
    expect(run('${A?need A}', { A: '' })).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates the error copy when the author gave no message. Expected: the sentence ends after
   * `value`, without a colon.
   */
  it('omits the colon when the :? message is empty', () => {
    expect(run('${A:?}').errors).toEqual(['required variable A is missing a value']);
  });

  /**
   * Validates `:+`, which replaces a set, non-empty variable. Expected: the replacement when set and
   * non-empty, `''` when empty or unset.
   */
  it('uses the :+ replacement only when set and non-empty', () => {
    expect(run('${A:+r}', { A: 'v' })).toEqual({ value: 'r', references: ['A'], unset: [], errors: [] });
    expect(run('${A:+r}', { A: '' })).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
    expect(run('${A:+r}')).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates `+`, which replaces any set variable. Expected: the replacement when set (even empty),
   * `''` when unset.
   */
  it('uses the + replacement whenever set', () => {
    expect(run('${A+r}', { A: '' })).toEqual({ value: 'r', references: ['A'], unset: [], errors: [] });
    expect(run('${A+r}')).toEqual({ value: '', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates recursive defaults and replacements. Expected: the nested expressions expand and every
   * name read is referenced in first-seen order.
   */
  it('interpolates defaults and replacements recursively', () => {
    expect(run('${A:-${B:-x}}')).toEqual({ value: 'x', references: ['A', 'B'], unset: [], errors: [] });
    expect(run('${A:+[$B]}', { A: '1', B: '2' })).toEqual({ value: '[2]', references: ['A', 'B'], unset: [], errors: [] });
  });

  /**
   * Validates that a `:?` message is quoted as the author wrote it. compose-go interpolates it, but the
   * diagnostic banner is not masked, so an expanded message could show a secret. Expected: the message
   * keeps `${DB_PASSWORD}` literally, the secret never appears, and nothing in the message is read.
   */
  it('quotes the :? message as written, without interpolating it', () => {
    const result = run('${A:?${DB_PASSWORD}}', { DB_PASSWORD: 'hunter2' });
    expect(result).toEqual({ value: '', references: ['A'], unset: [], errors: ['required variable A is missing a value: ${DB_PASSWORD}'] });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  /**
   * Validates brace matching inside a default, which compose-go's `getFirstBraceClosingIndex` does by
   * counting every `{` and `}` with no special case for `$$`. Expected: `${A:-$${X}}` closes at its last
   * brace, giving the literal `${X}` when A is unset and A's value when it is set, with no error.
   */
  it('closes an expression whose default holds an escaped $${X}', () => {
    expect(run('${A:-$${X}}')).toEqual({ value: '${X}', references: ['A'], unset: [], errors: [] });
    expect(run('${A:-$${X}}', { A: 'v' })).toEqual({ value: 'v', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates an unbalanced `{` inside a default. compose-go finds no balanced brace and falls back to
   * its pattern's greedy match, which ends at the last `}` of the line. Expected: `${A:-{x}` gives `{x`.
   */
  it('falls back to the last brace of the line when braces do not balance', () => {
    expect(run('${A:-{x}')).toEqual({ value: '{x', references: ['A'], unset: [], errors: [] });
  });

  /**
   * Validates that a dollar not followed by a name stays literal. Expected: `$1`, a trailing `$` and
   * `$-` are kept as written.
   */
  it('keeps a $ not followed by a name literal', () => {
    expect(run('$1 $- $')).toEqual({ value: '$1 $- $', references: [], unset: [], errors: [] });
  });

  /**
   * Validates an unterminated expression. Expected: the format error naming the variable, and the
   * unterminated expression dropped from the value.
   */
  it('reports an unterminated ${ as an invalid format', () => {
    expect(run('a${FOO')).toEqual({ value: 'a', references: [], unset: [], errors: ['invalid interpolation format for FOO'] });
  });

  /**
   * Validates an expression whose name is followed by an unknown operator. Expected: the format error,
   * and the expression replaced by `''`.
   */
  it('reports an unknown operator as an invalid format', () => {
    expect(run('a${FOO/x/y}b')).toEqual({ value: 'ab', references: [], unset: [], errors: ['invalid interpolation format for FOO'] });
  });

  /**
   * Validates that a format error never quotes text past the variable name, which may be a secret
   * default. Expected: the message names at most 40 name characters and nothing after them.
   */
  it('quotes only the variable name, capped at 40 characters, in a format error', () => {
    expect(run('${DB:-hunter2').errors).toEqual(['invalid interpolation format for DB']);
    expect(run('${' + 'N'.repeat(60)).errors).toEqual([`invalid interpolation format for ${'N'.repeat(40)}`]);
  });

  /**
   * Validates the nesting bound on untrusted files (Review Focus 4). Expected: 10 000 nested defaults
   * give one depth error and return, with no stack overflow.
   */
  it('deep nesting is bounded', () => {
    const text = '${A:-'.repeat(10000) + 'x' + '}'.repeat(10000);
    const result = run(text);
    expect(result.errors).toEqual(['interpolation nests deeper than 32 levels']);
  });

  /**
   * Validates the output bound on untrusted values. Expected: two 600 000-character values give one
   * length error instead of a 1.2 MB string.
   */
  it('output length is bounded', () => {
    const result = run('${A}${A}', { A: 'x'.repeat(600_000) });
    expect(result.errors).toEqual(['interpolated value exceeds 1000000 characters']);
    expect(result.value.length).toBeLessThanOrEqual(MAX_INTERPOLATED_LENGTH);
  });
});
