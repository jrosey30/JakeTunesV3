export declare const PRUNE_MAX_FRACTION: number
export declare const PRUNE_MAX_ABSOLUTE: number
export declare const PRUNE_MIN_CAP: number
export declare function planMoodPrune(
  indexIds: Iterable<number>,
  libraryIds: Iterable<number | string>,
): { prune: number[]; refused?: string; cap: number }
