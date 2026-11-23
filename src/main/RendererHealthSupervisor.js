"use strict";

// IMP's React control panel and its native BrowserViews use different Electron
// WebContents. If React unmounts or the shell renderer dies, BrowserViews may
// stay visible over a blank dark shell. Recover ONLY the shell, not the tabs.
const HEALTH_SCRIPT = String.raw`(() => {
    const root = document.getElementById('root');
    return Boolean(root &&
        root.querySelector('.lite-shell .seo-tracker') &&
        root.querySelector('.lite-shell .lite-browser-area') &&
        window.app && window.app.automation && window.app.browser);
})()`;

class RendererHealthSupervisor {
    constructor(window, options = {}) {
        this.window = window;
        this.logger = options.logger || { warn() {}, error() {}, info() {} };
        this.now = options.now || Date.now;
        this.intervalMs = options.intervalMs || 5000;
        this.startupGraceMs = options.startupGraceMs ?? 8000;
        this.probeTimeoutMs = options.probeTimeoutMs || 2500;
        this.failuresBeforeReload = options.failuresBeforeReload || 2;
        this.maxReloads = options.maxReloads || 3;
        this.reloadWindowMs = options.reloadWindowMs || 2 * 60 * 1000;
        this.setIntervalFn = options.setIntervalFn || setInterval;
        this.clearIntervalFn = options.clearIntervalFn || clearInterval;
        this.setTimeoutFn = options.setTimeoutFn || setTimeout;
        this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        this.loadedAt = this.now();
        this.failures = 0;
        this.recoveries = [];
        this.recovering = false;
        this.checking = false;
        this.stopped = false;
        this.timer = null;
        this.listeners = [];
    }
    isAvailable() {
        const wc = this.window?.webContents;
        return !this.stopped && this.window && !this.window.isDestroyed?.() &&
            wc && !wc.isDestroyed?.();
    }
    start() {
        if (this.timer || this.stopped || !this.isAvailable()) return;
        const wc = this.window.webContents;
        const onLoad = () => {
            this.loadedAt = this.now();
            this.failures = 0;
        };
        const onCrash = (_event, details) => {
            void this.recover('control panel renderer exited: ' + (details?.reason || 'unknown'));
        };
        const onFailure = (_event, code, description, _url, isMainFrame) => {
            if (isMainFrame && code !== -3)
                void this.recover('control panel failed to load: ' + description);
        };
        const onUnresponsive = () => {
            // A transient busy UI is not a crash. Confirm with DOM probes.
            this.failures = Math.max(1, this.failures);
            void this.check();
        };
        wc.on('did-finish-load', onLoad);
        wc.on('render-process-gone', onCrash);
        wc.on('did-fail-load', onFailure);
        this.window.on('unresponsive', onUnresponsive);
        this.listeners = [
            [wc, 'did-finish-load', onLoad], [wc, 'render-process-gone', onCrash],
            [wc, 'did-fail-load', onFailure], [this.window, 'unresponsive', onUnresponsive]
        ];
        this.loadedAt = this.now();
        this.timer = this.setIntervalFn(() => { void this.check(); }, this.intervalMs);
        this.timer?.unref?.();
    }
    async probe() {
        if (!this.isAvailable()) return false;
        let timer;
        try {
            return Boolean(await Promise.race([
                Promise.resolve().then(() => this.window.webContents.executeJavaScript(HEALTH_SCRIPT, true)),
                new Promise(resolve => {
                    timer = this.setTimeoutFn(() => resolve(false), this.probeTimeoutMs);
                })
            ]));
        } catch {
            return false;
        } finally {
            if (timer !== undefined) this.clearTimeoutFn(timer);
        }
    }
    async check() {
        if (!this.isAvailable() || this.recovering || this.checking ||
            (this.window.isMinimized?.() || this.window.isVisible?.() === false) ||
            this.now() - this.loadedAt < this.startupGraceMs) return;
        this.checking = true;
        let healthy = false;
        try {
            healthy = await this.probe();
        } finally {
            this.checking = false;
        }
        if (!this.isAvailable()) return;
        if (healthy) {
            this.failures = 0;
        } else if (++this.failures >= this.failuresBeforeReload) {
            await this.recover('control panel is blank, missing, or unresponsive');
        }
    }
    async recover(reason) {
        if (!this.isAvailable() || this.recovering) return false;
        const now = this.now();
        this.recoveries = this.recoveries.filter(at => now - at < this.reloadWindowMs);
        if (this.recoveries.length >= this.maxReloads) {
            this.logger.warn('application',
                'IMP control panel recovery is rate-limited after repeated failures; browser sessions remain running.');
            return false;
        }
        this.recovering = true;
        this.failures = 0;
        this.loadedAt = now;
        this.recoveries.push(now);
        try {
            this.logger.warn('application',
                'Recovering blank IMP control panel without restarting BrowserViews or proxies: ' + reason);
            // This reloads only BrowserWindow.webContents. The separate
            // BrowserView WebContents and persistent sessions stay untouched.
            await Promise.resolve(this.window.webContents.reload());
            return true;
        } catch (error) {
            this.logger.error('application', 'IMP control panel reload failed: ' + error.message);
            return false;
        } finally {
            this.recovering = false;
        }
    }
    stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer !== null) this.clearIntervalFn(this.timer);
        this.timer = null;
        for (const [emitter, event, listener] of this.listeners)
            emitter.removeListener(event, listener);
        this.listeners = [];
    }
}

module.exports = { RendererHealthSupervisor, HEALTH_SCRIPT };
