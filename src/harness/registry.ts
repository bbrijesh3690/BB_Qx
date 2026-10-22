// Engine ids the harness can build.

import type { EngineFactory } from '../core/contracts';
import { feedStructureFactory, FEED_STRUCTURE_ID } from '../engines/feed-structure';
import { nullEngine } from '../engines/null';
import { priceActionFactory, PRICE_ACTION_ID } from '../engines/price-action';

export const ENGINE_REGISTRY: Readonly<Record<string, EngineFactory>> = Object.freeze({
  null: nullEngine,
  [FEED_STRUCTURE_ID]: feedStructureFactory,
  [PRICE_ACTION_ID]: priceActionFactory,
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
