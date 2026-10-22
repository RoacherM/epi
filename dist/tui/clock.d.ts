/** Now, or the held time while a block outside the tip is being drawn. */
export declare function displayNow(): number;
/** Whether the block being drawn is outside the tip, where nothing may move with the clock alone:
 * a landing shake (glyphs.ts) only plays inside it. */
export declare function clockHeld(): boolean;
/** `draw()` as a block outside the tip: displayNow() reads `at` (undefined: the real time). */
export declare function drawAt<T>(at: number | undefined, draw: () => T): T;
//# sourceMappingURL=clock.d.ts.map