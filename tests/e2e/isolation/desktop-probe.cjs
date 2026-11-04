const assert = require('node:assert/strict');
const { promises: fs, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const root = process.argv[2];
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
assert(root && process.argv[8] === 'window-once' && process.argv[10] === 'primary-desktop-candidate');
assert.equal(process.argv.length,14);
assert.deepEqual(process.argv.slice(11), ['--enable-logging=file','--log-level=2','--log-file=..\\scratch\\electron.log']);
assert.equal(process.type, 'browser');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
for (const bad of ['no-sandbox', 'disable-setuid-sandbox', 'disable-web-security']) assert(!app.commandLine.hasSwitch(bad));
let window;
const deadline = setTimeout(() => { emit({ type: 'desktop-phase', phase: 'timeout' }); app.exit(2); }, 20000);
async function run() {
  emit({ type: 'desktop-phase', phase: 'main', pid: process.pid, electron: process.versions.electron,
    node: process.versions.node, processType: process.type, softwareRendering: true });
  for (const name of ['user-data','session-data','crash-dumps']) mkdirSync(join(root,'scratch',name),{recursive:true});
  app.disableHardwareAcceleration();
  app.setPath('userData', join(root, 'scratch/user-data'));
  app.setPath('sessionData', join(root, 'scratch/session-data'));
  app.setPath('crashDumps', join(root, 'scratch/crash-dumps'));
  const operations = [];
  async function operation(name, action) {
    try { await action(); operations.push({ name, ok: true }); }
    catch (error) { operations.push({ name, ok: false, code: error.code }); }
  }
  await operation('package-read', async () => assert.equal(await fs.readFile(join(root, 'package/allowed.txt'), 'utf8'), 'SYNTHETIC ALLOWED\n'));
  await operation('scratch-write', () => fs.writeFile(join(root, 'scratch/desktop.txt'), 'SYNTHETIC\n', { flag: 'wx' }));
  await operation('outside-read', () => fs.readFile(join(root, 'private/secret.txt')));
  await operation('outside-write', () => fs.writeFile(join(root, 'private/desktop.txt'), 'SYNTHETIC\n', { flag: 'wx' }));
  await operation('code-write', async () => { const file = await fs.open(join(root, 'package/module.mjs'), 'r+'); try { await file.write('X'); } finally { await file.close(); } });
  emit({ type: 'desktop-policy', pid: process.pid, operations });
  await app.whenReady();
  const ownSession = session.fromPartition('desktop-probe');
  ownSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  ownSession.setPermissionCheckHandler(() => false);
  ownSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  window = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: {
    preload: join(root, 'package/desktop-preload.cjs'), session: ownSession,
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, devTools: false
  } });
  const web = window.webContents;
  web.setWindowOpenHandler(() => ({ action: 'deny' }));
  web.on('will-navigate', event => event.preventDefault());
  web.on('will-attach-webview', event => event.preventDefault());
  web.on('render-process-gone', () => { emit({ type: 'desktop-phase', phase: 'renderer-gone' }); app.exit(3); });
  const ready = new Promise((resolve, reject) => ipcMain.once('probe:ready', (event, value) => {
    try {
      assert.equal(event.sender, web); assert.equal(event.senderFrame, web.mainFrame);
      assert.deepEqual(value, { sandboxed: true, contextIsolated: true, processType: 'renderer' });
      resolve(value);
    } catch (error) { reject(error); }
  }));
  await Promise.all([web.loadFile(join(root, 'package/desktop-probe.html')), ready]);
  const page = await web.executeJavaScript(`({nodeAbsent:typeof require==='undefined'&&typeof process==='undefined',text:document.body.textContent.trim()})`);
  assert.deepEqual(page, { nodeAbsent: true, text: 'Synthetic desktop isolation probe' });
  const preferences = web.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true);
  emit({ type: 'desktop-phase', phase: 'renderer-ready', pid: web.getOSProcessId(), sandboxed: true,
    contextIsolation: true, nodeIntegration: false, webSecurity: true, pageVerified: true });
  // Keep the ready renderer alive while the native host records Job members.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const metrics = app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, sandboxed: item.sandboxed ?? null }));
  assert(metrics.some(item => item.pid === process.pid)); assert(metrics.some(item => item.pid === web.getOSProcessId()));
  emit({ type: 'desktop-phase', phase: 'processes', metrics });
  ipcMain.removeAllListeners('probe:ready');
  window.destroy(); window = undefined;
  clearTimeout(deadline);
  emit({ type: 'desktop-phase', phase: 'complete' });
  app.exit(0);
}
run().catch(error => { emit({ type: 'desktop-phase', phase: 'error', name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 2048) }); clearTimeout(deadline); app.exit(1); });
