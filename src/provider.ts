import type { Diagnostic, Layer } from './engine/types';

/** A discovered project the provider can build configuration for. */
export interface ProjectInfo {
  /** Stable identifier of the project. */
  id: string;
  /** Display name. */
  name: string;
  /** Absolute project directory. */
  dir: string;
  /** Absolute path of the project file (`.csproj`). */
  projectFile: string;
}

/** The profile/environment the user chose to simulate. */
export interface Selection {
  /** launchSettings profile name, when one is selected. */
  profile?: string;
  /** Environment name, e.g. `Development`. */
  environment: string;
}

/** What a provider knows about a project before a selection is made. */
export interface ProjectDescription {
  /** Available launch profiles in source order. */
  profiles: string[];
  /** Available environment names. */
  environments: string[];
  /** The selection to preselect in the UI. */
  defaultSelection: Selection;
}

/** The result of building the ordered layers for one selection. */
export interface LayerBuild {
  /** Layers from lowest to highest priority. */
  layers: Layer[];
  /** Problems and notes found while discovering and reading sources. */
  diagnostics: Diagnostic[];
  /** Absolute paths whose changes should trigger a rebuild (existing or not). */
  watchPaths: string[];
}

/** Produces configuration layers for a project; the seam between hosts and the merge engine. */
export interface ConfigProvider {
  /**
   * Describes the profiles and environments of a project.
   * @param project Project to describe.
   */
  describe(project: ProjectInfo): Promise<ProjectDescription>;
  /**
   * Builds the ordered layers for a selection.
   * @param project Project to read.
   * @param selection Profile and environment to simulate.
   */
  buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild>;
}
