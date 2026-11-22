'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const constants = require('../src/shared/constants');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'src/renderer/assets/index-BZgi7Ish.js'), 'utf8');

test('IMP and DOM have independent installer and executable identities', () => {
    assert.equal(pkg.name, 'imp');
    assert.equal(pkg.productName, 'IMP');
    assert.equal(pkg.build.appId, 'com.imp.desktop');
    assert.equal(pkg.build.productName, 'IMP');
    assert.equal(pkg.build.win.executableName, 'IMP');
    assert.equal(pkg.build.nsis.shortcutName, 'IMP');
    assert.equal(pkg.build.win.artifactName, 'IMP-v${version}-Windows-${arch}-Setup.${ext}');
    assert.notEqual(pkg.build.appId, 'com.dom.desktop');
    assert.notEqual(pkg.build.win.executableName, 'DOM');
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages[''].name, pkg.name);
});

test('IMP receives a separate Electron profile and session namespace', () => {
    assert.equal(constants.APP_ID, 'com.imp.desktop');
    assert.equal(constants.APP_NAME, 'IMP');
    assert.equal(constants.PARTITION_PREFIX, 'persist:imp-browser-');
    assert.equal(constants.EPHEMERAL_PARTITION_PREFIX, 'imp-browser-ephemeral-');
    assert.match(main, /app\.setName\("IMP"\)/);
    assert.match(main, /app\.setAppUserModelId\("com\.imp\.desktop"\)/);
});

test('IMP window and title visibly differ from original DOM', () => {
    assert.match(main, /title: 'IMP Watch-only Research'/);
    assert.match(html, /<title>IMP<\/title>/);
    assert.match(bundle, /IMP Watch-only Research/);
});
