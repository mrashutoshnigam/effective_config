import * as path from 'node:path';
import type { Diagnostic, LayerEntry, SourceLocation } from '../engine/types';
import { parseYamlLayer } from '../sources/yamlLayer';
import { resolveFrom } from './composeFiles';
import { interpolate } from './interpolation';

/** Compose merge tags (https://docs.docker.com/reference/compose-file/merge/#reset-value). */
export type MergeTag = '!reset' | '!override';

/** The merge tags, as passed to the YAML parser. */
const MERGE_TAGS: readonly MergeTag[] = ['!reset', '!override'];

/** One `env_file` entry of a service. */
export interface EnvFileRef {
  /** Absolute path, resolved against the declaring compose file's directory. */
  path: string;
  /** False when a missing file is ignored (`required: false`); Compose's default is true. */
  required: boolean;
  /** Where the path is written. */
  location: SourceLocation;
}

/** One variable of a service's `environment`. */
export interface EnvironmentItem {
  /** Variable name. */
  name: string;
  /** Value as written, before interpolation; null for `FOO:` or `- FOO`, which take the scope's value. */
  raw: string | null;
  /** Where the value (map form) or the item (list form) is written. */
  location: SourceLocation;
}

/** What one compose file says about one service. */
export interface ServiceFragment {
  /** Service name. */
  name: string;
  /** Profiles the service is gated by; empty when it always starts. */
  profiles: string[];
  /** The `env_file` entries; undefined when this file does not set `env_file`. */
  envFiles?: EnvFileRef[];
  /** Merge tag on `env_file`. */
  envFilesTag?: MergeTag;
  /** The `environment` variables in source order; undefined when this file does not set `environment`. */
  environment?: EnvironmentItem[];
  /** Merge tag on `environment`. */
  environmentTag?: MergeTag;
  /** Variables written as `FOO: !reset …`, which remove FOO set by lower files. */
  resetVariables?: string[];
}

/** One parsed compose file. */
export interface ComposeFileModel {
  /** Absolute path of the file. */
  filePath: string;
  /** Services in source order. */
  services: ServiceFragment[];
  /** Parse problems, interpolation errors and warnings, and notes on what is not simulated. */
  diagnostics: Diagnostic[];
}

/** A service merged across compose files. */
export interface MergedService {
  /** Service name. */
  name: string;
  /** Profiles of the service across files, first-seen order. */
  profiles: string[];
  /** The `env_file` entries in load order. */
  envFiles: EnvFileRef[];
  /** One layer per file that sets `environment`, base file first. */
  environmentLayers: { filePath: string; items: EnvironmentItem[] }[];
}

/** An `env_file` entry being collected; the long form may give `required` before `path`. */
interface PendingEnvFile {
  /** Path as written, already interpolated. */
  path?: string;
  /** Value of `required`. */
  required: boolean;
  /** Where the path is written. */
  location?: SourceLocation;
}

/** A service being collected from the flattened entries. */
interface PendingService {
  /** The fragment built so far. */
  fragment: ServiceFragment;
  /** `env_file` entries by index (`''` for the string form), in first-seen order. */
  envFiles: Map<string, PendingEnvFile>;
}

/**
 * Tells whether a key segment is a sequence index.
 * @param segment Key segment.
 * @returns True for a non-negative integer.
 */
function isIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/** Reads one compose file into service fragments. */
class ComposeFileReader {
  /** Services by name, in source order. */
  private readonly services = new Map<string, PendingService>();
  /** Diagnostics found so far, parse problems first. */
  private readonly diagnostics: Diagnostic[] = [];
  /** Keys of diagnostics already raised, so values reached twice through aliases are reported once. */
  private readonly reported = new Set<string>();
  /** Unset variables already warned about in this file. */
  private readonly warnedUnset = new Set<string>();
  /** Flattened keys whose value was null. */
  private nullKeys = new Set<string>();
  /** Merge tags by flattened key. */
  private tags = new Map<string, MergeTag>();
  /** Where `extends` or `include` is first used. */
  private unsupported: SourceLocation | undefined;

  /**
   * Creates the reader.
   * @param filePath Absolute path of the file.
   * @param lookup Resolves a variable in the interpolation scope.
   */
  constructor(
    private readonly filePath: string,
    private readonly lookup: (name: string) => string | undefined,
  ) {}

