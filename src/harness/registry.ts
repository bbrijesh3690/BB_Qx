// Engine ids the harness can build. The lead adds the other engines here after merge.

import type { EngineFactory } from '../core/contracts';
import { nullEngine } from '../engines/null';

export const ENGINE_REGISTRY: Readonly<Record<string, EngineFactory>> = Object.freeze({
  null: nullEngine,
});

export function engineIds(): string[] {
  return Object.keys(ENGINE_REGISTRY).sort();
}

/** Factories for the given ids, in order. Unknown ids throw with the list of known ones. */
export function engineFactories(ids: readonly string[]): EngineFactory[] {
  return ids.map((id) => {
    const f = ENGINE_REGISTRY[id];
    if (!f) throw new Error(`unknown engine '${id}'; known: ${engineIds().join(', ')}`);
    return f;
  });
}
