'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');

test('IMP: matching result is hovered, not clicked or opened', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron, {
        setTimeout: (fn, _ms, ...args) => setImmediate(fn, ...args),
        clearTimeout: () => {}
    })('main/BrowserManager.js');
    const manager = new BrowserManager();
    manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1);
    const wc = managed.view.webContents;
    const pointerEvents = [];
    const visits = [];
    wc.mainFrame = {};
    wc.isLoading = () => false;
    wc.loadURL = async url => {
        wc.url = url;
        visits.push(url);
        setImmediate(() => {
            const cfg = managed.googleConfig;
            wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'dom:google-state', {
                navigation: cfg.navigation, token: cfg.token, documentUrl: wc.getURL(),
                state: { observedResults: 1, documentParsed: false,
                    match: { url: 'https://example.test/article', title: 'Target title',
                        organicIndex: 0, clickPoint: { x: 40, y: 60 } } }
            });
        });
    };
    wc.sendInputEvent = event => pointerEvents.push(event.type);
    try {
        const token = manager.startMeasurementSession(1);
        const result = await manager.broadcastSearch(1, 'keyword A', 'example.test', 5, token);
        assert.equal(result.status, 'matched');
        assert.equal(result.interactionStatus, 'hovered');
        assert.equal(result.keepAliveStarted, false);
        assert.deepEqual(pointerEvents, ['mouseMove']);
        assert.equal(visits.length, 1);
        assert.match(visits[0], /search/);
        assert.doesNotMatch(visits[0], /example\.test\/article/);
    } finally {
        await manager.destroyAll();
    }
});

test('IMP: each browser advances A then B then C and finishes that cycle', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const searches = [];
    const emitted = [];
    const browser = {
        isMeasurementSessionCurrent: () => true,
        broadcastSearch: async (id, keyword) => {
            searches.push([id, keyword]);
            return { browserId: id, status: 'matched', interactionStatus: 'hovered' };
        },
        startControlledKeepAlive() { throw Error('Watch-only must not start Keep Alive'); }
    };
    const automation = new SeoAutomationManager({}, browser, async () => []);
    automation.state = { ...automation.state, running: true, cycleNumber: 1,
        query: 'keyword A,keyword B,keyword C' };
    automation.on('seoResult', e => emitted.push(e.result.query));
    await automation.monitorBrowserSession(0, 1, 1, 1, 'keyword A', 'example.test', '', 5);
    assert.deepEqual(searches, [
        [1, 'keyword A'], [1, 'keyword B'], [1, 'keyword C']
    ]);
    assert.deepEqual(emitted, ['keyword A', 'keyword B', 'keyword C']);
    automation.cycleController.abort();
});

test('IMP: a single selected browser accepts several sequential keywords', async () => {
    const { SeoAutomationManager } = loadTree(root, {}, {
        setInterval: () => 1, clearInterval() {}
    })('main/SeoAutomationManager.js');
    const browser = {
        getProxyRotationState: () => ({ proxy: null }),
        cancelMeasurementSession() {},
        setBrowserKeepAlive() {},
        prepareCycleDocument: async () => {},
        assignProxy: async () => {}
    };
    const proxy = { cancelCurrentFetch() {}, fetchAssignDirect: async () => {} };
    const manager = new SeoAutomationManager(proxy, browser, async () => [1]);
    await manager.start({ query: 'keyword A,keyword B,keyword C',
        targetWebsite: 'example.test', browserCount: 1, intervalSec: 30 });
    assert.equal(manager.getState().running, true);
    manager.stop();
});
