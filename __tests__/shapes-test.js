/**
 * Headless puppeteer tests for arena shapes.
 *
 * The React HUD renders to a canvas, not DOM. We test observable DOM state:
 *  - #r360-ui-controls exists and shape label changes on T key
 *  - Game does not crash on keyboard input or shape toggle
 *  - No console errors (no thrown exceptions in the engine)
 */

const puppeteer = import('puppeteer-core');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 8099;
const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const HTML_PATH = path.resolve(DOCS_DIR, 'index.html');
const BUNDLE_PATH = path.resolve(DOCS_DIR, 'client.bundle.js');
const INDEX_BUNDLE_PATH = path.resolve(DOCS_DIR, 'index.bundle.js');

let server;
let browser;
let page;

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      let filePath;
      if (url === '/' || url === '/index.html') {
        filePath = HTML_PATH;
      } else if (url === '/client.bundle.js') {
        filePath = BUNDLE_PATH;
      } else if (url === '/index.bundle.js') {
        filePath = INDEX_BUNDLE_PATH;
      } else if (url.startsWith('/static_assets/')) {
        filePath = path.join(DOCS_DIR, url);
      } else {
        res.writeHead(404);
        res.end('Not found: ' + url);
        return;
      }
      const ext = path.extname(filePath);
      const ct = ext === '.js' ? 'application/javascript' : 'text/html';
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {'Content-Type': ct});
        res.end(data);
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    server.listen(PORT, resolve);
    server.on('error', reject);
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (server) { server.close(resolve); } else { resolve(); }
  });
}

async function pressKey(key) {
  await page.keyboard.press(key);
  await new Promise(r => setTimeout(r, 300));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  PASS: ' + msg);
  } else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

async function getShapeLabel() {
  return page.evaluate(() => {
    const el = document.querySelector('#r360-ui-controls div');
    return el ? el.innerText : '';
  });
}

async function testGameInitNoErrors(errors) {
  console.log('\n[1] Game initializes without errors');
  // Wait for WebGL canvas to appear (React 360 creates it)
  const hasCanvas = await page.evaluate(() => {
    return !!document.querySelector('canvas');
  });
  assert(hasCanvas, 'WebGL canvas created');

  // UI controls should exist (added by client.js init)
  const hasUiControls = await page.evaluate(() => {
    return !!document.querySelector('#r360-ui-controls');
  });
  assert(hasUiControls, '#r360-ui-controls exists in DOM');

  // Shape label should be SPHERE at start
  const label = await getShapeLabel();
  assert(label === 'SPHERE', 'Initial shape label is SPHERE (got: ' + label + ')');

  // No JS errors during init
  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('404')
  );
  assert(criticalErrors.length === 0, 'No critical JS errors during init' +
    (criticalErrors.length > 0 ? ' (got: ' + criticalErrors.join('; ') + ')' : ''));
}

async function testToggleTorus(errors) {
  console.log('\n[2] Press T -> TORUS');
  const errorsBefore = errors.length;
  await pressKey('t');

  const label = await getShapeLabel();
  assert(label === 'TORUS', 'Shape label shows TORUS (got: ' + label + ')');

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors during TORUS toggle' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testToggleTeapot(errors) {
  console.log('\n[3] Press T -> TEAPOT');
  const errorsBefore = errors.length;
  await pressKey('t');

  const label = await getShapeLabel();
  assert(label === 'TEAPOT', 'Shape label shows TEAPOT (got: ' + label + ')');

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors during TEAPOT toggle' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testToggleWrapsToSphere(errors) {
  console.log('\n[4] Press T -> wraps to SPHERE');
  const errorsBefore = errors.length;
  await pressKey('t');

  const label = await getShapeLabel();
  assert(label === 'SPHERE', 'Shape wraps to SPHERE (got: ' + label + ')');

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors wrapping to SPHERE' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testKeyboardThrustAndFire(errors) {
  console.log('\n[5] Keyboard controls (thrust + fire)');
  const errorsBefore = errors.length;

  // Thrust
  await page.keyboard.down('w');
  await sleep(300);
  await page.keyboard.up('w');

  // Turn left
  await page.keyboard.down('a');
  await sleep(200);
  await page.keyboard.up('a');

  // Turn right
  await page.keyboard.down('d');
  await sleep(200);
  await page.keyboard.up('d');

  // Fire
  await page.keyboard.press(' ');
  await sleep(100);
  await page.keyboard.press(' ');
  await sleep(100);

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors during keyboard controls' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testToggleMidPlay(errors) {
  console.log('\n[6] Toggle shape mid-game (rapid toggles)');
  const errorsBefore = errors.length;

  // Rapid toggle through all shapes twice
  for (let i = 0; i < 6; i++) {
    await pressKey('t');
  }

  // Should be back to SPHERE
  const label = await getShapeLabel();
  assert(label === 'SPHERE', 'Rapid toggles land back on SPHERE (got: ' + label + ')');

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors during rapid toggles' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testRestart(errors) {
  console.log('\n[7] R key during play (no-op, should not crash)');
  const errorsBefore = errors.length;

  await pressKey('r');
  await sleep(300);

  const newErrors = errors.slice(errorsBefore);
  assert(newErrors.length === 0, 'No errors pressing R during play' +
    (newErrors.length > 0 ? ' (got: ' + newErrors.join('; ') + ')' : ''));
}

async function testToggleButtonClickable() {
  console.log('\n[8] Shape toggle button is clickable');
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#r360-ui-controls div');
    if (!btn) return false;
    btn.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    return true;
  });
  assert(clicked, 'Button pointerdown dispatched');

  await sleep(300);
  const label = await getShapeLabel();
  assert(label === 'TORUS', 'Button click toggled to TORUS (got: ' + label + ')');
}

async function run() {
  const {default: pup} = await puppeteer;
  console.log('Starting headless shape tests...');
  console.log('Serving from: ' + DOCS_DIR);

  await startServer();
  console.log('Server running on port ' + PORT);

  browser = await pup.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-angle=swiftshader',
      '--disable-web-security',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  page = await browser.newPage();
  await page.setViewport({width: 1280, height: 720});

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:' + PORT + '/index.html', {
    waitUntil: 'networkidle0',
    timeout: 15000,
  });

  // Wait for game to initialize
  await sleep(3000);

  try {
    await testGameInitNoErrors(errors);
    await testToggleTorus(errors);
    await testToggleTeapot(errors);
    await testToggleWrapsToSphere(errors);
    await testKeyboardThrustAndFire(errors);
    await testToggleMidPlay(errors);
    await testRestart(errors);
    await testToggleButtonClickable();
  } catch (e) {
    failed++;
    console.log('  FAIL (exception): ' + e.message);
    console.log('  Stack: ' + e.stack);
  }

  console.log('\n========== Results ==========');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  console.log('Total:  ' + (passed + failed));

  await browser.close();
  await stopServer();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  if (browser) browser.close().catch(() => {});
  stopServer().catch(() => {});
  process.exit(1);
});
