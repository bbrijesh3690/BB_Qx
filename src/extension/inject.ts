// MAIN-world entry, injected at document_start in every frame of the Quotex page (manifest
// content_scripts with "world": "MAIN"). Installs the passive WebSocket tap; see tap.ts.
import { installFeedTap, type TapHost } from './tap';

try {
  installFeedTap(window as unknown as TapHost);
} catch {
  // Never let the tap break the page.
}
