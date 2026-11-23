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

test('real ProxyManager caches candidate pool and preserves every healthy assignment during a failed-slot replacement', async () => {
    const source = Array.from({ length: 12 }, (_, i) => 'http://192.0.2.' + (i + 1) + ':8080').join('\n');
    let requests = 0;
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => {
            requests++;
            return { ok: true, text: async () => source };
        }
    })('main/ProxyManager.js');
    const manager = new ProxyManager();
    const assigned = new Map();
    await manager.fetchAssignDirect([1, 2, 3], a => assigned.set(a.browserId, a.proxy));
    assert.equal(requests, 1);
    const held = assigned.get(1), failed = assigned.get(2), third = assigned.get(3);
    const replacement = await manager.replaceFailedProxy(2, {
        retainedAssignments: [{ browserId: 1, proxy: held }, { browserId: 3, proxy: third }],
        failedProxies: [failed]
    });
    assert.ok(replacement);
    assert.notEqual(replacement.host + ':' + replacement.port, failed.host + ':' + failed.port);
    assert.notEqual(replacement.host + ':' + replacement.port, held.host + ':' + held.port);
    assert.equal(requests, 1, 'failover must reuse cached candidates instead of contacting provider again');
    assert.equal(manager.getAssignment(1).host, held.host, 'other browser route was overwritten');
    assert.equal(manager.getAssignment(3).host, third.host, 'other browser route was overwritten');
    assert.equal(manager.getAssignment(2).host, replacement.host);
});

test('exhausted failover pool does not drop healthy assignments or repeatedly fetch proxy API', async () => {
    const feed = ['http://192.0.2.1:8080', 'http://192.0.2.2:8080'].join('\n');
    let requests = 0;
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => {
            requests++;
            return { ok: true, text: async () => feed };
        }
    })('main/ProxyManager.js');
    const manager = new ProxyManager();
    const assigned = [];
    await manager.fetchAssignDirect([1, 2], a => assigned.push(a));
    const healthy = assigned[0].proxy, failed = assigned[1].proxy;
    const options = {
        retainedAssignments: [{ browserId: 1, proxy: healthy }],
        failedProxies: [failed]
    };
    assert.equal(await manager.replaceFailedProxy(2, options), null);
    assert.equal(await manager.replaceFailedProxy(2, options), null);
    assert.equal(requests, 2, 'one rate-limited refresh after exhaustion; no fetch per retry');
    assert.equal(manager.getAssignment(1).host, healthy.host);
});

test('failovers for different failed browsers reserve unique proxies from cached pool', async () => {
    const feed = Array.from({ length: 7 }, (_, i) => 'http://192.0.2.' + (i + 1) + ':8080').join('\n');
    let requests = 0;
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => { requests++; return { ok: true, text: async () => feed }; }
    })('main/ProxyManager.js');
    const manager = new ProxyManager(), initial = new Map();
    await manager.fetchAssignDirect([1, 2, 3], a => initial.set(a.browserId, a.proxy));
    const first = await manager.replaceFailedProxy(2, {
        retainedAssignments: [{ browserId: 1, proxy: initial.get(1) }],
        failedProxies: [initial.get(2), initial.get(3)]
    });
    const second = await manager.replaceFailedProxy(3, {
        retainedAssignments: [{ browserId: 1, proxy: initial.get(1) }, { browserId: 2, proxy: first }],
        failedProxies: [initial.get(2), initial.get(3)]
    });
    assert.notEqual(first.host, second.host);
    assert.equal(manager.getAssignment(1).host, initial.get(1).host);
    assert.equal(requests, 1);
});

