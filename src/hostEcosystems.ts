import { DOTNET_ECOSYSTEM } from './dotnet/ecosystem';
import type { Ecosystem } from './ecosystem';
import { PYTHON_ECOSYSTEM } from './python/ecosystem';

/**
 * The ecosystems this extension supports, in discovery order. The first entry is also the default
 * for files no ecosystem claims. Add a new ecosystem here; its code lives in its own folder.
 */
export const ECOSYSTEMS: readonly Ecosystem[] = [DOTNET_ECOSYSTEM, PYTHON_ECOSYSTEM];
