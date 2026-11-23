'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
const proxy = n => ({ id: 'proxy-' + n, protocol: 'http', host: '192.0.2.' + n, port: 8080 });
const waitUntil = async (condition) => {
    for (let i = 0; i < 100; i += 1) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out awaiting the IMP proxy/keyword event');
};

test('healthy assigned browser keeps its proxy across cycles even if target is absent or Google has no new result', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const calls = [];
    const health = {
        proxy: proxy(1), googleReached: true, targetOpened: false,
        captchaSeen: false, failed: false, connectionStatus: 'connected'
    };
    const browser = {
        getProxyRotationState: () => ({ ...health }),
        cancelMeasurementSession() {},
        beginProxyCycle: id => calls.push(['keep', id]),
        setBrowserKeepAlive() {},
        prepareCycleDocument: async () => {},
        assignProxy: async () => { throw Error('Healthy proxy must not be reassigned'); },
        startMeasurementSession: () => 1,
        isMeasurementSessionCurrent: () => true
    };
    const provider = { cancelCurrentFetch() {}, fetchAssignDirect: async () => { throw Error('Healthy proxy must not trigger a provider fetch'); } };
    const manager = new SeoAutomationManager(provider, browser, async () => []);
    manager.state = { ...manager.state, running: true, cycleNumber: 1,
        browserIds: [1], query: 'keyword A,keyword B', targetWebsite: 'fixture.test' };
    manager.monitorBrowserSession = async () => {};
    await manager.runCycle();
    health.googleReached = false; // No new Google result is not a network error.
    await manager.runCycle();
    assert.deepEqual(calls, [['keep', 1], ['keep', 1]]);
    assert.equal(manager.getState().retainedBrowsers, 1);
    manager.stop();
});

test('after a match the same browser searches the next keyword; only actual error changes proxy and retries that keyword', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const searches = [], assignments = [], providerCalls = [], token = new Map();
    let activeProxy = proxy(1), failure = false;
    const browser = new EventEmitter();
    browser.getProxyRotationState = () => ({
        proxy: activeProxy, googleReached: true,
        failed: failure, captchaSeen: false, connectionStatus: failure ? 'proxy-failed' : 'connected'
    });
    browser.beginProxyCycle = () => {};
    browser.setBrowserKeepAlive = () => {};
    browser.cancelMeasurementSession = id => token.set(id, (token.get(id) || 0) + 1);
    browser.startMeasurementSession = id => {
        const t = (token.get(id) || 0) + 1;
        token.set(id, t);
        return t;
    };
    browser.isMeasurementSessionCurrent = (id, value) => token.get(id) === value;
    browser.assignProxy = async (id, candidate) => {
        assignments.push([id, candidate.id]);
        activeProxy = candidate; failure = false;
    };
    browser.broadcastSearch = async (id, keyword) => {
        searches.push([id, keyword, activeProxy.id]);
        if (keyword === 'B' && activeProxy.id === 'proxy-1') {
            failure = true;
            return { browserId: id, status: 'error', error: 'ERR_PROXY_CONNECTION_FAILED' };
        }
        return { browserId: id, status: 'matched', interactionStatus: 'hovered' };
    };
    const provider = {
        cancelCurrentFetch() {},
        fetchAssignDirect: async (ids, assign, _progress, options) => {
            providerCalls.push({ ids: [...ids], options });
            assign({ browserId: 1, proxy: proxy(2) });
        }
    };
    const manager = new SeoAutomationManager(provider, browser, async () => []);
    manager.state = { ...manager.state, running: true, cycleNumber: 1,
        browserIds: [1], query: 'A,B,C', targetWebsite: 'fixture.test' };
    await manager.handleAssignment(0, 1, { browserId: 1, proxy: proxy(1), retained: true },
        'A', 'fixture.test', '', 5, 'google');
    await waitUntil(() => searches.some(row => row[1] === 'C'));
    assert.deepEqual(searches, [
        [1, 'A', 'proxy-1'], [1, 'B', 'proxy-1'],
        [1, 'B', 'proxy-2'], [1, 'C', 'proxy-2']
    ]);
    assert.deepEqual(assignments, [[1, 'proxy-2']], 'A to B never changes proxy');
    assert.deepEqual(providerCalls[0].ids, [1]);
    assert.deepEqual(Array.from(providerCalls[0].options.failedProxies, p => p.id), ['proxy-1']);
    manager.stop();
});

