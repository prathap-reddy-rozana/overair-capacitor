'use strict';

var core = require('@capacitor/core');

/**
 * The delivery plane: two endpoints, one credential.
 *
 * Plain `fetch` rather than CapacitorHttp - the payloads are small, and the
 * webview's own stack handles redirects and TLS the way the platform
 * expects. Bytes never come through here; the native side fetches those.
 */
class DeliveryApi {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    /** Never throws on a refusal: every outcome, including every "no", is a
     *  200 with a reason. A throw here means the network failed. */
    async check(report) {
        const res = await fetch(this.url('/v1/check'), {
            method: 'POST', headers: this.headers(), body: JSON.stringify(report),
        });
        if (!res.ok)
            throw new Error(`check failed: ${res.status}`);
        return (await res.json());
    }
    /** Batched, so a weak connection spends one request on a whole session. */
    async report(events) {
        if (!events.length)
            return;
        const res = await fetch(this.url('/v1/events'), {
            method: 'POST', headers: this.headers(), body: JSON.stringify({ events }),
        });
        if (!res.ok)
            throw new Error(`events failed: ${res.status}`);
    }
    url(path) {
        return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    }
    headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
    }
}

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
const MAX_JSON_BYTES = 4096;
/** Where a trimmed `detail` stops: under the cap with room to spare. */
const DETAIL_TARGET = 4000;
/**
 * The length of `value` as the server measures it: Python's `json.dumps` with
 * `separators=(',', ':')`, which is compact like `JSON.stringify` but escapes
 * every non-ASCII code unit as `\uXXXX` (six bytes). Counting a space after
 * each separator dropped `attrs` the server would have accepted.
 */
