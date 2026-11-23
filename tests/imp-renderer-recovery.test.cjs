'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RendererHealthSupervisor, HEALTH_SCRIPT } = require('../src/main/RendererHealthSupervisor');

function harness(options = {}) {
    let now = 0, healthy = options.healthy ?? true;
    let reloads = 0, intervalCallback, stoppedInterval = false;
    const wc = new EventEmitter();
    wc.isDestroyed = () => false;
    wc.executeJavaScript = async () => healthy;
    wc.reload = () => { reloads++; };
    const window = new EventEmitter();
    window.webContents = wc;
    window.isDestroyed = () => false;
    window.isVisible = () => true;
    window.isMinimized = () => false;
    const logs = [];
    const browserOperations = [];
    const supervisor = new RendererHealthSupervisor(window, {
        logger: {
            warn: (_channel, msg) => logs.push(msg),
            error: (_channel, msg) => logs.push(msg)
        },
        now: () => now,
        intervalMs: 100,
        startupGraceMs: 10,
        failuresBeforeReload: 2,
        maxReloads: options.maxReloads ?? 3,
        reloadWindowMs: 200,
        setIntervalFn: callback => { intervalCallback = callback; return 1; },
        clearIntervalFn: () => { stoppedInterval = true; }
    });
    return {
        supervisor, window, wc, browserOperations, logs,
        get reloads() { return reloads; },
        get stoppedInterval() { return stoppedInterval; },
        setHealthy: next => { healthy = next; },
        advance: ms => { now += ms; },
        tick: async () => { await intervalCallback?.(); await new Promise(setImmediate); }
    };
}

test('healthy IMP controls do not reload during long-running browser research', async () => {
    const h = harness();
    h.supervisor.start();
    h.advance(100);
    for (let cycle = 0; cycle < 40; cycle++) {
        await h.supervisor.check();
        h.advance(20);
    }
    assert.equal(h.reloads, 0);
    h.supervisor.stop();
    assert.equal(h.stoppedInterval, true);
});

test('a dark shell with missing React controls recovers without recreating browser sessions', async () => {
    const h = harness({ healthy: false });
    h.supervisor.start();
    h.advance(11);
    await h.supervisor.check();
    assert.equal(h.reloads, 0, 'single failed probe is not enough');
    await h.supervisor.check();
    assert.equal(h.reloads, 1);
    assert.match(h.logs[0], /without restarting BrowserViews or proxies/);
    h.setHealthy(true);
    h.advance(12);
    await h.supervisor.check();
    assert.equal(h.supervisor.failures, 0);
    assert.deepEqual(h.browserOperations, []);
    h.supervisor.stop();
});

test('a renderer process crash reloads only the IMP shell', async () => {
    const h = harness();
    h.supervisor.start();
    h.wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await new Promise(setImmediate);
    assert.equal(h.reloads, 1);
    assert.match(h.logs[0], /renderer exited/);
    h.supervisor.stop();
});

test('normal aborted navigation does not cause false crash recovery', async () => {
    const h = harness();
    h.supervisor.start();
    h.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'about:blank', true);
    await new Promise(setImmediate);
    assert.equal(h.reloads, 0);
    h.supervisor.stop();
});

test('recovery is rate-limited so a permanent renderer failure cannot loop indefinitely', async () => {
    const h = harness({ healthy: false, maxReloads: 2 });
    h.supervisor.start();
    for (let i = 0; i < 4; i++) {
        h.advance(11);
        await h.supervisor.check();
        await h.supervisor.check();
    }
    assert.equal(h.reloads, 2);
    assert.ok(h.logs.some(v => v.includes('rate-limited')));
    h.advance(201);
    await h.supervisor.check();
    await h.supervisor.check();
    assert.equal(h.reloads, 3, 'recovery allowed again after cooldown');
    h.supervisor.stop();
});

test('observer detaches after window closes and does not reload dead webContents', async () => {
    const h = harness({ healthy: false });
    h.supervisor.start();
    h.supervisor.stop();
    h.wc.emit('render-process-gone', {}, { reason: 'crashed' });
    h.advance(100);
    await h.supervisor.check();
    assert.equal(h.reloads, 0);
});

test('health probe requires the actual controls and IPC, not merely DOMContentLoaded', () => {
    assert.ok(HEALTH_SCRIPT.includes('.lite-shell .seo-tracker'));
    assert.ok(HEALTH_SCRIPT.includes('.lite-shell .lite-browser-area'));
    assert.ok(HEALTH_SCRIPT.includes('window.app'));
});