  /**
   * Reads the file.
   * @param text File contents.
   * @returns The model.
   */
  read(text: string): ComposeFileModel {
    const parsed = parseYamlLayer(text, this.filePath, { knownTags: MERGE_TAGS });
    this.diagnostics.push(...parsed.diagnostics);
    this.nullKeys = new Set(parsed.nullKeys);
    this.tags = new Map(parsed.tags.map((t) => [t.key, t.tag as MergeTag]));
    for (const entry of parsed.entries) {
      this.check(entry);
      this.visit(entry);
    }
    if (this.unsupported) {
      this.diagnostics.push({ severity: 'info', message: 'extends and include are not simulated', location: this.unsupported });
    }
    return { filePath: this.filePath, services: [...this.services.values()].map((s) => this.finish(s)), diagnostics: this.diagnostics };
  }

  /**
   * Adds a diagnostic unless the same one was raised at the same place.
   * @param diagnostic The diagnostic.
   */
  private report(diagnostic: Diagnostic): void {
    const { line, column } = diagnostic.location ?? { line: -1, column: -1 };
    const key = `${diagnostic.message}\n${line}:${column}`;
    if (!this.reported.has(key)) {
      this.reported.add(key);
      this.diagnostics.push(diagnostic);
    }
  }

  /**
   * Interpolation-checks one scalar, as Compose interpolates the whole file and rejects it when a
   * required variable is missing.
   * @param entry Flattened entry.
   */
  private check(entry: LayerEntry): void {
    if (entry.value === null || !entry.value.includes('$')) {
      return;
    }
    const result = interpolate(entry.value, this.lookup);
    for (const message of result.errors) {
      this.report({ severity: 'error', message, location: entry.location });
    }
    for (const name of result.unset) {
      if (!this.warnedUnset.has(name)) {
        this.warnedUnset.add(name);
        this.report({ severity: 'warning', message: `variable ${name} is not set; Compose uses an empty string`, location: entry.location });
      }
    }
  }

  /**
   * Gets the service being collected, adding it on first use.
   * @param name Service name.
   * @returns The pending service.
   */
  private service(name: string): PendingService {
    let pending = this.services.get(name);
    if (!pending) {
      pending = { fragment: { name, profiles: [] }, envFiles: new Map() };
      this.services.set(name, pending);
    }
    return pending;
  }

  /**
   * Routes one flattened entry to the field it belongs to.
   * @param entry Flattened entry.
   */
  private visit(entry: LayerEntry): void {
    const segments = entry.key.split(':');
    if (segments[0] === 'include') {
      this.unsupported ??= entry.location;
      return;
    }
    if (segments[0] !== 'services' || segments.length < 2) {
      return;
    }
    const pending = this.service(segments[1]);
    const field = segments[2];
    const rest = segments.slice(3);
    if (field === 'extends') {
      this.unsupported ??= entry.location;
    } else if (field === 'profiles' && rest.length === 1 && entry.value) {
      pending.fragment.profiles.push(entry.value);
    } else if (field === 'environment') {
      this.visitEnvironment(pending.fragment, entry, rest);
    } else if (field === 'env_file') {
      this.visitEnvFile(pending, entry, rest);
    }
  }

  /**
   * Reads one entry under `environment`: a map key, or a `NAME=value` / `NAME` list item.
   * @param fragment The service.
   * @param entry Flattened entry.
   * @param rest Key segments below `environment`.
   */
  private visitEnvironment(fragment: ServiceFragment, entry: LayerEntry, rest: string[]): void {
    const items = (fragment.environment ??= []);
    // Deeper keys are not valid environment entries; an empty collection or a scalar sets no variables.
    if (rest.length !== 1 || entry.location === undefined) {
      return;
    }
    const isNull = this.nullKeys.has(entry.key);
    if (isIndex(rest[0])) {
      if (isNull || !entry.value) {
        return;
      }
      const eq = entry.value.indexOf('=');
      const name = eq < 0 ? entry.value : entry.value.slice(0, eq);
      if (name) {
        items.push({ name, raw: eq < 0 ? null : entry.value.slice(eq + 1), location: entry.location });
      }
      return;
    }
    if (this.tags.get(entry.key) === '!reset') {
      (fragment.resetVariables ??= []).push(rest[0]);
      return;
    }
    items.push({ name: rest[0], raw: isNull ? null : entry.value ?? '', location: entry.location });
  }