test('cycle boundaries keep browser profile and existing failed proxy until a replacement is secured', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const proxy = n => ({ id: 'p'+n, protocol:'http', host:'192.0.2.'+n, port:8080 });
    const health = new Map([
        [1, { proxy: proxy(1), googleReached: true, failed:false, captchaSeen:false }],
        [2, { proxy: proxy(2), googleReached: true, failed:true, captchaSeen:false }]
    ]);
    const events = [], browser = {
        getProxyRotationState: id => health.get(id),
        cancelMeasurementSession: id => events.push(['cancel',id]),
        setBrowserKeepAlive: () => {},
        beginProxyCycle: id => events.push(['keep',id]),
        prepareCycleDocument: () => { throw Error('Cycle must not erase browser cookies or cache'); },
        assignProxy: async (id, value) => {
            assert.ok(value, 'Never disconnect failed proxy until new route exists');
            events.push(['new', id, value.id]);
            health.set(id, {proxy:value,googleReached:false,failed:false,captchaSeen:false});
        },
        startMeasurementSession: () => 1
    };
    const provider = {
        cancelCurrentFetch: () => {},
        fetchAssignDirect: async (_ids, assign) => assign({browserId:2,proxy:proxy(3)})
    };
    const app = new SeoAutomationManager(provider,browser,async()=>[]);
    app.state={...app.state,running:true,cycleNumber:1,browserIds:[1,2],query:'a,b',
        targetWebsite:'test.example'};
    app.monitorBrowserSession=async()=>{};
    await app.runCycle();
    assert.ok(events.some(x=>x[0]==='keep'&&x[1]===1));
    assert.ok(events.some(x=>x[0]==='new'&&x[1]===2&&x[2]==='p3'));
    assert.ok(!events.some(x=>x[0]==='new'&&x[1]===1));
    app.stop();
});

test('empty slot actively retries failed provider assignment without waiting for a new cycle', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const browser = new EventEmitter();
    let current = null, token = 0, fetches = 0, repairs = 0, searched = 0;
    browser.getProxyRotationState = () => ({ proxy: current, googleReached: Boolean(current),
        failed: false, captchaSeen: false, connectionStatus: current ? 'connected' : 'no-proxy' });
    browser.cancelMeasurementSession = () => { token++; };
    browser.startMeasurementSession = () => ++token;
    browser.isMeasurementSessionCurrent = (_id, value) => token === value;
    browser.setBrowserKeepAlive = () => {};
    browser.assignProxy = async (_id, selected) => { current = selected; };
    browser.broadcastSearch = async () => { searched++; return { status:'matched', interactionStatus:'hovered' }; };
    const provider = {
        cancelCurrentFetch() {},
        fetchAssignDirect: async () => { fetches++; throw Error('Provider temporarily offline'); },
        replaceFailedProxy: async () => { repairs++; return proxy(7); }
    };
    const app = new SeoAutomationManager(provider, browser, async()=>[]);
    app.state = { ...app.state, running:true, cycleNumber:0, browserIds:[1],
        query:'keyword A', targetWebsite:'fixture.test' };
    await app.runCycle();
    await waitUntil(() => searched > 0);
    assert.equal(fetches, 1);
    assert.equal(repairs, 1, 'missing slot must retry through the failover path in the same cycle');
    assert.equal(current.id, 'proxy-7');
    assert.equal(app.state.cycleNumber, 1);
    app.stop();
});

test('parser errors are not proxy failures but timeout and connection errors are', () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const app = new SeoAutomationManager({}, {}, async()=>[]);
    assert.equal(app.isProxyNetworkError('Google result recognition failed: missing a result anchor'), false);
    assert.equal(app.isProxyNetworkError('Detected result destination did not match target website'), false);
    assert.equal(app.isProxyNetworkError('ERR_PROXY_CONNECTION_FAILED'), true);
    assert.equal(app.isProxyNetworkError('Failed to open Google result page 1: ERR_TIMED_OUT'), true);
    assert.equal(app.isProxyNetworkError('Google navigation timed out while using this proxy'), true);
});

test('failed free-proxy endpoints become eligible for reconsideration after cooldown', () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const app = new SeoAutomationManager({}, {}, async()=>[]);
    app.rememberFailedProxy(proxy(1));
    assert.equal(app.getFailedProxies().length, 1);
    app.failedProxyTimes.set('192.0.2.1:8080', Date.now() - 31 * 60_000);
    assert.equal(app.getFailedProxies().length, 0);
});
