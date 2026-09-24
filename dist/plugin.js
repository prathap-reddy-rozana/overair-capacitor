var capacitorOverair = (function (exports, core) {
    'use strict';

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
    function shouldDefer(update, acceptedId) {
        if (update.mandatory)
            return false;
        if (update.bundle_id === acceptedId)
            return false;
        return update.auto_max_bytes > 0 && update.size > update.auto_max_bytes;
    }
    /** A time the server can read, or null. Anything else is dropped here rather
     *  than sent: the value is baked into the binary. */
    function embeddedTime(value) {
        return value && !Number.isNaN(Date.parse(value)) ? value : null;
    }
    /** How many pre-endpoint events to hold. One launch raises at most a couple;
     *  the cap only matters for a build that never syncs at all. */
    const QUEUED_EVENT_LIMIT = 20;
    /** Longest failure message reported; keeps an event under the server's cap. */
    const MAX_MESSAGE = 1000;
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
        /**
         * Events raised before an endpoint was known.
         *
         * `notifyReady` runs BEFORE the first sync on purpose - the watchdog has to
         * be satisfied before a check can overtake it - so the READY it emits has
         * nowhere to go yet. `this.api?.report(...)` turned that into a silent
         * no-op, which left `ready` at zero for every real fleet while
         * `pause_below_ready_bps` was reading exactly that number.
         */
        queued = [];
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
            if (this.inFlight)
                return this.inFlight;
            this.inFlight = this.run().finally(() => { this.inFlight = null; });
            return this.inFlight;
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
            if (status.current)
                await this.emit('READY', status.current.id);
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
            this.accepting = (async () => {
                // A check already running started before the consent; its answer is
                // "deferred", so wait it out and ask again.
                if (this.inFlight)
                    await this.inFlight.catch(() => undefined);
                const fresh = await this.sync();
                if (fresh.reason !== 'CHECKED')
                    return fresh;
                const identity = await Overair.identity();
                return this.stage(manifest, 'OFFERED', identity.installId);
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
            const result = await Overair.rollback();
            if (status.current)
                await this.emit('FAILED', status.current.id, 'app_reported');
            await this.emit('REVERTED', status.previous?.id);
            return result;
        }
        /** Back to the build compiled into the binary, forgetting the rest. */
        async reset() {
            await Overair.reset();
            await this.emit('REVERTED');
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
            // A rollback happens natively, before any JavaScript exists to see it.
            // This is the first moment it can be reported, and reporting it is the
            // difference between a console that shows a failed release and one that
            // shows a release nobody ever took.
            if (status.rolledBack && status.rolledBackId) {
                this.log(`rolled back ${status.rolledBackId} before boot`);
                await this.emit('FAILED', status.rolledBackId, 'boot_failed');
            }
            let response;
            try {
                response = await this.api.check({
                    install_id: identity.installId,
                    platform: core.Capacitor.getPlatform(),
                    runtime: this.options.runtime || identity.runtime,
                    channel: this.options.channel || identity.channel,
                    app_version: identity.appVersion,
                    build_number: identity.nativeBuild,
                    os_version: '',
                    locale: typeof navigator !== 'undefined' ? navigator.language : '',
                    custom_id: this.options.customId ?? '',
                    attrs: this.options.attrs ?? {},
                    current_bundle: status.current?.id ?? '',
                    embedded_at: embeddedTime(this.options.embeddedAt || identity.embeddedAt),
                    quarantined: status.quarantined,
                });
            }
            catch (error) {
                // Offline is the normal case, not an error worth surfacing: the app
                // runs on what it has and asks again next time.
                this.log(`check failed: ${error.message}`);
                return idle;
            }
            this.log(`check -> ${response.reason}`);
            if (response.revert) {
                await Overair.reset();
                await this.emit('REVERTED');
                return {
                    reason: response.reason, staged: false, deferred: null, reverted: true, update: null,
                };
            }
            const update = response.update;
            this.deferred = null;
            if (!update)
                return { ...idle, reason: response.reason };
            if (shouldDefer(update, this.acceptedId)) {
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
                await Overair.download({
                    id: update.bundle_id,
                    version: update.version,
                    url: update.url,
                    checksum: update.sha256,
                });
                await this.emit('DOWNLOADED', update.bundle_id);
                await Overair.next({ id: update.bundle_id });
                await this.emit('APPLIED', update.bundle_id);
                this.log(`staged ${update.version}; it runs on the next launch`);
                this.deferred = null;
                this.acceptedId = null;
                return { reason, staged: true, deferred: null, reverted: false, update };
            }
            catch (error) {
                const message = error.message;
                this.log(`staging failed: ${message}`);
                // NOT quarantined: this is a download or disk failure, not a bundle
                // that cannot run. Refusing it forever would refuse bytes never tried.
                // Capped: the server refuses an event whose detail is over 4 KB.
                await this.emit('FAILED', update.bundle_id, 'stage_failed', { message: message.slice(0, MAX_MESSAGE), installId });
                return { reason, staged: false, deferred: null, reverted: false, update };
            }
        }
        /** Telemetry never makes a device wait, and a failed report must never
         *  fail the update it was describing. */
        async emit(type, bundle, errorCode, detail) {
            try {
                const { installId } = await Overair.identity();
                const event = {
                    install_id: installId,
                    type,
                    bundle: bundle ?? '',
                    error_code: errorCode ?? '',
                    detail: detail ?? {},
                };
                if (!this.api) {
                    // Held, not dropped. Bounded, because a build with OTA switched off
                    // never syncs and this would otherwise grow for the life of the app.
                    if (this.queued.length < QUEUED_EVENT_LIMIT)
                        this.queued.push(event);
                    return;
                }
                await this.api.report([event]);
            }
            catch {
                // Dropped on purpose. The console being blind for one event is a
                // smaller problem than an update failing because reporting did.
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
                rolledBack: false, rolledBackId: null,
                download: this.idle(),
            };
        }
        idle() {
            return { id: '', state: 'IDLE', bytes: 0, total: 0, fraction: -1, failure: null };
        }
        async identity() {
            return {
                installId: 'web',
                channel: '',
                runtime: '',
                nativeBuild: '',
                embeddedAt: '',
                appVersion: '',
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

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map
