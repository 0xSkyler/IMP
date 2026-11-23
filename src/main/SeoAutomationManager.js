"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeoAutomationManager = void 0;
const node_events_1 = require("node:events");
const automation_1 = require("../shared/types/automation");
const browser_1 = require("../shared/types/browser");
const seo_1 = require("../shared/seo");
const ProxyManager_1 = require("./ProxyManager");
const ProxyTiers_1 = require("../proxy/ProxyTiers");
const Logger_1 = require("./Logger");
const { cancellableDelay, waitForPreparation } = require("./runtime");
const DEFAULT_PROXY_SOURCE = (0, ProxyManager_1.resolveProxySource)();
function createCycleController() {
    const controller = new AbortController();
    // One sleeping monitor per existing workspace is expected, not a leak.
    // Keep this allowance local and finite; Stop/rotation still detach all of
    // these listeners synchronously through cancellableDelay.
    node_events_1.setMaxListeners(browser_1.BROWSER_IDS.length, controller.signal);
    return controller;
}
/**
 * Single-purpose SEO Tracker orchestration:
 *
 * User-selected proxy API -> direct exclusive assignment
 * -> continuous Google monitoring -> challenge pause/resume
 * -> exact-host result click -> repeating same-host Keep Alive
 * -> rotate and restart on the user-configured cadence.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class SeoAutomationManager extends node_events_1.EventEmitter {
    proxyManager;
    browserManager;
    ensureBrowserCount;
    timer = null;
    generation = 0;
    pendingCycle = false;
    cycleController = createCycleController();
    activeSessions = new Map();
    repairingBrowsers = new Map();
    failedProxyEndpoints = new Map();
    failedProxyTimes = new Map();
    proxyFetchQueue = Promise.resolve();
    lastCleanupScheduledThroughCycle = 0;
    pendingBrowserCleanup = new Set();
    pendingLogCleanup = false;
    state = {
        running: false,
        cycleInProgress: false,
        preparingBrowsers: false,
        preparedBrowsers: 0,
        proxySource: DEFAULT_PROXY_SOURCE.id,
        proxySourceLabel: DEFAULT_PROXY_SOURCE.label,
        proxyApiUrl: DEFAULT_PROXY_SOURCE.endpoint,
        proxyTier: null, // Legacy direct API callers without the UI remain unchanged.
        searchEngine: 'google',
        query: '',
        targetWebsite: '',
        intervalSec: 600,
        browserCount: 10,
        maxPages: 20,
        browserIds: [],
        cycleNumber: 0,
        fetchedProxies: 0,
        checkedProxies: 0,
        totalProxies: 0,
        liveProxies: 0,
        assignedBrowsers: 0,
        retainedBrowsers: 0,
        replacedBrowsers: 0
    };
    constructor(proxyManager, browserManager, ensureBrowserCount) {
        super();
        this.proxyManager = proxyManager;
        this.browserManager = browserManager;
        this.ensureBrowserCount = ensureBrowserCount;
        // A failed connection, proxy error, CAPTCHA or renderer crash is repaired
        // without restarting healthy browsers or waiting for the next cycle.
        this.browserManager.on?.('stateChanged', (state) => {
            if (!this.state.running || !state?.proxy ||
                (state.connectionStatus !== 'proxy-failed' && state.connectionStatus !== 'crashed')) return;
            const session = this.activeSessions.get(state.id);
            if (session && this.sessionActive(session))
                void this.repairFailedProxy(session, state.errorMessage || state.connectionStatus);
        });
    }
    getState() {
        return { ...this.state, browserIds: [...this.state.browserIds] };
    }
    isRunning() {
        return this.state.running;
    }
    configureProxy(config) {
        if (this.state.running)
            throw new Error('Stop SEO Tracker before changing the proxy source.');
        const source = (0, ProxyManager_1.resolveProxySource)(config?.source, config?.endpoint);
        const searchEngine = (0, seo_1.normalizeSearchEngine)(config?.searchEngine ?? this.state.searchEngine);
        const requestedTier = config?.tier ?? this.state.proxyTier;
        const tier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        this.state = {
            ...this.state,
            proxySource: source.id,
            proxySourceLabel: source.label,
            proxyApiUrl: source.endpoint,
            proxyTier: tier,
            searchEngine
        };
        this.emitState();
        return this.getState();
    }
    async start(config) {
        const query = config.query.trim();
        const keywords = parseAutomationKeywords(query);
        const targetWebsite = config.targetWebsite.trim();
        const targetHost = (0, seo_1.normalizeTargetHost)(targetWebsite);
        const requestedInteractionHost = (0, seo_1.normalizeTargetHost)(config.controlledTestHost ?? '');
        if (keywords.length === 0)
            throw new Error('Enter at least one search keyword.');
        if (!targetHost)
            throw new Error('Enter a valid target website or site name.');
        // Target website is the interaction host by default. An explicit override
        // is allowed only when it resolves to the exact same hostname, so result
        // opening and Keep Alive can never drift to a different site.
        const controlledTestHost = requestedInteractionHost || targetHost;
        if (controlledTestHost !== targetHost) {
            throw new Error('Interaction host must exactly match the Target website host.');
        }
        const searchEngine = (0, seo_1.normalizeSearchEngine)(config.searchEngine ?? this.state.searchEngine);
        const browserCount = (0, automation_1.normalizeBrowserCount)(config.browserCount);
        const maxPages = (0, automation_1.normalizeSeoMaxPages)(config.maxPages);
        const intervalSec = (0, automation_1.normalizeAutomationIntervalSeconds)(config.intervalSec);
        const proxySource = (0, ProxyManager_1.resolveProxySource)(config.proxySource ?? this.state.proxySource, config.proxyApiUrl ?? this.state.proxyApiUrl);
        const requestedTier = config.proxyTier ?? this.state.proxyTier;
        const proxyTier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        this.stopTimerOnly();
        this.proxyManager.cancelCurrentFetch();
        this.generation += 1;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        this.pendingCycle = false;
        this.activeSessions.clear();
        this.repairingBrowsers.clear();
        this.failedProxyEndpoints.clear();
        this.failedProxyTimes.clear();
        this.lastCleanupScheduledThroughCycle = 0;
        this.pendingBrowserCleanup.clear();
        this.pendingLogCleanup = false;
        // Publish state before any browser preparation. The Start button therefore
        // reacts instantly even if Electron still has browser shells to create.
        this.state = {
            running: true,
            cycleInProgress: true,
            preparingBrowsers: true,
            preparedBrowsers: 0,
            proxySource: proxySource.id,
            proxySourceLabel: proxySource.label,
            proxyApiUrl: proxySource.endpoint,
            proxyTier,
            searchEngine,
            query,
            targetWebsite,
            controlledTestHost: controlledTestHost || undefined,
            intervalSec,
            browserCount,
            maxPages,
            browserIds: [],
            cycleNumber: 0,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: 0,
            assignedBrowsers: 0,
            retainedBrowsers: 0,
            replacedBrowsers: 0,
            nextCycleAt: undefined
        };
        this.emitState();
        let browserIds;
        try {
            const signal = this.cycleController.signal;
            browserIds = await waitForPreparation(this.ensureBrowserCount(browserCount, {
                signal,
                onProgress: (readyIds) => {
                    if (!this.isCurrent(generation) || !this.state.preparingBrowsers) return;
                    this.state = { ...this.state, preparedBrowsers: readyIds.length, browserIds: [...readyIds] };
                    this.emitState();
                }
            }), 60_000, signal, 'Browser preparation timed out. Try fewer browsers or retry Start.');
        }
        catch (err) {
            if (!this.isCurrent(generation)) return this.getState();
            this.cycleController.abort();
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: `Browser preparation failed: ${err.message}`
            };
            this.emitState();
            throw err;
        }
        if (!this.isCurrent(generation)) return this.getState();
        if (browserIds.length === 0) {
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: 'No browser workspaces are available.'
            };
            this.emitState();
            throw new Error('No browser workspaces are available.');
        }
        this.state = {
            ...this.state,
            cycleInProgress: false,
            preparingBrowsers: false,
            preparedBrowsers: browserIds.length,
            browserIds,
            nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
        };
        this.emitState();
        this.timer = setInterval(() => {
            if (!this.state.running)
                return;
            this.state = {
                ...this.state,
                nextCycleAt: new Date(Date.now() + this.state.intervalSec * 1000).toISOString()
            };
            this.emitState();
            void this.requestCycle();
        }, intervalSec * 1000);
        void this.requestCycle();
        return this.getState();
    }
    stop() {
        this.cycleController.abort();
        this.generation += 1;
        this.pendingCycle = false;
        this.activeSessions.clear();
        this.proxyManager.cancelCurrentFetch();
        this.stopTimerOnly();
        for (const id of this.state.browserIds) {
            try {
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            catch {
                // Browser may already have been removed.
            }
        }
        this.state = {
            ...this.state,
            running: false,
            cycleInProgress: false,
            preparingBrowsers: false,
            nextCycleAt: undefined
        };
        this.emitState();
        return this.getState();
    }
    async runNow() {
        if (!this.state.running)
            throw new Error('Start SEO Tracker first.');
        await this.requestCycle();
        return this.getState();
    }
    stopTimerOnly() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    emitState() {
        this.emit('stateChanged', this.getState());
    }
    async requestCycle() {
        if (!this.state.running)
            return;
        if (this.state.cycleInProgress) {
            this.pendingCycle = true;
            return;
        }
        await this.runCycle();
    }
    async runCycle() {
        if (!this.state.running)
            return;
        const generation = this.generation;
        this.cycleController.abort();
        this.activeSessions.clear();
        this.repairingBrowsers.clear();
        this.proxyManager.cancelCurrentFetch?.();
        this.cycleController = createCycleController();
        const cycleNumber = this.state.cycleNumber + 1;
        const browserIds = [...this.state.browserIds];
        const { query, targetWebsite, controlledTestHost, maxPages, proxySource, proxyApiUrl, proxyTier, searchEngine } = this.state;
        const keywords = parseAutomationKeywords(query);
        const browserQueries = new Map(browserIds.map((browserId, index) =>
            [browserId, keywords[(index + cycleNumber - 1) % keywords.length] ?? query]));
        // A proxy that reaches Google remains assigned across every later cycle
        // until an actual connection error, CAPTCHA or renderer failure occurs.
        // A missing target is not a proxy failure, nor is slow result rendering.
        const rotationStates = new Map(browserIds.map(id => [id, this.browserManager.getProxyRotationState(id)]));
        const belongsToSelectedTier = proxy => !proxyTier ||
            (0, ProxyTiers_1.matchesProxyTier)(proxy.countryCode, proxyTier);
        for (const health of rotationStates.values()) {
            if (health.proxy && this.proxyHasError(health)) this.rememberFailedProxy(health.proxy);
        }
        const retained = browserIds.filter(id => {
            const health = rotationStates.get(id);
            return health.proxy && belongsToSelectedTier(health.proxy) && !this.proxyHasError(health);
        }).map(browserId => ({ browserId, proxy: rotationStates.get(browserId).proxy, retained: true }));
        const retainedIds = new Set(retained.map(assignment => assignment.browserId));
        const replacementIds = browserIds.filter(id => !retainedIds.has(id));
        const failedProxies = this.getFailedProxies();
        this.state = {
            ...this.state,
            cycleInProgress: true,
            cycleNumber,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: retained.length,
            assignedBrowsers: retained.length,
            retainedBrowsers: retained.length,
            replacedBrowsers: 0,
            lastCycleStartedAt: new Date().toISOString(),
            lastError: undefined
        };
        this.emitState();
        const seoTasks = [];
        try {
            // Stop outgoing work before navigation and per-browser data clearing.
            for (const id of browserIds) {
                if (!this.isCurrent(generation))
                    return;
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            // Do not clear storage on ordinary cycles. A batch is due AFTER
            // cycles 10, 20, 30... and before the following cycle's searches.
            // Search tokens are already cancelled at this point.
            const completedBeforeThisCycle = cycleNumber - 1;
            if (completedBeforeThisCycle > 0 &&
                completedBeforeThisCycle % 10 === 0 &&
                this.lastCleanupScheduledThroughCycle < completedBeforeThisCycle) {
                this.lastCleanupScheduledThroughCycle = completedBeforeThisCycle;
                for (const id of browserIds) this.pendingBrowserCleanup.add(id);
                this.pendingLogCleanup = true;
            }
            if (this.pendingBrowserCleanup.size || this.pendingLogCleanup) {
                await this.runPeriodicCleanup(generation, cycleNumber, browserIds);
            }
            // Ordinary cycle boundaries retain all browser profiles and routes.
            if (!this.isCurrent(generation) || this.cycleController.signal.aborted) return;
            for (const assignment of retained) {
                const browserQuery = browserQueries.get(assignment.browserId);
                seoTasks.push(this.handleAssignment(generation, cycleNumber, assignment, browserQuery,
                    targetWebsite, controlledTestHost, maxPages, searchEngine));
            }
            // Healthy browsers start the next keyword even if the provider is
            // unavailable. An all-healthy cycle needs no API request at all.
            let providerError = null;
            if (replacementIds.length) try {
                await this.queueProxyFetch(() => this.proxyManager.fetchAssignDirect(replacementIds, (assignment) => {
                if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
                    return;
                const browserQuery = browserQueries.get(assignment.browserId) ?? query;
                seoTasks.push(this.handleAssignment(generation, cycleNumber, assignment, browserQuery, targetWebsite, controlledTestHost, maxPages, searchEngine));
            }, (checked, total, working, assigned, fetched) => {
                if (!this.isCurrent(generation))
                    return;
                this.state = {
                    ...this.state,
                    fetchedProxies: fetched,
                    checkedProxies: checked,
                    totalProxies: total,
                    liveProxies: working + retained.length,
                    assignedBrowsers: assigned + retained.length,
                    replacedBrowsers: assigned
                };
                this.emitState();
            }, { source: proxySource, endpoint: proxyApiUrl, tier: proxyTier, retainedAssignments: retained, failedProxies }));
            } catch (error) {
                providerError = error;
                // Failure of the external proxy API must not stop healthy tabs.
                this.state = { ...this.state, lastError: error.message };
                this.emitState();
            }
            await Promise.allSettled(seoTasks);
            // A short/failed source feed must not leave browsers unassigned
            // until the NEXT rotation. Each unserved browser retries within
            // the current cycle using the shared candidate pool and cooldown.
            for (const id of replacementIds) {
                if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber) return;
                if (this.activeSessions.has(id) || this.repairingBrowsers.has(id)) continue;
                this.retryUnassignedBrowser(generation, cycleNumber, id,
                    browserQueries.get(id), targetWebsite, controlledTestHost, maxPages, searchEngine);
            }
            if (!this.isCurrent(generation))
                return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString()
            };
            this.emitState();
            Logger_1.logger.info('application', `SEO cycle ${cycleNumber} (${keywords.join(', ')}) complete: ${this.state.liveProxies} available, ` +
                `${this.state.assignedBrowsers}/${browserIds.length} browser(s) assigned.`);
        }
        catch (err) {
            if (!this.isCurrent(generation))
                return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString(),
                lastError: err.message
            };
            this.emitState();
            Logger_1.logger.warn('application', `SEO cycle ${cycleNumber} failed: ${err.message}`);
        }
        finally {
            if (this.isCurrent(generation) && this.pendingCycle) {
                this.pendingCycle = false;
                void this.requestCycle();
            }
        }
    }
    async runPeriodicCleanup(generation, cycleNumber, browserIds) {
        const signal = this.cycleController.signal;
        const stillCurrent = () => this.isCurrent(generation) &&
            this.state.cycleNumber === cycleNumber && !signal.aborted;
        const ids = browserIds.filter(id => this.pendingBrowserCleanup.has(id));
        let next = 0, cleared = 0, failed = 0;
        const worker = async () => {
            while (next < ids.length && stillCurrent()) {
                const id = ids[next++];
                try {
                    await this.browserManager.clearPeriodicBrowserStorage(id, signal);
                    if (!stillCurrent()) return;
                    this.pendingBrowserCleanup.delete(id);
                    cleared++;
                } catch (error) {
                    if (!stillCurrent()) return;
                    failed++;
                    Logger_1.logger.warn('application',
                        `Browser ${id} periodic storage cleanup failed: ${error.message}`);
                    // Keep the browser pending; retry on the next cycle.
                }
            }
        };
        // Bound concurrent Chromium disk operations, including at 100 browsers.
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
        if (!stillCurrent()) return;
        if (this.pendingLogCleanup) {
            try {
                await Logger_1.logger.clearHistory?.();
                if (!stillCurrent()) return;
                this.pendingLogCleanup = false;
            } catch (error) {
                Logger_1.logger.warn('application',
                    `Periodic log cleanup failed: ${error.message}`);
            }
        }
        if (cleared || failed || ids.length === 0) {
            Logger_1.logger.info('application',
                `Ten-cycle cleanup after cycle ${this.lastCleanupScheduledThroughCycle}: ${cleared} browser(s) cleaned, ${failed} failed, ${this.pendingBrowserCleanup.size} pending. Cookies, proxy routes and IMP UI settings preserved.`);
        }
    }
    async handleAssignment(generation, cycleNumber, assignment, query, targetWebsite, controlledTestHost, maxPages, searchEngine, progress = {}) {
        if (!assignment.proxy || !this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
            return;
        const { browserId, proxy } = assignment;
        try {
            if (assignment.retained) this.browserManager.beginProxyCycle(browserId);
            else await this.browserManager.assignProxy(browserId, proxy);
            if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
                return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            const measurementToken = this.browserManager.startMeasurementSession(browserId);
            const session = {
                generation, cycleNumber, browserId, token: measurementToken,
                query, targetWebsite, controlledTestHost, maxPages, searchEngine,
                completed: progress.completed || 0
            };
            this.activeSessions.set(browserId, session);
            // A repaired browser resumes its interrupted keyword, not keyword A.
            // Finished browsers retain their proxy but do not redo completed work.
            if (session.completed < parseAutomationKeywords(this.state.query).length) {
                void this.monitorBrowserSession(generation, cycleNumber, browserId, measurementToken,
                    query, targetWebsite, controlledTestHost, maxPages, searchEngine).catch((error) => {
                    if (this.sessionActive(session))
                        void this.repairFailedProxy(session, error.message || String(error));
                });
            }
            return true;
        }
        catch (err) {
            if (!this.isCurrent(generation))
                return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            this.emit('seoResult', {
                cycleNumber,
                result: {
                    browserId,
                    status: 'error',
                    error: err.message,
                    ranAt: new Date().toISOString()
                }
            });
            return false;
        }
    }
    async monitorBrowserSession(generation, cycleNumber, browserId, measurementToken, query, targetWebsite, controlledTestHost, maxPages, searchEngine) {
        const signal = this.cycleController.signal;
        const observationIntervalMs = 30_000;
        const keywords = parseAutomationKeywords(this.state.query);
        let keywordIndex = Math.max(0, keywords.indexOf(query));
        const session = this.activeSessions.get(browserId);
        let completed = session?.completed || 0;
        const interactionHost = controlledTestHost || (0, seo_1.normalizeTargetHost)(targetWebsite);
        if (!interactionHost)
            return;
        while (this.isCurrent(generation) &&
            this.state.cycleNumber === cycleNumber &&
            this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
            let result;
            try {
                result = await this.browserManager.broadcastSearch(browserId, query, targetWebsite, maxPages, measurementToken, searchEngine);
            }
            catch (err) {
                if (!this.isCurrent(generation) ||
                    this.state.cycleNumber !== cycleNumber ||
                    !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
                    return;
                }
                this.emit('seoResult', {
                    cycleNumber,
                    result: {
                        browserId,
                        status: 'error',
                        error: err.message,
                        monitoring: true,
                        ranAt: new Date().toISOString()
                    }
                });
                if (session && this.sessionActive(session)) {
                    void this.repairFailedProxy(session, err.message);
                    return;
                }
                await cancellableDelay(5_000, signal);
                continue;
            }
            if (!this.isCurrent(generation) ||
                this.state.cycleNumber !== cycleNumber ||
                !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
                return;
            }
            const health = this.browserManager.getProxyRotationState?.(browserId);
            // Recognition/markup errors are not proof that a proxy is dead.
            // Replace only connection, transport and search-engine challenge failures.
            if (this.proxyHasError(health) ||
                (result.status === 'error' && this.isProxyNetworkError(result.error)) ||
                result.status === 'paused') {
                this.emit('seoResult', { cycleNumber, result: { ...result, query } });
                if (session && this.sessionActive(session)) {
                    void this.repairFailedProxy(session, result.error ||
                        (health?.captchaSeen ? 'Search engine challenge detected' : result.status));
                    return;
                }
            }
            if (result.status === 'matched' && (result.interactionStatus === 'hovered' ||
                result.interactionStatus === 'observed')) {
                this.emit('seoResult', { cycleNumber, result: { ...result, query } });
                completed += 1;
                if (session) session.completed = completed;
                if (completed >= keywords.length) return;
                keywordIndex = (keywordIndex + 1) % keywords.length;
                query = keywords[keywordIndex];
                if (session) session.query = query;
                // Keep exactly the same BrowserView, session and proxy.
                continue;
            }
            this.emit('seoResult', { cycleNumber, result });
            if (result.status === 'paused') {
                // Leave the current challenge available for manual recovery.
                // This fallback only runs without an active repairable session.
                // Active IMP sessions replace CAPTCHA proxies immediately.
                const recovered = await this.browserManager.waitForGoogleRecovery(browserId, observationIntervalMs, searchEngine);
                if (!recovered) {
                    await cancellableDelay(1_000, signal);
                }
                continue;
            }
            // Matched and no-match observations are measurements, not terminal
            // states. Recheck periodically until the next proxy rotation.
            // Unfinished pages keep their live preload and document. Resume
            // promptly so a newly rendered target is clicked instead of
            // sleeping for 30 seconds and then reloading it away.
            await cancellableDelay(result.status === 'monitoring' ? 250 : observationIntervalMs, signal);
        }
    }
    retryUnassignedBrowser(generation, cycleNumber, browserId, query, targetWebsite,
        controlledTestHost, maxPages, searchEngine) {
        if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber ||
            this.activeSessions.has(browserId) || this.repairingBrowsers.has(browserId) ||
            typeof this.browserManager.isMeasurementSessionCurrent !== 'function') return;
        const token = this.browserManager.startMeasurementSession(browserId);
        const session = {
            generation, cycleNumber, browserId, token, query, targetWebsite,
            controlledTestHost, maxPages, searchEngine, completed: 0
        };
        this.activeSessions.set(browserId, session);
        void this.repairFailedProxy(session, 'No usable proxy assigned; seeking an unused replacement');
    }
    isProxyNetworkError(error) {
        const message = String(error || '');
        return /ERR_(?:PROXY|TUNNEL|CONNECTION|TIMED_OUT|NETWORK|INTERNET|NAME_NOT_RESOLVED|SOCKS|ADDRESS_UNREACHABLE|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_CLOSED)|proxy (?:connection|navigation|request|server).*?(?:fail|error|timed out)|navigation timed out while using this proxy/i.test(message);
    }
    proxyHasError(health) {
        return Boolean(health && (health.failed || health.captchaSeen ||
            health.connectionStatus === 'proxy-failed' || health.connectionStatus === 'crashed'));
    }
    rememberFailedProxy(proxy) {
        if (!proxy?.host || !proxy.port) return;
        const key = String(proxy.host).toLowerCase() + ':' + proxy.port;
        if (!this.failedProxyEndpoints.has(key)) this.failedProxyTimes.set(key, Date.now());
        this.failedProxyEndpoints.set(key, proxy);
    }
    getFailedProxies() {
        // The free proxy feed changes; reconsider errors only after 30 minutes.
        const now = Date.now();
        for (const [key, at] of this.failedProxyTimes) {
            if (now - at < 30 * 60_000) continue;
            this.failedProxyTimes.delete(key);
            this.failedProxyEndpoints.delete(key);
        }
        return Array.from(this.failedProxyEndpoints.values());
    }
    queueProxyFetch(operation) {
        // The provider has one mutable fetch controller. Serialize initial
        // assignments and mid-cycle repair so neither cancels the other.
        const current = this.proxyFetchQueue.catch(() => {}).then(operation);
        this.proxyFetchQueue = current.catch(() => {});
        return current;
    }
    sessionActive(session) {
        return this.isCurrent(session.generation) &&
            this.state.cycleNumber === session.cycleNumber &&
            this.activeSessions.get(session.browserId) === session &&
            !this.cycleController.signal.aborted &&
            this.browserManager.isMeasurementSessionCurrent(session.browserId, session.token);
    }
    repairFailedProxy(session, reason) {
        const browserId = session.browserId;
        if (this.repairingBrowsers.has(browserId))
            return this.repairingBrowsers.get(browserId);
        const task = (async () => {
            if (!this.sessionActive(session)) return;
            const failed = this.browserManager.getProxyRotationState(browserId).proxy;
            if (failed) this.rememberFailedProxy(failed);
            // Prevent concurrent workers from searching on the failed route.
            this.activeSessions.delete(browserId);
            this.browserManager.cancelMeasurementSession(browserId);
            this.emit('seoResult', { cycleNumber: session.cycleNumber, result: {
                browserId, status: 'error',
                error: 'Replacing failed proxy: ' + (reason || 'connection error'),
                ranAt: new Date().toISOString()
            } });
            const signal = this.cycleController.signal;
            const stillCurrent = () => this.isCurrent(session.generation) &&
                this.state.cycleNumber === session.cycleNumber && !signal.aborted;
            while (stillCurrent()) {
                let replacement = null;
                let providerError = null;
                let resumed = false;
                try {
                    await this.queueProxyFetch(async () => {
                        if (!stillCurrent()) return;
                        // Reserve every healthy browser's endpoint so a failed
                        // slot cannot steal a route from another browser.
                        const retainedAssignments = this.state.browserIds.filter(id => id !== browserId)
                            .map(id => {
                                const health = this.browserManager.getProxyRotationState(id);
                                const reserved = this.proxyManager.getAssignment?.(id);
                                return { browserId: id,
                                    proxy: !this.proxyHasError(health) ? (health.proxy || reserved) : reserved,
                                    health };
                            })
                            .filter(item => item.proxy && (this.proxyHasError(item.health)
                                ? !this.failedProxyEndpoints.has(String(item.proxy.host).toLowerCase() + ':' + item.proxy.port)
                                : true));
                        const failedProxies = this.getFailedProxies();
                        if (failed && !failedProxies.some(proxy =>
                            String(proxy.host).toLowerCase() === String(failed.host).toLowerCase() &&
                            String(proxy.port) === String(failed.port))) {
                            failedProxies.push(failed);
                        }
                        const options = {
                            source: this.state.proxySource, endpoint: this.state.proxyApiUrl,
                            tier: this.state.proxyTier, retainedAssignments, failedProxies
                        };
                        if (typeof this.proxyManager.replaceFailedProxy === 'function') {
                            replacement = await this.proxyManager.replaceFailedProxy(browserId, options);
                        } else {
                            // Support simple proxy-manager adapters used in tests.
                            await this.proxyManager.fetchAssignDirect([browserId], assignment => {
                                replacement = assignment.proxy;
                            }, undefined, options);
                        }
                        if (stillCurrent() && replacement) {
                            // Keep the replacement route reserved until setProxy
                            // finishes. A second failing browser cannot acquire it.
                            resumed = await this.handleAssignment(session.generation, session.cycleNumber,
                                { browserId, proxy: replacement }, session.query, session.targetWebsite,
                                session.controlledTestHost, session.maxPages, session.searchEngine,
                                { completed: session.completed });
                        }
                    });
                } catch (error) {
                    providerError = error;
                }
                if (!stillCurrent()) return;
                if (resumed) {
                    // Keep assigned/new counters in sync after mid-cycle repair.
                    const assignedBrowsers = this.state.browserIds.filter(id => {
                        const health = this.browserManager.getProxyRotationState(id);
                        return health.proxy && !this.proxyHasError(health);
                    }).length;
                    this.state = { ...this.state, assignedBrowsers,
                        replacedBrowsers: this.state.replacedBrowsers + 1 };
                    this.emitState();
                    this.emit('seoResult', { cycleNumber: session.cycleNumber, result: {
                        browserId, status: 'monitoring',
                        error: 'Failed proxy replaced; continuing keyword ' + session.query,
                        ranAt: new Date().toISOString()
                    } });
                    return;
                }
                if (replacement) this.rememberFailedProxy(replacement);
                if (!replacement && !providerError) {
                    this.emit('seoResult', { cycleNumber: session.cycleNumber, result: {
                        browserId, status: 'error',
                        error: 'No unused proxy available in the selected source; retrying without disconnecting.',
                        ranAt: new Date().toISOString()
                    } });
                }
                if (providerError) {
                    this.emit('seoResult', { cycleNumber: session.cycleNumber, result: {
                        browserId, status: 'error',
                        error: 'Proxy replacement unavailable: ' + providerError.message,
                        ranAt: new Date().toISOString()
                    } });
                }
                await cancellableDelay(5_000, signal);
            }
        })();
        this.repairingBrowsers.set(browserId, task);
        void task.catch((error) => {
            Logger_1.logger.warn('application', 'Proxy repair failed: ' + error.message);
        }).finally(() => {
            if (this.repairingBrowsers.get(browserId) === task)
                this.repairingBrowsers.delete(browserId);
        });
        return task;
    }
    isCurrent(generation) {
        return this.state.running && generation === this.generation;
    }
}
exports.SeoAutomationManager = SeoAutomationManager;
function parseAutomationKeywords(value) {
    return value
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);
}
//# sourceMappingURL=SeoAutomationManager.js.map
