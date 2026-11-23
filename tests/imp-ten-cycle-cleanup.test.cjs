'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');

test('browser cleanup removes localStorage and Cache Storage plus HTTP cache without touching proxies or cookies', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const browser = new BrowserManager();
    browser.attachWindow(electron.window);
    await browser.createBrowser(1, { startPage: 'about:blank' });
    await browser.createBrowser(2, { startPage: 'about:blank' });
    const one = browser.get(1), two = browser.get(2);
    const proxy = { protocol: 'http', host: '192.0.2.42', port: 8080 };
    one.state.proxy = proxy;
    one.session.proxy = { proxyRules: 'http=192.0.2.42:8080' };
    one.session.cookieMarker = 'accepted';
    const originalURL = one.view.webContents.getURL();
    const operations = [];
    one.session.clearCache = async () => operations.push('http-cache');
    one.session.clearStorageData = async options => operations.push(['storage', options.storages]);
    two.session.clearCache = async () => { throw Error('unrelated session must be untouched'); };
    two.session.clearStorageData = async () => { throw Error('unrelated session must be untouched'); };
    try {
        await browser.clearPeriodicBrowserStorage(1);
        assert.deepEqual(operations, ['http-cache', ['storage', ['localstorage', 'cachestorage']]]);
        assert.equal(one.state.proxy, proxy);
        assert.equal(one.session.cookieMarker, 'accepted');
        assert.equal(one.view.webContents.getURL(), originalURL);
        assert.equal(one.session.connectionsClosed || 0, 0);
        assert.equal(two.view.webContents.getURL(), 'about:blank');
    } finally {
        await browser.destroyAll();
    }
});

test('after cycles 10 and 20 cleanup runs once per browser, never on other cycles', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const route1 = { id: 'p1', host: '192.0.2.1', port: 8080 };
    const route2 = { id: 'p2', host: '192.0.2.2', port: 8080 };
    const routes = new Map([[1, route1], [2, route2]]);
    const events = [];
    let app;
    const browser = {
        getProxyRotationState: id => ({ proxy: routes.get(id), googleReached: true, captchaSeen: false, failed: false }),
        cancelMeasurementSession() {},
        setBrowserKeepAlive() {},
        beginProxyCycle() {},
        startMeasurementSession: () => 1,
        isMeasurementSessionCurrent: () => true,
        clearPeriodicBrowserStorage: async id => { events.push([app.state.cycleNumber, id]); },
        assignProxy: async () => { throw Error('No proxy must be reassigned by cleanup'); }
    };
    const provider = {
        cancelCurrentFetch() {},
        fetchAssignDirect: async () => { throw Error('Healthy proxy must not fetch again'); }
    };
    app = new SeoAutomationManager(provider, browser, async () => []);
    app.state = { ...app.state, running: true, browserIds: [1,2], query: 'keyword A,keyword B', targetWebsite: 'example.test' };
    app.monitorBrowserSession = async () => {};
    for (let cycle = 1; cycle <= 21; cycle++) await app.runCycle();
    assert.deepEqual(events, [[11,1], [11,2], [21,1], [21,2]]);
    assert.equal(app.lastCleanupScheduledThroughCycle, 20);
    assert.equal(app.pendingBrowserCleanup.size, 0);
    assert.equal(app.pendingLogCleanup, false);
    assert.equal(routes.get(1), route1);
    assert.equal(routes.get(2), route2);
    app.stop();
});

test('a failed browser-data cleanup retries on the next cycle, without wiping other browsers', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const route = { id: 'p1', host: '192.0.2.1', port: 8080 };
    const events = [];
    let app, attempts = 0;
    const browser = {
        getProxyRotationState: () => ({ proxy: route, googleReached: true, captchaSeen: false, failed: false }),
        cancelMeasurementSession() {},
        setBrowserKeepAlive() {},
        beginProxyCycle() {},
        startMeasurementSession: () => 1,
        isMeasurementSessionCurrent: () => true,
        clearPeriodicBrowserStorage: async id => {
            events.push([app.state.cycleNumber,id]);
            if (++attempts === 1) throw Error('temporary cache lock');
        }
    };
    const appProvider = { cancelCurrentFetch() {}, fetchAssignDirect() { throw Error('unexpected proxy fetch'); } };
    app = new SeoAutomationManager(appProvider, browser, async () => []);
    app.state = { ...app.state, running: true, browserIds: [1], query: 'A', targetWebsite: 'example.test' };
    app.monitorBrowserSession = async () => {};
    for (let cycle = 1; cycle <= 11; cycle++) await app.runCycle();
    assert.equal(app.pendingBrowserCleanup.has(1), true);
    await app.runCycle();
    assert.deepEqual(events, [[11,1], [12,1]]);
    assert.equal(app.pendingBrowserCleanup.size, 0);
    app.stop();
});

test('IMP log reset deletes only its channel logs and rotations then continues logging', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-ten-cycle-'));
    const source = fsSync.readFileSync(path.join(root, 'main', 'Logger.js'), 'utf8');
    const module = { exports: {} };
    const factory = vm.runInThisContext('(function(require,module,exports,__dirname){' + source + '\n})');
    const localRequire = name => name === 'electron'
        ? { app: { getPath: () => dir } }
        : name === './BoundedLogWriter'
            ? require('../src/main/BoundedLogWriter')
            : require(name);
    factory(localRequire, module, module.exports, path.join(root, 'main'));
    const logger = module.exports.logger;
    const folder = path.join(dir, 'logs');
    try {
        logger.info('application', 'before periodic cleanup');
        await logger.streams.application.work;
        await fs.writeFile(path.join(folder, 'application.log.1'), 'old rotated backup');
        await fs.writeFile(path.join(folder, 'settings.json'), 'must remain');
        await logger.clearHistory();
        const names = await fs.readdir(folder);
        assert.equal(names.includes('application.log'), false);
        assert.equal(names.includes('application.log.1'), false);
        assert.equal(names.includes('settings.json'), true);
        logger.info('application', 'after periodic cleanup');
        await logger.streams.application.work;
        const content = await fs.readFile(path.join(folder, 'application.log'), 'utf8');
        assert.match(content, /after periodic cleanup/);
        assert.doesNotMatch(content, /before periodic cleanup/);
    } finally {
        await logger.close();
        await fs.rm(dir, { recursive: true, force: true });
    }
});
