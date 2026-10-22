import 'fake-indexeddb/auto';
import { ledgerConformance } from './conformance';
import { openIndexedDbLedger } from './indexeddb';

// The Ledger API promises two behaviourally identical implementations; this runs the same suite
// the in-memory ledger passes against the IndexedDB one.
let dbCounter = 0;
ledgerConformance('indexeddb', async () => openIndexedDbLedger(`bbqx-conformance-${++dbCounter}`));
