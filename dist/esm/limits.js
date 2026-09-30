/**
 * The server's caps on what a device sends, applied before it is sent.
 *
 * Over any of them the server refuses the WHOLE request with a 400, and a
 * check that fails reads as offline - so one oversized attribute switched
 * updates off for that device for good, and nothing said so.
 */
/** Longest value the server accepts for each string field of a check. */
const FIELD_LIMITS = {
    runtime: 80,
    channel: 80,
    app_version: 80,
    build_number: 40,
    os_version: 40,
    locale: 20,
    custom_id: 200,
};
/** `attrs`, and an event's `detail`, serialised. */
export const MAX_JSON_BYTES = 4096;
/** Where a trimmed `detail` stops: under the cap with room to spare. */
const DETAIL_TARGET = 4000;
/**
 * The length of `value` as the server measures it: Python's `json.dumps` with
 * `separators=(',', ':')`, which is compact like `JSON.stringify` but escapes
 * every non-ASCII code unit as `\uXXXX` (six bytes). Counting a space after
 * each separator dropped `attrs` the server would have accepted.
 */
export function jsonSize(value) {
    const json = JSON.stringify(value) ?? '';
    let size = 0;
    for (let i = 0; i < json.length; i += 1)
        size += json.charCodeAt(i) > 0x7f ? 6 : 1;
    return size;
}
/** A check the server will not refuse for its size. */
export function capCheck(request, log) {
    const capped = { ...request };
    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
        const key = field;
        const value = capped[key];
        if (typeof value === 'string' && value.length > limit) {
            log(`${key} is ${value.length} characters; sending the first ${limit}`);
            capped[key] = value.slice(0, limit);
        }
    }
    // Dropped whole: a truncated attribute set would target on half the facts.
    if (capped.attrs && jsonSize(capped.attrs) > MAX_JSON_BYTES) {
        log(`attrs is ${jsonSize(capped.attrs)} bytes, over ${MAX_JSON_BYTES}; sending none`);
        capped.attrs = {};
    }
    return capped;
}
/** An event detail the server will not refuse: the message is shortened
 *  until it fits, and a detail that still does not is replaced. */
export function capDetail(detail) {
    if (jsonSize(detail) <= DETAIL_TARGET)
        return detail;
    const message = typeof detail['message'] === 'string' ? detail['message'] : null;
    if (message !== null) {
        let low = 0;
        let high = message.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (jsonSize({ ...detail, message: message.slice(0, mid) }) <= DETAIL_TARGET)
                low = mid;
            else
                high = mid - 1;
        }
        const trimmed = { ...detail, message: message.slice(0, low) };
        if (jsonSize(trimmed) <= DETAIL_TARGET)
            return trimmed;
    }
    return { truncated: true };
}