test('connection failure event replaces only that browser and reserves healthy browser endpoints', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const browser = new EventEmitter(), health = new Map([
        [1, { proxy: proxy(1), googleReached: true, failed: false, captchaSeen: false, connectionStatus: 'connected' }],
        [2, { proxy: proxy(2), googleReached: true, failed: false, captchaSeen: false, connectionStatus: 'connected' }]
    ]), tokens = new Map(), assigned = [], requests = [];
    browser.getProxyRotationState = id => health.get(id);
    browser.beginProxyCycle = () => {};
    browser.setBrowserKeepAlive = () => {};
    browser.startMeasurementSession = id => {
        const value = (tokens.get(id) || 0) + 1;
        tokens.set(id, value);
        return value;
    };
    browser.cancelMeasurementSession = id => tokens.set(id, (tokens.get(id) || 0) + 1);
    browser.isMeasurementSessionCurrent = (id, value) => tokens.get(id) === value;
    browser.assignProxy = async (id, next) => {
        assigned.push([id, next.id]);
        health.set(id, { proxy: next, googleReached: false,
            failed: false, captchaSeen: false, connectionStatus: 'proxy-checking' });
    };
    const provider = {
        cancelCurrentFetch() {},
        fetchAssignDirect: async (ids, assign, _progress, options) => {
            requests.push({ ids: [...ids], options });
            assign({ browserId: ids[0], proxy: proxy(3) });
        }
    };
    const manager = new SeoAutomationManager(provider, browser, async () => []);
    manager.state = { ...manager.state, running: true, cycleNumber: 1, browserIds: [1, 2],
        query: 'A,B,C', targetWebsite: 'fixture.test' };
    // Park completed browsers: the real app still observes connection errors.
    await manager.handleAssignment(0, 1, { browserId: 1, proxy: proxy(1), retained: true },
        'C', 'fixture.test', '', 5, 'google', { completed: 3 });
    await manager.handleAssignment(0, 1, { browserId: 2, proxy: proxy(2), retained: true },
        'C', 'fixture.test', '', 5, 'google', { completed: 3 });
    health.get(2).failed = true;
    browser.emit('stateChanged', { id: 2, proxy: proxy(2), connectionStatus: 'proxy-failed',
        errorMessage: 'ERR_TUNNEL_CONNECTION_FAILED' });
    await waitUntil(() => assigned.length === 1);
    assert.deepEqual(assigned, [[2, 'proxy-3']]);
    assert.deepEqual(requests[0].ids, [2]);
    assert.deepEqual(requests[0].options.retainedAssignments.map(a => a.browserId), [1]);
    assert.deepEqual(Array.from(requests[0].options.failedProxies, p => p.id), ['proxy-2']);
    assert.equal(health.get(1).proxy.id, 'proxy-1');
    manager.stop();
});

test('two simultaneous failures receive different replacement proxies; healthy third browser is untouched', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const browser = new EventEmitter();
    const health = new Map([1, 2, 3].map(id => [id, {
        proxy: proxy(id), googleReached: true, failed: false,
        captchaSeen: false, connectionStatus: 'connected'
    }]));
    const tokens = new Map(), changes = [], requests = [];
    browser.getProxyRotationState = id => health.get(id);
    browser.beginProxyCycle = () => {};
    browser.setBrowserKeepAlive = () => {};
    browser.startMeasurementSession = id => {
        const t = (tokens.get(id) || 0) + 1;
        tokens.set(id, t);
        return t;
    };
    browser.cancelMeasurementSession = id => tokens.set(id, (tokens.get(id) || 0) + 1);
    browser.isMeasurementSessionCurrent = (id, t) => tokens.get(id) === t;
    browser.assignProxy = async (id, replacement) => {
        changes.push([id, replacement.id]);
        health.set(id, { proxy: replacement, googleReached: false,
            failed: false, captchaSeen: false, connectionStatus: 'proxy-checking' });
    };
    const provider = {
        cancelCurrentFetch() {},
        fetchAssignDirect: async (ids, assign, _progress, options) => {
            requests.push({ ids: [...ids], options });
            const excluded = new Set([
                ...options.retainedAssignments.map(a => a.proxy.id),
                ...options.failedProxies.map(p => p.id)
            ]);
            const replacement = [proxy(4), proxy(5)].find(p => !excluded.has(p.id));
            if (!replacement) throw Error('No distinct proxy available');
            assign({ browserId: ids[0], proxy: replacement });
        }
    };
    const manager = new SeoAutomationManager(provider, browser, async () => []);
    manager.state = { ...manager.state, running: true, cycleNumber: 1,
        browserIds: [1, 2, 3], query: 'A', targetWebsite: 'fixture.test' };
    for (const id of [1, 2, 3]) await manager.handleAssignment(
        0, 1, { browserId: id, proxy: proxy(id), retained: true },
        'A', 'fixture.test', '', 5, 'google', { completed: 1 });
    for (const id of [2, 3]) {
        health.get(id).failed = true;
        browser.emit('stateChanged', { id, proxy: proxy(id),
            connectionStatus: 'proxy-failed', errorMessage: 'ERR_PROXY_CONNECTION_FAILED' });
    }
    await waitUntil(() => changes.length === 2);
    assert.deepEqual(changes, [[2, 'proxy-4'], [3, 'proxy-5']]);
    assert.equal(health.get(1).proxy.id, 'proxy-1');
    assert.deepEqual(requests.map(r => r.ids[0]), [2, 3]);
    assert.ok(Array.from(requests[1].options.retainedAssignments, a => a.proxy.id).includes('proxy-4'),
        'second repair must reserve the first repaired browser route');
    manager.stop();
});
