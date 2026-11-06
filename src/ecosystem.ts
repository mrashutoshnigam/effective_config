import type { ConfigProvider, ProjectInfo } from './provider';

/**
 * Everything the host needs to know about one language ecosystem: how to find its projects, how to
 * label them and how to build their {@link ConfigProvider}. Supporting a new ecosystem means adding
 * one entry to the registry; no host code changes.
 */
export interface Ecosystem {
  /** Stable kind stored in {@link ProjectInfo.kind}, e.g. `dotnet`. */
  kind: string;
  /** Short tag shown before a project name in pickers, e.g. `[.NET]`. */
  tag: string;
  /**
   * Finds the projects of this ecosystem in the workspace.
   * @param found Projects already found by the ecosystems registered before this one; an ecosystem
   * may use them to drop weaker matches (for example a fallback project inside an existing root).
   */
  discover(found: ProjectInfo[]): Promise<ProjectInfo[]>;
  /**
   * Builds the provider for a project of this ecosystem from the current settings.
   * @param project The project to read.
   */
  createProvider(project: ProjectInfo): ConfigProvider;
  /**
   * Tells whether a file name belongs to this ecosystem, used to pick the project when a file is
   * the entry point of the command and several projects share a directory.
   * @param fileName File name without directory.
   */
  ownsFileName?(fileName: string): boolean;
}

/**
 * Discovers the projects of every ecosystem. A failing discovery is reported and skipped so the
 * other ecosystems keep working.
 * @param ecosystems The registry, in discovery order.
 * @param onFailure Called with the ecosystem and the error when its discovery throws.
 * @returns All projects, sorted by name and then kind.
 */
export async function discoverProjects(
  ecosystems: readonly Ecosystem[],
  onFailure: (ecosystem: Ecosystem, error: unknown) => void = () => undefined,
): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  for (const ecosystem of ecosystems) {
    try {
      projects.push(...(await ecosystem.discover([...projects])));
    } catch (error) {
      onFailure(ecosystem, error);
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/**
 * Finds the ecosystem registered for a project kind.
 * @param ecosystems The registry.
 * @param kind Project kind.
 * @returns The ecosystem, or undefined when none is registered.
 */
export function ecosystemFor(ecosystems: readonly Ecosystem[], kind: string): Ecosystem | undefined {
  return ecosystems.find((e) => e.kind === kind);
}

/**
 * Returns the picker tag of a project.
 * @param ecosystems The registry.
 * @param project The project.
 * @returns The ecosystem tag, or `[kind]` when the kind is unknown.
 */
export function projectTag(ecosystems: readonly Ecosystem[], project: ProjectInfo): string {
  return ecosystemFor(ecosystems, project.kind)?.tag ?? `[${project.kind}]`;
}

/**
 * Builds the provider for a project.
 * @param ecosystems The registry.
 * @param project The project.
 * @returns The provider of the project's ecosystem.
 * @throws Error when no ecosystem is registered for the project's kind.
 */
export function createProvider(ecosystems: readonly Ecosystem[], project: ProjectInfo): ConfigProvider {
  const ecosystem = ecosystemFor(ecosystems, project.kind);
  if (!ecosystem) {
    throw new Error(`No ecosystem registered for project kind '${project.kind}'`);
  }
  return ecosystem.createProvider(project);
}

/**
 * Picks the project kind preferred for a file the command was invoked on.
 * @param ecosystems The registry.
 * @param fileName File name without directory.
 * @returns The kind of the first ecosystem claiming the file, else the first registered kind.
 */
export function preferredKindForFile(ecosystems: readonly Ecosystem[], fileName: string): string | undefined {
  return (ecosystems.find((e) => e.ownsFileName?.(fileName)) ?? ecosystems[0])?.kind;
}