  /**
   * Reads one entry under `env_file`: the string form, a list item, or a long-form `path`/`required`.
   * Paths are interpolated, as Compose interpolates every value of the file.
   * @param pending The service.
   * @param entry Flattened entry.
   * @param rest Key segments below `env_file`.
   */
  private visitEnvFile(pending: PendingService, entry: LayerEntry, rest: string[]): void {
    pending.fragment.envFiles ??= [];
    if (entry.value === null || (rest.length === 0 && this.nullKeys.has(entry.key))) {
      return;
    }
    const index = rest[0] ?? '';
    const field = rest.length === 2 ? rest[1] : rest.length <= 1 ? 'path' : undefined;
    if (rest.length > 2 || (index !== '' && !isIndex(index)) || field === undefined) {
      return;
    }
    let item = pending.envFiles.get(index);
    if (!item) {
      item = { required: true };
      pending.envFiles.set(index, item);
    }
    if (field === 'path') {
      item.path = interpolate(entry.value, this.lookup).value;
      item.location = entry.location;
    } else if (field === 'required') {
      item.required = entry.value.trim().toLowerCase() !== 'false';
    }
  }

  /**
   * Completes a service: resolves its env file paths and applies `!reset` to its own fields.
   * @param pending The service.
   * @returns The fragment.
   */
  private finish(pending: PendingService): ServiceFragment {
    const { fragment } = pending;
    const base = path.dirname(this.filePath);
    const environmentTag = this.tags.get(`services:${fragment.name}:environment`);
    const envFilesTag = this.tags.get(`services:${fragment.name}:env_file`);
    if (fragment.envFiles !== undefined) {
      fragment.envFiles = [...pending.envFiles.values()]
        .filter((f): f is PendingEnvFile & { path: string; location: SourceLocation } => !!f.path && f.location !== undefined)
        .map((f) => ({ path: resolveFrom(base, f.path), required: f.required, location: f.location }));
    }
    if (environmentTag) {
      fragment.environmentTag = environmentTag;
      fragment.environment = environmentTag === '!reset' ? [] : fragment.environment ?? [];
    }
    if (envFilesTag) {
      fragment.envFilesTag = envFilesTag;
      fragment.envFiles = envFilesTag === '!reset' ? [] : fragment.envFiles ?? [];
    }
    return fragment;
  }
}

/**
 * Parses one compose file. Every scalar is also interpolation-checked against `lookup`: a failed
 * `:?`/`?` check or a format error gives an error at its location, and an unset variable gives one
 * warning per name, as Compose prints.
 * @param text File contents.
 * @param filePath Absolute path of the file.
 * @param lookup Resolves a variable in the interpolation scope.
 * @returns The services and diagnostics.
 */
export function readComposeFile(text: string, filePath: string, lookup: (name: string) => string | undefined): ComposeFileModel {
  return new ComposeFileReader(filePath, lookup).read(text);
}

/**
 * Merges one service across compose files. Following the compose-spec merge rules
 * (https://github.com/compose-spec/compose-spec/blob/main/13-merge.md), `environment` is a mapping
 * merged by variable name, which one layer per file expresses, and `env_file` is a sequence, which is
 * appended (duplicates kept). `!reset` and `!override` on either field drop what lower files set, and
 * `FOO: !reset …` removes FOO from lower files' `environment`.
 * @param models Parsed files in load order, base first.
 * @param name Service name.
 * @returns The merged service, or undefined when no file defines it.
 */
export function mergeService(models: ComposeFileModel[], name: string): MergedService | undefined {
  let found = false;
  const profiles: string[] = [];
  let envFiles: EnvFileRef[] = [];
  let environmentLayers: MergedService['environmentLayers'] = [];
  for (const model of models) {
    const fragment = model.services.find((s) => s.name === name);
    if (!fragment) {
      continue;
    }
    found = true;
    profiles.push(...fragment.profiles.filter((p) => !profiles.includes(p)));
    if (fragment.envFiles !== undefined) {
      envFiles = fragment.envFilesTag ? [...fragment.envFiles] : [...envFiles, ...fragment.envFiles];
    }
    const reset = new Set(fragment.resetVariables ?? []);
    if (reset.size > 0) {
      environmentLayers = environmentLayers.map((layer) => ({ ...layer, items: layer.items.filter((i) => !reset.has(i.name)) }));
    }
    if (fragment.environment !== undefined) {
      environmentLayers = [...(fragment.environmentTag ? [] : environmentLayers), { filePath: model.filePath, items: fragment.environment }];
    }
  }
  return found ? { name, profiles, envFiles, environmentLayers } : undefined;
}

/**
 * Lists the services across compose files.
 * @param models Parsed files in load order.
 * @returns Service names in first-seen order.
 */
export function serviceNames(models: ComposeFileModel[]): string[] {
  const names: string[] = [];
  for (const model of models) {
    names.push(...model.services.map((s) => s.name).filter((n) => !names.includes(n)));
  }
  return names;
}