function jsonSize(value) {
    const json = JSON.stringify(value) ?? '';
    let size = 0;
    for (let i = 0; i < json.length; i += 1)
        size += json.charCodeAt(i) > 0x7f ? 6 : 1;
    return size;
}
/** A check the server will not refuse for its size. */
function capCheck(request, log) {
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
function capDetail(detail) {
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

/** The native plugin. Use it directly for status and manual control; most
 *  apps want `Updater` below instead. */
const Overair = core.registerPlugin('Overair', {
    web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.OverairWeb()),
});
/**
 * Is this update too big to take without asking?
 *
 * The ceiling is the DEVICE's call because it is the only thing that knows it
 * is on somebody's data plan. Two things override it: `mandatory`, because a
 * build that is actively broken is worth the megabytes; and the user having
 * already accepted this exact bundle, because re-asking after a failed
 * download is how a retry button comes to do nothing at all.
 *
 * Keyed on the bundle id rather than a flag: agreeing to one large update is
 * not agreeing to the next one.
 */
function shouldDefer(update, acceptedId, stoppedId = null) {
    if (update.mandatory)
        return false;
    if (update.bundle_id === acceptedId)
        return false;
    // Stopped by the person: whatever its size, it waits to be asked for again.
    if (update.bundle_id === stoppedId)
        return true;
    return update.auto_max_bytes > 0 && update.size > update.auto_max_bytes;
}
/** A time the server can read, or null. Anything else is dropped here rather
 *  than sent: the value is baked into the binary. */
function embeddedTime(value) {
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
}
/** Where the app's identity waits between launches. Web storage, so this ships
 *  with the bundle and reaches installed apps without a store release. */
const IDENTITY_KEY = 'overair.identity';
function storedIdentity() {
    try {
        const raw = globalThis.localStorage?.getItem(IDENTITY_KEY);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
const NO_ANSWER = {
    reason: 'CHECKED', staged: false, deferred: null, reverted: false, update: null,
};
const DEFAULT_RESUME_GAP_MINUTES = 5;
/** After a check that got no answer, the next resume may ask this soon. */
const RESUME_RETRY_MS = 60_000;
const MOVING = ['DOWNLOADING', 'VERIFYING', 'UNPACKING'];
/** How many pre-endpoint events to hold. One launch raises at most a couple;
 *  the cap only matters for a build that never syncs at all. */
const QUEUED_EVENT_LIMIT = 20;
/** Longest failure message reported. The server's cap is in bytes, and
 *  `capDetail` is what keeps a non-ASCII message under it. */
const MAX_MESSAGE = 1000;
/** How long a report may hold up a rollback or reset. */
const REPORT_BEFORE_RELOAD_MS = 3000;
/** Wait for `work`, but never past `ms`: a dead network must not be why a
 *  broken bundle stays on screen. */
function bounded(work, ms) {
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([work.then(() => undefined, () => undefined), limit])
        .finally(() => clearTimeout(timer));
}
/** Native's refusal of a second concurrent download, word for word. */
const ALREADY_RUNNING = 'a download is already running';
/**
 * The protocol half of the SDK.
 *
 * Native decides what runs and owns the bytes; this decides what to ask for.
 * Keeping them apart is why the boot decision can happen before any of this
 * code exists.
 */
class Updater {
    api = null;
    options = {};
    inFlight = null;
    /** The last manifest held back by the size ceiling, for `accept`. */
    deferred = null;
    /** The bundle the user has already said yes to. Per bundle id, not a flag:
     *  agreeing to one large update is not agreeing to the next one. */
    acceptedId = null;
    /** The bundle the person stopped, deferred until they accept it. Without it
     *  a bundle under the ceiling was downloaded again by the next check. */
    stoppedId = null;
    /**
     * Events raised before an endpoint was known.
     *
     * `this.api?.report(...)` once made these a silent no-op, which left
     * `ready` at zero for every real fleet while `pause_below_ready_bps` was
     * reading exactly that number. READY itself now waits in `confirmed`, so
     * it can be acknowledged once the server has it; this holds the rest.
     */
    queued = [];
    /** The rollback already sent, so notifyReady and sync never both send it. */
    rollbackReported = null;
    /** The bundle this launch confirmed, until the server has its READY. */
    confirmed = null;
    /** Every sync's answer goes here, whoever asked - the app, or a resume. */
    listeners = new Set();
    resumeListener = null;
    /** When a resume may check again. */
    resumeAt = 0;
    /** Its OWN guard, not `inFlight`. Joining a check would resolve with that
     *  check's answer - deferred - and the tap would look like it did nothing. */
    accepting = null;
    /**
     * Ask the server, and act on the answer.
     *
     * Safe to call whenever - launch, resume, a button. A second call while
     * one is running joins the first rather than starting a second download.
     */
    async sync(options = {}) {
        this.options = { ...this.options, ...options };
        this.listenForResume();
        if (this.inFlight)
            return this.inFlight;
        this.inFlight = this.run()
            .then((result) => this.answered(result), (error) => {
            // Failed before it could ask: no answer, so the same one-minute wait.
            this.answered({ ...NO_ANSWER });
            throw error;
        })
            .finally(() => { this.inFlight = null; });
        return this.inFlight;
    }
    /**
     * Who is using the app, sent with every check until it changes - including
     * the first check of the next launch, which runs before the app knows who
     * is signed in. `null` forgets it. The `customId` and `attrs` options still
     * win when the app sets them.
     */
    setIdentity(identity) {
        try {
            if (identity) {
                globalThis.localStorage?.setItem(IDENTITY_KEY, JSON.stringify({
                    customId: identity.customId ?? '', attrs: identity.attrs ?? {},
                }));
            }
            else {
                globalThis.localStorage?.removeItem(IDENTITY_KEY);
            }
        }
        catch (error) {
            // Storage refused (private mode, quota): the check goes out anonymous.
            this.log(`identity not stored: ${error.message}`);
        }
    }
    /** Change options without checking - e.g. switching resume checks off
     *  from remote config. */
    configure(options) {
        this.options = { ...this.options, ...options };
    }
    /** Every sync's result, whoever started it - resume checks find updates too.
     *  Returns a function that unsubscribes. */
    onResult(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    answered(result) {
        // CHECKED is the answer to a check that got none (offline, no endpoint).
        const gap = this.options.resumeGapMinutes ?? DEFAULT_RESUME_GAP_MINUTES;
        this.resumeAt = Date.now() + (result.reason === 'CHECKED' ? RESUME_RETRY_MS : gap * 60_000);
        for (const listener of this.listeners) {
            try {
                listener(result);
            }
            catch {
                // One listener's bug is not every other listener's problem.
            }
        }
        return result;
    }
    /** Once, from the first sync: before that there are no options to check with. */
    listenForResume() {
        if (this.resumeListener)
            return;
        try {
            this.resumeListener = Overair.addListener('resume', () => { void this.resumed(); })
                .catch(() => null);
        }
        catch {
            // A plugin without events (web, a mock): checks still work, just not on resume.
            this.resumeListener = Promise.resolve(null);
        }
    }
    async resumed() {
        if (this.options.checkOnResume === false || Date.now() < this.resumeAt)
            return;
        try {
            // Never over a download in progress: it would be offered the same bundle.
            const { download } = await Overair.status();
            if (MOVING.includes(download.state))
                return;
        }
        catch {
            return;
        }
        this.log('back in the foreground; checking');
        try {
            await this.sync();
        }
        catch {
            // A resume must never surface an error; the next one asks again.
        }
    }
    /**
     * Tell the platform this bundle started.
     *
     * An app that never calls this is treated as never having booted: the next
     * launch rolls back before the webview loads. Call it after the first
     * meaningful render, not in a constructor - the point is to prove the app
     * actually works, not that a file parsed.
     */
    async notifyReady() {
        await Overair.notifyReady();
        const status = await Overair.status();
        await this.reportRollback(status);
        this.confirmed = status.current?.id ?? null;
        await this.reportReady(status);
    }
    /**
     * READY once per install per bundle, not once per launch: the server keeps
     * every one, and a device that launches ten times a day counted ten times
     * in the health gate. Held until the endpoint is known, and acknowledged
     * only once the server has it, so an offline launch sends it later.
     */
    async reportReady(status) {
        const id = this.confirmed;
        if (!id || !this.api)
            return;
        if (id === status.readyReportedId) {
            this.confirmed = null;
            return;
        }
        if (!(await this.emit('READY', id)))
            return;
        this.confirmed = null;
        try {
            await Overair.acknowledgeReady({ id });
        }
        catch {
            // At worst the next launch sends it once more.
        }
    }
    /**
     * A rollback happens natively, before any JavaScript exists to see it.
     * Acknowledged only once the server has the report: cleared on a queued
     * one, an offline first launch lost it for good. Until then it stays set,
     * so the next sync, or the next launch, sends it again.
     */
    async reportRollback(status) {
        const id = status.rolledBack ? status.rolledBackId : null;
        if (!id || id === this.rollbackReported || !this.api)
            return;
        this.log(`rolled back ${id} before boot`);
        if (!(await this.emit('FAILED', id, 'boot_failed')))
            return;
        this.rollbackReported = id;
        try {
            await Overair.acknowledgeRollback();
        }
        catch {
            // Never why an app fails to start; the guard above stops a resend.
        }
    }
    /** What the webview is serving, or null on the build in the binary. */
    async current() {
        return (await Overair.status()).current;
    }
    /**
     * Bytes as they arrive, throttled natively to about ten a second.
     *
     * The handle survives nothing: a bundle swap reloads the web layer and
     * every listener with it. That is why the authoritative state is
     * `status().download` and this is only the live feed.
     */
    async onProgress(listener) {
        return Overair.addListener('downloadProgress', listener);
    }
    /** Every state change, including the terminal ones. `failure` is set only
     *  on FAILED, and carries whether retrying is worth it. */
    async onStateChange(listener) {
        return Overair.addListener('downloadStateChanged', listener);
    }
    /**
     * Serve the staged bundle now, reloading the webview into it.
     *
     * Nothing runs after this: the page that called it is replaced. Confirm
     * with the user first, because anything unsaved on screen goes with it.
     */
    async applyNow() {
        await Overair.applyNow();
    }
    /** Stop the download in flight. Safe when there is not one. */
    async cancel() {
        await Overair.cancel();
    }
    /**
     * Take an update that `sync` deferred.
     *
     * The ceiling in `auto_max_bytes` is a decision to ASK, not a refusal, so
     * something has to be able to say yes. Without this the deferred manifest
     * is a fact the app can display and nothing more.
     *
     * A fresh check comes first, for the reason `retry` gives: the deferred
     * manifest's URL is presigned and can expire while the card sits on screen.
     * The server may also have paused the release or moved on since; its
     * current answer wins, and only offline does the held link get used.
     */
    async accept(update) {
        const manifest = update ?? this.deferred;
        if (!manifest)
            throw new Error('nothing deferred to accept');
        // A second tap joins the first rather than starting a download native
        // would refuse - that refusal used to be reported as a release failing on
        // a handset when nothing had.
        if (this.accepting)
            return this.accepting;
        // Remembered BEFORE the check, so the ceiling does not defer the very
        // bundle this call is agreeing to (and `retry` can take it later).
        this.acceptedId = manifest.bundle_id;
        this.stoppedId = null;
        this.accepting = (async () => {
            // A check already running started before the consent; its answer is
            // "deferred", so wait it out and ask again.
            if (this.inFlight)
                await this.inFlight.catch(() => undefined);
            const fresh = await this.sync();
            if (fresh.reason !== 'CHECKED')
                return fresh;
            const identity = await Overair.identity();
            // Listeners hear this too: an offline accept can still stage.
            return this.answered(await this.stage(manifest, 'OFFERED', identity.installId));
        })().finally(() => { this.accepting = null; });
        return this.accepting;
    }
    /**
     * Try again after a failed download.
     *
     * Deliberately a fresh check rather than a replay of the attempt that
     * failed. The download URL is PRESIGNED and short-lived: replaying it
     * re-uses a link that may already have expired, or that points at an
     * object the server has since moved - a button that cannot work however
     * many times it is pressed. One small request buys a URL that can.
     *
     * `retryable` is still honoured: a digest mismatch means the bytes on the
     * server are wrong, and a fresh link fetches the same wrong bytes.
     */
    async retry() {
        const { download } = await Overair.status();
        if (download.failure && !download.failure.retryable) {
            throw new Error(`not retryable: ${download.failure.message}`);
        }
        return this.sync();
    }
    /** Where the current or most recent download got to. Unlike a listener,
     *  this survives the web reload a bundle swap causes. */
    async downloadStatus() {
        return (await Overair.status()).download;
    }
    /**
     * Step back one bundle after a failure the app detected itself.
     *
     * The boot watchdog only catches a bundle that never starts. This is for
     * the one that starts and is then obviously broken - and it costs the user
     * the bad update rather than every update they have ever taken.
     */
    async rollback() {
        const status = await Overair.status();
        // Nothing to report: native refuses, as it always has.
        if (!status.current)
            return Overair.rollback();
        const failed = status.current.id;
        // Sent FIRST. Native reloads the webview as it resolves, and events
        // raised after it went down with this JavaScript context.
        await bounded((async () => {
            await this.emit('FAILED', failed, 'app_reported');
            // No bundle: the server quarantines the bundle an event names, and the
            // previous one is where this device is going, not what failed.
            await this.emit('REVERTED');
        })(), REPORT_BEFORE_RELOAD_MS);
        return Overair.rollback();
    }
    /** Back to the build compiled into the binary, forgetting the rest. */
    async reset() {
        // Before, for the reason rollback() gives.
        await bounded(this.emit('REVERTED'), REPORT_BEFORE_RELOAD_MS);
        await Overair.reset();
    }
    async run() {
        const idle = {
            reason: 'CHECKED', staged: false, deferred: null, reverted: false, update: null,
        };
        const identity = await Overair.identity();
        const apiUrl = this.options.apiUrl ?? identity.apiUrl;
        const apiKey = this.options.apiKey ?? identity.apiKey;
        if (!apiUrl || !apiKey) {
            this.log('no apiUrl/apiKey in capacitor.config or options; nothing to do');
            return idle;
        }
        this.api = new DeliveryApi(apiUrl, apiKey);
        await this.flushQueued();
        const status = await Overair.status();
        await this.reportRollback(status);
        await this.reportReady(status);
        const remembered = storedIdentity();
        let response;
        try {
            // Capped here: over any server limit the whole check is refused, and a
            // refused check reads as offline, forever.
            response = await this.api.check(capCheck({
                install_id: identity.installId,
                platform: core.Capacitor.getPlatform(),
                runtime: this.options.runtime || identity.runtime,
                channel: this.options.channel || identity.channel,
                app_version: identity.appVersion,
                build_number: identity.nativeBuild,
                os_version: identity.osVersion ?? '',
                locale: typeof navigator !== 'undefined' ? navigator.language : '',
                custom_id: this.options.customId ?? remembered?.customId ?? '',
                attrs: this.options.attrs ?? remembered?.attrs ?? {},
                current_bundle: status.current?.id ?? '',
                embedded_at: embeddedTime(this.options.embeddedAt || identity.embeddedAt),
                quarantined: status.quarantined,
            }, (message) => this.log(message)));
        }
        catch (error) {
            // Offline is the normal case, not an error worth surfacing: the app
            // runs on what it has and asks again next time.
            this.log(`check failed: ${error.message}`);
            return idle;
        }
        this.log(`check -> ${response.reason}`);
        if (response.revert) {
            await bounded(this.emit('REVERTED'), REPORT_BEFORE_RELOAD_MS);
            await Overair.reset();
            return {
                reason: response.reason, staged: false, deferred: null, reverted: true, update: null,
            };
        }
        const update = response.update;
        this.deferred = null;
        if (!update)
            return { ...idle, reason: response.reason };
        if (shouldDefer(update, this.acceptedId, this.stoppedId)) {
            this.log(`deferred ${update.version}: ${update.size} over ${update.auto_max_bytes}`);
            this.deferred = update;
            return {
                reason: response.reason, staged: false, deferred: update, reverted: false, update,
            };
        }
        // Already on disk and waiting for the next launch. The server keeps
        // OFFERING it until this device reports it as current, which only
        // happens after notifyReady - so without this check every launch in
        // between re-downloads a bundle we already have.
        if (status.next?.id === update.bundle_id) {
            this.log(`${update.version} is already staged; not downloading again`);
            return {
                reason: response.reason, staged: true, deferred: null, reverted: false, update,
            };
        }
        return this.stage(update, response.reason, identity.installId);
    }
    async stage(update, reason, installId) {
        await this.emit('DOWNLOAD_STARTED', update.bundle_id);
        try {
            const downloaded = await Overair.download({
                id: update.bundle_id,
                version: update.version,
                url: update.url,
                checksum: update.sha256,
            });
            await this.emit('DOWNLOADED', update.bundle_id);
            // Named in full: with only the id, every record read version "" and a
            // rollback reported it had gone back to "".
            await Overair.next({
                id: update.bundle_id,
                version: update.version,
                checksum: update.sha256,
                size: downloaded?.size ?? update.size,
            });
            await this.emit('APPLIED', update.bundle_id);
            this.log(`staged ${update.version}; it runs on the next launch`);
            this.deferred = null;
            this.acceptedId = null;
            return { reason, staged: true, deferred: null, reverted: false, update };
        }
        catch (error) {
            const message = error.message;
            // First: native refused before touching its failure record, so what
            // that record says belongs to an earlier attempt.
            if (message.includes(ALREADY_RUNNING)) {
                // Another download holds native; this one never started.
                this.log(`${update.version} not started: ${message}`);
                return { reason, staged: false, deferred: null, reverted: false, update };
            }
            const code = await this.failureCode(update.bundle_id);
            if (code === 'cancelled') {
                // The person said stop. Not a failure of the release: reported as
                // one, three taps on Stop quarantined it server-side. The consent is
                // spent, and the manifest is offered back so they can say yes again.
                this.log(`${update.version} cancelled`);
                this.acceptedId = null;
                this.stoppedId = update.bundle_id;
                this.deferred = update;
                return { reason, staged: false, deferred: update, reverted: false, update };
            }
            this.log(`staging failed: ${message}`);
            const detail = { message: message.slice(0, MAX_MESSAGE), installId };
            if (code === 'unpack' || code === 'digest') {
                // The same URL gives the same bytes: a digest mismatch or an archive
                // that cannot run here. Refused on this device and on the server.
                try {
                    await Overair.quarantine({ id: update.bundle_id });
                }
                catch {
                    // The server's quarantine still stops the offer.
                }
                await this.emit('FAILED', update.bundle_id, 'bad_bundle', detail);
            }
            else {
                // NOT quarantined: a download or disk failure, not a bundle that
                // cannot run. Refusing it forever would refuse bytes never tried.
                await this.emit('FAILED', update.bundle_id, 'stage_failed', detail);
            }
            return { reason, staged: false, deferred: null, reverted: false, update };
        }
    }
    /** Why native says this bundle's download ended, or null when it has not
     *  recorded a failure for it. */
    async failureCode(id) {
        try {
            const { failure } = (await Overair.status()).download;
            return failure?.id === id ? failure.code : null;
        }
        catch {
            return null;
        }
    }
    /** Telemetry never makes a device wait, and a failed report must never
     *  fail the update it was describing. */
    /** True once the server has the event; false when held or dropped. */
    async emit(type, bundle, errorCode, detail) {
        try {
            const { installId } = await Overair.identity();
            const event = {
                install_id: installId,
                type,
                bundle: bundle ?? '',
                error_code: errorCode ?? '',
                detail: capDetail(detail ?? {}),
            };
            if (!this.api) {
                // Held, not dropped. Bounded, because a build with OTA switched off
                // never syncs and this would otherwise grow for the life of the app.
                if (this.queued.length < QUEUED_EVENT_LIMIT)
                    this.queued.push(event);
                return false;
            }
            await this.api.report([event]);
            return true;
        }
        catch {
            // Dropped on purpose. The console being blind for one event is a
            // smaller problem than an update failing because reporting did.
            return false;
        }
    }
    /** Send whatever was raised before the endpoint was known. Same bargain as
     *  `emit`: reporting must never be why an update fails. */
    async flushQueued() {
        if (!this.api || this.queued.length === 0)
            return;
        const pending = this.queued;
        this.queued = [];
        try {
            await this.api.report(pending);
        }
        catch {
            // Same as emit.
        }
    }
    log(message) {
        if (this.options.debug)
            console.log(`[overair] ${message}`);
    }
}
/** One instance: two of these racing would be two answers to a question
 *  that has one, and both would download. */
const OverairUpdater = new Updater();

/**
 * The web implementation, which deliberately does nothing.
 *
 * There is no over-the-air update in a browser: the page IS the latest
 * version, reloaded from the server every time. Every method resolves to an
 * empty, honest answer so a shared codebase can call the SDK during `ng
 * serve` without branching on the platform - and none of them pretends to
 * have applied anything.
 */
class OverairWeb extends core.WebPlugin {
    async status() {
        return {
            current: null, next: null, previous: null, quarantined: [],
            rolledBack: false, rolledBackId: null, readyReportedId: null,
            download: this.idle(),
        };
    }
    idle() {
        return { id: '', state: 'IDLE', bytes: 0, total: 0, fraction: -1, failure: null };
    }
    async acknowledgeRollback() {
        return;
    }
    async acknowledgeReady(_options) {
        return;
    }
    async identity() {
        return {
            installId: 'web',
            channel: '',
            runtime: '',
            nativeBuild: '',
            embeddedAt: '',
            appVersion: '',
            osVersion: '',
            apiUrl: '',
            apiKey: '',
        };
    }
    async download(_options) {
        throw this.unavailable('Bundles are only downloaded on a device.');
    }
    async next(_options) {
        throw this.unavailable('Bundles are only applied on a device.');
    }
    async applyNow() {
        throw this.unavailable('Bundles are only applied on a device.');
    }
    async cancel() {
        return;
    }
    async retry() {
        throw this.unavailable('Bundles are only downloaded on a device.');
    }
    /** The one method that succeeds on web: an app that calls it on every
     *  platform should not have to guard the call. */
    async notifyReady() {
        return;
    }
    async quarantine(_options) {
        return;
    }
    async rollback() {
        return { rolledBackTo: 'embedded' };
    }
    async reset() {
        return;
    }
    async prune() {
        return;
    }
}

var web = /*#__PURE__*/Object.freeze({
    __proto__: null,
    OverairWeb: OverairWeb
});

exports.Overair = Overair;
exports.OverairUpdater = OverairUpdater;
exports.embeddedTime = embeddedTime;
exports.shouldDefer = shouldDefer;
//# sourceMappingURL=plugin.cjs.js.map
