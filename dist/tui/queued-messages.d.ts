import type { ImageContent } from "@earendil-works/pi-ai";
/** Pairs each of `texts` with the first not-yet-claimed `peeked` message whose own text content
 * equals it (see queuedMessageText), consuming that message so two identical queued texts don't
 * both draw images from the same one. */
export declare function imagesFor(texts: readonly string[], peeked: readonly unknown[]): ImageContent[][];
//# sourceMappingURL=queued-messages.d.ts.map