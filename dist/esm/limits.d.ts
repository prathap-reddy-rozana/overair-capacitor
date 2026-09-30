import type { CheckRequest } from './types';
/** `attrs`, and an event's `detail`, serialised. */
export declare const MAX_JSON_BYTES = 4096;
/**
 * The length of `value` as the server measures it: Python's `json.dumps` with
 * `separators=(',', ':')`, which is compact like `JSON.stringify` but escapes
 * every non-ASCII code unit as `\uXXXX` (six bytes). Counting a space after
 * each separator dropped `attrs` the server would have accepted.
 */
export declare function jsonSize(value: unknown): number;
/** A check the server will not refuse for its size. */
export declare function capCheck(request: CheckRequest, log: (message: string) => void): CheckRequest;
/** An event detail the server will not refuse: the message is shortened
 *  until it fits, and a detail that still does not is replaced. */
export declare function capDetail(detail: Record<string, unknown>): Record<string, unknown>;
