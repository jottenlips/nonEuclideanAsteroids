/**
 * 3D Asteroids for React VR (React 360)
 *
 * Game engine lives on the browser main thread (client.js). The arena is a
 * wireframe surface that changes shape each level (sphere, torus, teapot).
 * The player ship, asteroids and bullets slide across the surface using a
 * shared 2-coordinate (a, b) system. Crossing seams and poles wraps bodies
 * continuously.
 *
 * React renders the minimalist wireframe HUD to a floating 2D Surface, and the
 * game pushes state into it through the runtime bridge (GameHUD module).
 */

import {ReactInstance, Surface} from 'react-360-web';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const RADIUS = 60;                 // base arena scale (world units)
const PI = Math.PI;
const TWO_PI = 2 * PI;
const PI_HALF = PI / 2;

const TURN_RATE = 2.8;             // rad/s
const ACCEL = 0.52;                // heading-space acceleration (rad/s^2)
const MAX_VEL = 0.5;               // max angular speed (rad/s)
const DRAG = 0.16;                 // per second
const BULLET_SPEED = 2.6;          // rad/s along the surface
const BULLET_LIFE = 1.5;           // s
const FIRE_COOLDOWN = 0.24;        // s
const SHIP_RADIUS = 1.7;           // world units, collision hull
const RESPAWN_TIME = 2.0;          // s
const INVULN_TIME = 3.0;           // s
const START_LIVES = 3;
const SIZES = [4.2, 2.4, 1.25];    // asteroid radii per tier (world units)
const SCORES = [20, 50, 100];
const MIN_SPAWN_DIST = 33;         // min world-unit distance from ship
const HUD_SYNC_INTERVAL = 0.12;    // s
const CAM_HOVER = 1.6 * RADIUS;    // camera height above surface

// ---------------------------------------------------------------------------
// Arena shape registry
// ---------------------------------------------------------------------------

const TORUS_MAJOR = 100;
const TORUS_MINOR = 60;

// Smooth C1 bump: peaks at d=0, zero at d>=width, C1 at edges.
function _bump(d, width, height) {
  if (d >= width) {
    return 0;
  }
  const t = d / width;
  const c = Math.cos(t * PI_HALF);
  return height * c * c;
}

const SHAPES = [
  // --- Sphere ---
  {
    name: 'SPHERE',
    vHalf: PI_HALF,
    point(a, b, out) {
      const cb = Math.cos(b);
      out.set(RADIUS * cb * Math.cos(a), RADIUS * Math.sin(b), RADIUS * cb * Math.sin(a));
      return out;
    },
    tangent(a, b) {
      const ct = Math.cos(a);
      const st = Math.sin(a);
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      _n.set(cb * ct, sb, cb * st);
      _eT.set(-st, 0, ct);
      _eP.set(-sb * ct, cb, -sb * st);
    },
    wrap(body) {
      if (body.theta > PI) { body.theta -= TWO_PI; }
      else if (body.theta < -PI) { body.theta += TWO_PI; }
      if (body.phi > PI_HALF) {
        body.phi = PI - body.phi;
        body.theta = wrapAngle(body.theta + PI);
        body.vTheta = -body.vTheta;
        body.vPhi = -body.vPhi;
        if (body.heading !== undefined) { body.heading = wrapAngle(body.heading + PI); }
      } else if (body.phi < -PI_HALF) {
        body.phi = -PI - body.phi;
        body.theta = wrapAngle(body.theta + PI);
        body.vTheta = -body.vTheta;
        body.vPhi = -body.vPhi;
        if (body.heading !== undefined) { body.heading = wrapAngle(body.heading + PI); }
      }
    },
  },
  // --- Torus ---
  {
    name: 'TORUS',
    vHalf: PI,
    point(a, b, out) {
      const R = TORUS_MAJOR + TORUS_MINOR * Math.cos(b);
      out.set(R * Math.cos(a), R * Math.sin(a), TORUS_MINOR * Math.sin(b));
      return out;
    },
    tangent(a, b) {
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const R = TORUS_MAJOR + TORUS_MINOR * cb;
      _eT.set(-R * Math.sin(a), R * Math.cos(a), 0);
      _eP.set(-TORUS_MINOR * sb * Math.cos(a), -TORUS_MINOR * sb * Math.sin(a), TORUS_MINOR * cb);
      _n.crossVectors(_eT, _eP).normalize();
      _eT.normalize();
      _eP.normalize();
    },
    wrap(body) {
      if (body.theta > PI) { body.theta -= TWO_PI; }
      else if (body.theta < -PI) { body.theta += TWO_PI; }
      if (body.phi > PI) { body.phi -= TWO_PI; }
      else if (body.phi < -PI) { body.phi += TWO_PI; }
    },
  },
  // --- Teapot (sphere perturbation with spout + handle bumps) ---
  {
    name: 'TEAPOT',
    vHalf: PI_HALF,
    point(a, b, out) {
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      // Oblate body + flat bottom
      let d = -3.5 * Math.cos(2 * b);
      // Spout bump (east, upper half)
      d += _bump(Math.hypot(wrapAngle(a - 0.4), b - 0.45), 0.55, 16);
      // Handle bump (west, mid height)
      d += _bump(Math.hypot(wrapAngle(a - PI), b - 0.25), 0.5, 11);
      // Lid bulge (top)
      d += _bump(Math.hypot(a > PI ? a - TWO_PI : a, b - 1.15), 0.45, 6);
      const r = RADIUS + d;
      out.set(r * cb * Math.cos(a), r * sb, r * cb * Math.sin(a));
      return out;
    },
    tangent: null,  // finite differences
    wrap(body) {
      SHAPES[0].wrap(body);
    },
  },
];

let shapeIdx = 0;
let SHAPE = SHAPES[0];

// ---------------------------------------------------------------------------
// Reusable scratch objects (avoid allocation during the game loop)
// ---------------------------------------------------------------------------

const _Z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _eT = new THREE.Vector3();
const _eP = new THREE.Vector3();
const _eu = new THREE.Vector3();
const _ev = new THREE.Vector3();
const _F = new THREE.Vector3();
const _Rv = new THREE.Vector3();
const _Up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();
const _basisQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();

// Camera
const VIEW = {yaw: 0, pitch: 0.42, tYaw: 0, tPitch: 0.42};

const _upWorld = new THREE.Vector3(0, 1, 0);
const _camPosV = new THREE.Vector3();
const _smoothCam = new THREE.Vector3();
const _shipPosV = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _lookZ = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _lookUp = new THREE.Vector3();
const _camMat = new THREE.Matrix4();
const _camQuat = new THREE.Quaternion();

// Continuous camera frame (no flip when crossing poles / seams)
const _refT = new THREE.Vector3(0, 1, 0);
const _refE = new THREE.Vector3();
const _prevN = new THREE.Vector3(0, 1, 0);
const _stepQuat = new THREE.Quaternion();
let _refInit = false;

let dragPointer = null;
let lastMX = 0;
let lastMY = 0;

// Arena mesh references (swapped on shape change)
let arenaGroup = null;
let quadrantGroup = null;
let toggleBtn = null;

// ---------------------------------------------------------------------------
// Tiny synthesized audio (WebAudio, created on first user gesture)
// ---------------------------------------------------------------------------

const Audio = (() => {
  let ctx = null;
  let master = null;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') { ctx.resume(); }
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }

  function tone(freq, endFreq, dur, type, vol, when) {
    if (!ctx) { return; }
    const t0 = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) { osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur); }
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, when) {
    if (!ctx) { return; }
    const t0 = ctx.currentTime + (when || 0);
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { data[i] = (Math.random() * 2 - 1) * (1 - i / n); }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(gain);
    gain.connect(master);
    src.start(t0);
  }

  return {
    unlock: ensure,
    shoot() { ensure(); tone(920, 240, 0.12, 'square', 0.1); },
    explode() { ensure(); noise(0.3, 0.28); tone(170, 38, 0.35, 'sawtooth', 0.18); },
    die() { ensure(); noise(0.6, 0.4); tone(140, 28, 0.6, 'sawtooth', 0.28); },
    wave() { ensure(); tone(440, 440, 0.08, 'square', 0.09); tone(660, 660, 0.09, 'square', 0.09, 0.1); tone(880, 880, 0.12, 'square', 0.09, 0.2); },
  };
})();

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const G = {
  status: 'ready',
  score: 0,
  lives: START_LIVES,
  wave: 0,
  theta: 0,
  phi: 0.3,
  vTheta: 0,
  vPhi: 0,
  heading: 0,
  bank: 0,
  targetBank: 0,
  fireCd: 0,
  invuln: 0,
  respawnTimer: 0,
  startTimer: 1.3,
  msg: 'READY',
  msgTimer: 0,
};

let r360 = null;
let scene = null;
let shipMesh = null;
let engineMesh = null;
let bullets = [];
let asteroids = [];
let fx = [];

const keys = {};

// Virtual joystick state: turn in [-1,1] (right positive), thrust in [0,1].
const joy = { turn: 0, thrust: 0 };

let lastMs = 0;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function wrapAngle(a) {
  a = a % TWO_PI;
  if (a > PI) { a -= TWO_PI; }
  if (a < -PI) { a += TWO_PI; }
  return a;
}

// ---------------------------------------------------------------------------
// Surface abstraction (dispatches by current SHAPE)
// ---------------------------------------------------------------------------

function surfacePoint(a, b, out) {
  return SHAPE.point(a, b, out);
}

function tangentFrame(a, b) {
  if (SHAPE.tangent) {
    SHAPE.tangent(a, b);
  } else {
    // Finite-difference tangent for shapes without analytic version
    const eps = 1e-5;
    SHAPE.point(a + eps, b, _tmp);
    SHAPE.point(a - eps, b, _tmp2);
    _eu.subVectors(_tmp, _tmp2).normalize();
    SHAPE.point(a, b + eps, _tmp);
    SHAPE.point(a, b - eps, _tmp2);
    _ev.subVectors(_tmp, _tmp2).normalize();
    _n.crossVectors(_eu, _ev).normalize();
    _eT.copy(_eu);
    _eP.copy(_ev);
  }
}

function wrapBody(body) {
  SHAPE.wrap(body);
}

function spawnDistOK(theta, phi) {
  surfacePoint(G.theta, G.phi, _tmp);
  surfacePoint(theta, phi, _tmp2);
  return _tmp.distanceTo(_tmp2) > MIN_SPAWN_DIST;
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/**
 * Orient an object on the surface: local +Z is the tangent heading,
 * local +Y is the outward normal. Optional `bank` rolls it around heading.
 */
function placeOriented(mesh, body) {
  tangentFrame(body.theta, body.phi);

  const sh = Math.sin(body.heading);
  const ch = Math.cos(body.heading);
  _F.copy(_eT).multiplyScalar(sh).addScaledVector(_eP, ch).normalize();

  _Rv.crossVectors(_n, _F).normalize();
  _Up.crossVectors(_F, _Rv).normalize();

  _basisMat.makeBasis(_Rv, _Up, _F);
  _basisQuat.setFromRotationMatrix(_basisMat);
  if (body.bank) {
    _rollQuat.setFromAxisAngle(_Z, body.bank);
    _basisQuat.multiply(_rollQuat);
  }
  mesh.quaternion.copy(_basisQuat);
  surfacePoint(body.theta, body.phi, _pos);
  mesh.position.copy(_pos);
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

function pointsToGeo(pts) {
  const arr = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    arr[i * 3] = pts[i].x;
    arr[i * 3 + 1] = pts[i].y;
    arr[i * 3 + 2] = pts[i].z;
  }
  const g = new THREE.BufferGeometry();
  g.addAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

function buildArenaGrid() {
  const grid = new THREE.Group();
  const matDim = new THREE.LineBasicMaterial({color: 0x14404d, transparent: true, opacity: 0.6});
  const matPrime = new THREE.LineBasicMaterial({color: 0x2c6f80, transparent: true, opacity: 0.8});
  const matEq = new THREE.LineBasicMaterial({color: 0x3d95a8, transparent: true, opacity: 0.85});

  const uCount = 16;
  const vCount = 8;
  const vMin = -SHAPE.vHalf;
  const vMax = SHAPE.vHalf;

  // Constant-a lines (meridians / tube circles)
  for (let i = 0; i < uCount; i++) {
    const u = (i / uCount) * TWO_PI;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const v = vMin + ((vMax - vMin) * k) / 64;
      pts.push(SHAPE.point(u, v, new THREE.Vector3()));
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), i === 0 ? matPrime : matDim));
  }

  // Constant-b lines (parallels / major rings)
  for (let i = 1; i < vCount; i++) {
    const v = vMin + ((vMax - vMin) * i) / vCount;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const u = (k / 64) * TWO_PI;
      pts.push(SHAPE.point(u, v, new THREE.Vector3()));
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), matDim));
  }

  // Equator
  const eq = [];
  for (let k = 0; k <= 64; k++) {
    eq.push(SHAPE.point((k / 64) * TWO_PI, 0, new THREE.Vector3()));
  }
  grid.add(new THREE.LineLoop(pointsToGeo(eq), matEq));

  return grid;
}

// Quadrant fill colors (NE/NW/SE/SW)
const QUADRANT_COLORS = [0x3ad6ff, 0x3dffa5, 0xff9d3d, 0xc14dff];

function quadrantColor(a, b) {
  const north = b >= 0;
  const east = Math.cos(a) >= 0;
  if (north) { return east ? QUADRANT_COLORS[0] : QUADRANT_COLORS[1]; }
  return east ? QUADRANT_COLORS[2] : QUADRANT_COLORS[3];
}

function buildQuadrantMesh(u0, u1, v0, v1, color) {
  const SEG = 24;
  const vertices = [];
  const indices = [];
  const n = SEG + 1;
  const off = 0.6;
  for (let i = 0; i <= SEG; i++) {
    const v = v0 + ((v1 - v0) * i) / SEG;
    for (let j = 0; j <= SEG; j++) {
      const u = u0 + ((u1 - u0) * j) / SEG;
      SHAPE.point(u, v, _tmp);
      tangentFrame(u, v);
      vertices.push(_tmp.x + _n.x * off, _tmp.y + _n.y * off, _tmp.z + _n.z * off);
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * n + j;
      const b = a + 1;
      const c = (i + 1) * n + j;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.addAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.renderOrder = -10;
  return m;
}

function buildQuadrants() {
  const group = new THREE.Group();
  const h = PI_HALF;
  const vh = SHAPE.vHalf;
  group.add(buildQuadrantMesh(-h, h, 0, vh, QUADRANT_COLORS[0]));
  group.add(buildQuadrantMesh(h, 3 * h, 0, vh, QUADRANT_COLORS[1]));
  group.add(buildQuadrantMesh(-h, h, -vh, 0, QUADRANT_COLORS[2]));
  group.add(buildQuadrantMesh(h, 3 * h, -vh, 0, QUADRANT_COLORS[3]));
  return group;
}

function rebuildArena() {
  if (arenaGroup) { scene.remove(arenaGroup); }
  if (quadrantGroup) { scene.remove(quadrantGroup); }
  arenaGroup = buildArenaGrid();
  quadrantGroup = buildQuadrants();
  scene.add(arenaGroup);
  scene.add(quadrantGroup);
}

function buildStars(count, rMin, rMax, color, size) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x = Math.random() * 2 - 1;
    let y = Math.random() * 2 - 1;
    let z = Math.random() * 2 - 1;
    const l = Math.hypot(x, y, z) || 1;
    const r = rMin + Math.random() * (rMax - rMin);
    pos[i * 3] = (x / l) * r;
    pos[i * 3 + 1] = (y / l) * r;
    pos[i * 3 + 2] = (z / l) * r;
  }
  const g = new THREE.BufferGeometry();
  g.addAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({
    color, size, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false,
  }));
}

function buildShip() {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({color: 0xaef4f4, transparent: true, opacity: 0.95});
  const edges = [
    [[0, 0, 4.2], [-3, 0, -1]],
    [[0, 0, 4.2], [3, 0, -1]],
    [[-3, 0, -1], [0, 0, -3.2]],
    [[3, 0, -1], [0, 0, -3.2]],
    [[0, 0, 4.2], [0, 0, -3.2]],
    [[-3, 0, -1], [0, 0, -0.8]],
    [[3, 0, -1], [0, 0, -0.8]],
    [[0, 0, -0.8], [0, 0, -3.2]],
    [[0, 0, 4.2], [0, 0, 5.6]],
    [[-0.7, 0, -3.2], [0.7, 0, -3.2]],
  ];
  const pts = [];
  for (const e of edges) {
    pts.push(new THREE.Vector3(e[0][0], e[0][1], e[0][2]));
    pts.push(new THREE.Vector3(e[1][0], e[1][1], e[1][2]));
  }
  group.add(new THREE.LineSegments(pointsToGeo(pts), mat));

  const engMat = new THREE.LineBasicMaterial({color: 0xffb45c, transparent: true, opacity: 0.9});
  engineMesh = new THREE.LineSegments(pointsToGeo([
    new THREE.Vector3(0, 0, -3.2),
    new THREE.Vector3(0, 0, -4.4),
  ]), engMat);
  engineMesh.visible = false;
  group.add(engineMesh);

  return group;
}

function makeAsteroidMesh() {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < geo.vertices.length; i++) {
    const v = geo.vertices[i];
    const r = 0.72 + 0.42 * Math.random() * Math.random();
    v.normalize().multiplyScalar(r);
  }
  const wire = new THREE.WireframeGeometry(geo);
  const mat = new THREE.LineBasicMaterial({color: 0xc6d3db, transparent: true, opacity: 0.9});
  return new THREE.LineSegments(wire, mat);
}

const bulletWire = new THREE.WireframeGeometry(new THREE.OctahedronGeometry(0.5, 0));
const bulletMat = new THREE.LineBasicMaterial({color: 0xffd98a, transparent: true, opacity: 1});

function buildRingGeometry() {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * TWO_PI;
    pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  return pointsToGeo(pts);
}
const ringGeo = buildRingGeometry();

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

function setMsg(text, t) {
  G.msg = text;
  G.msgTimer = t;
}

function resetGame() {
  for (const b of bullets) { scene.remove(b.mesh); }
  bullets = [];
  for (const a of asteroids) { scene.remove(a.mesh); }
  asteroids = [];
  for (const f of fx) { scene.remove(f.mesh); }
  fx = [];

  shapeIdx = 0;
  SHAPE = SHAPES[0];

  G.status = 'playing';
  G.score = 0;
  G.lives = START_LIVES;
  G.wave = 0;
  G.vTheta = 0;
  G.vPhi = 0;
  G.heading = 0.6;
  G.bank = 0;
  G.targetBank = 0;
  G.fireCd = 0;
  G.invuln = INVULN_TIME;
  G.respawnTimer = 0;
  G.startTimer = 1.3;
  setMsg('READY', 1.3);
  respawnShip();
  _refInit = false;
  computeCamera();
  _smoothCam.copy(_camPosV);
  if (arenaGroup) { scene.remove(arenaGroup); }
  if (quadrantGroup) { scene.remove(quadrantGroup); }
  rebuildArena();
  updateToggleLabel();
}

function respawnShip() {
  G.theta = 0;
  G.phi = 0.3;
  G.vTheta = 0;
  G.vPhi = 0;
  G.heading = 0.6;
  G.bank = 0;
  G.targetBank = 0;
  G.invuln = INVULN_TIME;
  placeOriented(shipMesh, G);
  shipMesh.visible = true;
}

function beginWave() {
  G.wave++;
  // Cycle shape each level
  shapeIdx = (G.wave - 1) % SHAPES.length;
  SHAPE = SHAPES[shapeIdx];
  rebuildArena();
  wrapBody(G);
  _refInit = false;
  computeCamera();
  _smoothCam.copy(_camPosV);
  updateToggleLabel();

  const count = Math.min(3 + G.wave, 11);
  for (let i = 0; i < count; i++) {
    spawnAsteroid(0);
  }
  setMsg('WAVE ' + G.wave + ' - ' + SHAPE.name, 1.8);
  Audio.wave();
}

function spawnAsteroid(tier) {
  let theta = 0;
  let phi = 0;
  for (let tries = 0; tries < 40; tries++) {
    theta = (Math.random() * 2 - 1) * PI;
    phi = (Math.random() * 2 - 1) * SHAPE.vHalf;
    if (spawnDistOK(theta, phi)) {
      break;
    }
  }
  const mesh = makeAsteroidMesh();
  mesh.scale.setScalar(SIZES[tier]);
  mesh.material.color.setHex(quadrantColor(theta, phi));
  const a = {
    theta,
    phi,
    vTheta: (Math.random() * 2 - 1) * 0.055,
    vPhi: (Math.random() * 2 - 1) * 0.055,
    tier,
    radius: SIZES[tier],
    mesh,
    spinAxis: new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize(),
    spinSpeed: 0.4 + Math.random() * 0.9,
  };
  asteroids.push(a);
  scene.add(mesh);
  return a;
}

function removeAsteroid(a) {
  const idx = asteroids.indexOf(a);
  if (idx >= 0) { asteroids.splice(idx, 1); }
  scene.remove(a.mesh);
}

function fireBullet() {
  Audio.shoot();
  const b = {
    theta: G.theta + Math.sin(G.heading) * 0.05,
    phi: G.phi + Math.cos(G.heading) * 0.05,
    heading: G.heading,
    life: BULLET_LIFE,
    mesh: new THREE.LineSegments(bulletWire, bulletMat),
  };
  bullets.push(b);
  scene.add(b.mesh);
  placeOriented(b.mesh, b);
}

function spawnRing(theta, phi, color, opts) {
  const mat = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.9});
  const mesh = new THREE.LineLoop(ringGeo, mat);
  surfacePoint(theta, phi, _pos);
  mesh.position.copy(_pos);
  tangentFrame(theta, phi);
  mesh.quaternion.setFromUnitVectors(_Z, _n);
  scene.add(mesh);
  fx.push({mesh, mat, life: opts.life, maxLife: opts.life, grow: opts.grow});
}

function hitAsteroid(bullet, asteroid) {
  G.score += SCORES[asteroid.tier];
  Audio.explode();
  spawnRing(asteroid.theta, asteroid.phi, 0x9ff2ff, {life: 0.35, grow: 26});

  const tier = asteroid.tier + 1;
  if (tier < SIZES.length) {
    const ba = bullet.heading;
    for (const off of [0.9, -0.9]) {
      const child = spawnAsteroid(tier);
      child.theta = asteroid.theta;
      child.phi = asteroid.phi;
      child.vTheta = asteroid.vTheta + Math.sin(ba + off) * 0.18;
      child.vPhi = asteroid.vPhi + Math.cos(ba + off) * 0.18;
      child.theta += Math.sin(ba + off) * 0.05;
      child.phi += Math.cos(ba + off) * 0.05;
    }
  }
  removeAsteroid(asteroid);

  if (asteroids.length === 0 && G.status === 'playing') {
    setMsg('WAVE CLEAR', 1.2);
    G.startTimer = 1.3;
  }
}

function killShip() {
  if (G.invuln > 0) { return; }
  Audio.die();
  spawnRing(G.theta, G.phi, 0xff6b6b, {life: 0.6, grow: 34});
  shipMesh.visible = false;
  G.lives--;
  if (G.lives < 0) {
    G.status = 'over';
    G.msg = 'GAME OVER - PRESS R TO RESTART';
  } else {
    setMsg('SHIP DESTROYED', 1.6);
    G.respawnTimer = RESPAWN_TIME;
  }
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.life -= dt;
    const s = 0.4 + (1 - f.life / f.maxLife) * f.grow;
    f.mesh.scale.setScalar(Math.max(0.01, s));
    f.mat.opacity = 0.9 * Math.max(0, f.life / f.maxLife);
    if (f.life <= 0) {
      scene.remove(f.mesh);
      fx.splice(i, 1);
    }
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.theta += Math.sin(b.heading) * BULLET_SPEED * dt;
    b.phi += Math.cos(b.heading) * BULLET_SPEED * dt;
    wrapBody(b);
    placeOriented(b.mesh, b);
    if (b.life <= 0) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }
}

function updateAsteroids(dt) {
  for (const a of asteroids) {
    a.theta += a.vTheta * dt;
    a.phi += a.vPhi * dt;
    wrapBody(a);
    a.mesh.material.color.setHex(quadrantColor(a.theta, a.phi));
    surfacePoint(a.theta, a.phi, _pos);
    a.mesh.position.copy(_pos);
    _spinQ.setFromAxisAngle(a.spinAxis, a.spinSpeed * dt);
    a.mesh.quaternion.multiply(_spinQ);
  }
}

function handleCollisions() {
  if (asteroids.length === 0) { return; }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    surfacePoint(b.theta, b.phi, _tmp);
    for (let j = asteroids.length - 1; j >= 0; j--) {
      const a = asteroids[j];
      surfacePoint(a.theta, a.phi, _tmp2);
      const rr = a.radius + 0.6;
      if (_tmp.distanceToSquared(_tmp2) < rr * rr) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
        hitAsteroid(b, a);
        break;
      }
    }
  }

  if (G.status === 'playing' && G.respawnTimer <= 0 && G.invuln <= 0) {
    surfacePoint(G.theta, G.phi, _tmp);
    for (const a of asteroids) {
      surfacePoint(a.theta, a.phi, _tmp2);
      const rr = a.radius + SHIP_RADIUS;
      if (_tmp.distanceToSquared(_tmp2) < rr * rr) {
        killShip();
        break;
      }
    }
  }
}

function update(dt) {
  if (dt <= 0) { return; }

  if (G.msgTimer > 0) {
    G.msgTimer -= dt;
    if (G.msgTimer <= 0) { G.msg = ''; }
  }

  if (G.startTimer > 0) {
    G.startTimer -= dt;
    if (G.startTimer <= 0 && G.status === 'playing') {
      beginWave();
    }
  }

  if (G.status === 'over') {
    updateFx(dt);
    return;
  }

  if (G.respawnTimer > 0) {
    G.respawnTimer -= dt;
    if (G.respawnTimer <= 0) { respawnShip(); }
  }
  if (G.invuln > 0) { G.invuln -= dt; }

  const shipAlive = G.respawnTimer <= 0;

  if (shipAlive) {
    const kbLeft = !!(keys.ArrowLeft || keys.a);
    const kbRight = !!(keys.ArrowRight || keys.d);
    const kbUp = !!(keys.ArrowUp || keys.w);
    const jT = joy.turn;
    const jU = joy.thrust;
    const left = kbLeft || jT < -0.12;
    const right = kbRight || jT > 0.12;
    const up = kbUp || jU > 0.12;

    if (left) {
      const amt = kbLeft ? 1 : Math.min(1, -jT);
      G.heading -= TURN_RATE * amt * dt;
      G.targetBank = -0.5 * amt;
    } else if (right) {
      const amt = kbRight ? 1 : Math.min(1, jT);
      G.heading += TURN_RATE * amt * dt;
      G.targetBank = 0.5 * amt;
    } else {
      G.targetBank = 0;
    }
    G.heading = wrapAngle(G.heading);
    G.bank += (G.targetBank - G.bank) * Math.min(1, dt * 7);

    if (up) {
      const amt = kbUp ? 1 : Math.min(1, jU);
      G.vTheta += Math.sin(G.heading) * ACCEL * amt * dt;
      G.vPhi += Math.cos(G.heading) * ACCEL * amt * dt;
    }
    const spd = Math.hypot(G.vTheta, G.vPhi);
    if (spd > MAX_VEL) {
      G.vTheta *= MAX_VEL / spd;
      G.vPhi *= MAX_VEL / spd;
    }
    const damp = Math.exp(-DRAG * dt);
    G.vTheta *= damp;
    G.vPhi *= damp;

    G.theta += G.vTheta * dt;
    G.phi += G.vPhi * dt;
    wrapBody(G);

    G.fireCd -= dt;
    if (keys[' '] && G.fireCd <= 0) {
      fireBullet();
      G.fireCd = FIRE_COOLDOWN;
    }

    placeOriented(shipMesh, G);
    engineMesh.visible = !!up;
    const blink = G.invuln > 0 && Math.floor(G.invuln * 8) % 2 === 0;
    shipMesh.visible = !blink;
  } else {
    shipMesh.visible = false;
  }

  updateBullets(dt);
  updateAsteroids(dt);
  handleCollisions();
  updateFx(dt);
}

// ---------------------------------------------------------------------------
// Camera: hovers above the ship along the surface normal
// ---------------------------------------------------------------------------

function computeCamera() {
  surfacePoint(G.theta, G.phi, _shipPosV);
  tangentFrame(G.theta, G.phi);

  if (!_refInit) {
    _refT.copy(_upWorld).addScaledVector(_n, -_upWorld.dot(_n));
    if (_refT.lengthSq() < 1e-6) { _refT.set(0, 0, 1); }
    _refT.normalize();
    _prevN.copy(_n);
    _refInit = true;
  } else {
    _stepQuat.setFromUnitVectors(_prevN, _n);
    _refT.applyQuaternion(_stepQuat);
    _refT.addScaledVector(_n, -_refT.dot(_n));
    _refT.normalize();
    _prevN.copy(_n);
  }
  _refE.crossVectors(_n, _refT).normalize();

  const vp = VIEW.pitch;
  const vy = VIEW.yaw;
  const cpy = Math.cos(vp);
  const spy = Math.sin(vp);
  const cy = Math.cos(vy);
  const sy = Math.sin(vy);

  _camDir.copy(_n).multiplyScalar(cpy)
    .addScaledVector(_refT, spy * cy)
    .addScaledVector(_refE, spy * sy)
    .normalize();
  _camPosV.copy(_shipPosV).addScaledVector(_n, CAM_HOVER);
}

// ---------------------------------------------------------------------------
// Frame loop + input
// ---------------------------------------------------------------------------

function onFrame(ms) {
  const dt = lastMs === 0 ? 0 : Math.min((ms - lastMs) / 1000, 0.05);
  lastMs = ms;

  VIEW.yaw += (VIEW.tYaw - VIEW.yaw) * Math.min(1, dt * 10);
  VIEW.pitch += (VIEW.tPitch - VIEW.pitch) * Math.min(1, dt * 10);

  update(dt);
  computeCamera();

  _smoothCam.lerp(_camPosV, Math.min(1, dt * 8));

  _lookZ.subVectors(_smoothCam, _shipPosV).normalize();
  _lookUp.copy(_refT).addScaledVector(_lookZ, -_refT.dot(_lookZ));
  if (_lookUp.lengthSq() < 1e-6) { _lookUp.copy(_refT); }
  _lookUp.normalize();
  _camRight.crossVectors(_lookUp, _lookZ).normalize();
  _lookUp.crossVectors(_lookZ, _camRight).normalize();
  _camMat.makeBasis(_camRight, _lookUp, _lookZ);
  _camQuat.setFromRotationMatrix(_camMat);

  r360._cameraPosition[0] = _smoothCam.x;
  r360._cameraPosition[1] = _smoothCam.y;
  r360._cameraPosition[2] = _smoothCam.z;
  r360._cameraQuat[0] = _camQuat.x;
  r360._cameraQuat[1] = _camQuat.y;
  r360._cameraQuat[2] = _camQuat.z;
  r360._cameraQuat[3] = _camQuat.w;
}

function keyName(e) {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

function onKeyDown(e) {
  Audio.unlock();
  const k = keyName(e);
  if (k === ' ' || k.indexOf('Arrow') === 0) { e.preventDefault(); }
  keys[k] = true;
  if (k === 'r' && G.status === 'over') { resetGame(); }
  if (k === 't') { toggleGeometry(); }
}

function onKeyUp(e) {
  keys[keyName(e)] = false;
}

function onBlur() {
  for (const k in keys) { keys[k] = false; }
}

function onPointerDown(e) {
  Audio.unlock();
  if (e.pointerType === 'touch') { e.preventDefault(); }
  if (dragPointer !== null) { return; }
  if (e.target && e.target.closest && e.target.closest('#r360-ui-controls')) { return; }
  dragPointer = e.pointerId;
  lastMX = e.clientX;
  lastMY = e.clientY;
}

function onPointerMove(e) {
  if (dragPointer !== e.pointerId) { return; }
  const dx = e.clientX - lastMX;
  const dy = e.clientY - lastMY;
  lastMX = e.clientX;
  lastMY = e.clientY;
  VIEW.tYaw -= dx * 0.008;
  VIEW.tPitch = Math.max(0.05, Math.min(1.35, VIEW.tPitch - dy * 0.008));
}

function onPointerUp(e) {
  if (dragPointer === e.pointerId) { dragPointer = null; }
}

// ---------------------------------------------------------------------------
// Shape toggle (T key + on-screen button)
// ---------------------------------------------------------------------------

function updateToggleLabel() {
  if (toggleBtn) {
    toggleBtn.innerText = SHAPE.name;
  }
}

function toggleGeometry() {
  shapeIdx = (shapeIdx + 1) % SHAPES.length;
  SHAPE = SHAPES[shapeIdx];
  rebuildArena();
  wrapBody(G);
  for (const a of asteroids) {
    wrapBody(a);
    a.mesh.material.color.setHex(quadrantColor(a.theta, a.phi));
  }
  for (const b of bullets) { wrapBody(b); }
  _refInit = false;
  computeCamera();
  _smoothCam.copy(_camPosV);
  updateToggleLabel();
}

function buildUiControls() {
  const wrap = document.createElement('div');
  wrap.id = 'r360-ui-controls';
  wrap.style.cssText =
    'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:110;pointer-events:none;';

  const btn = document.createElement('div');
  btn.innerText = SHAPE.name;
  btn.style.cssText =
    'pointer-events:auto;cursor:pointer;touch-action:none;-webkit-user-select:none;' +
    'user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;' +
    'padding:5px 14px;border-radius:999px;border:2px solid rgba(255,255,255,0.3);' +
    'background:rgba(0,0,0,0.25);color:#cfeeff;font:700 12px/1 monospace;letter-spacing:1px;';
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleGeometry();
  });
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
  toggleBtn = btn;
}

// ---------------------------------------------------------------------------
// Touch controls (joystick + fire button)
// ---------------------------------------------------------------------------

function buildTouchControls() {
  const isTouch =
    ('ontouchstart' in window) ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (!isTouch) { return; }

  const JOY_SIZE = 148;
  const R = 56;
  const KS = 64;
  const knobOff = (JOY_SIZE - KS) / 2;

  const wrap = document.createElement('div');
  wrap.id = 'r360-touch-controls';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;';

  const joyBase = document.createElement('div');
  joyBase.style.cssText =
    'position:absolute;left:22px;bottom:22px;width:' + JOY_SIZE +
    'px;height:' + JOY_SIZE + 'px;border-radius:50%;' +
    'background:rgba(255,255,255,0.07);border:2px solid rgba(255,255,255,0.22);' +
    'pointer-events:auto;touch-action:none;-webkit-user-select:none;' +
    'user-select:none;-webkit-touch-callout:none;';

  const knob = document.createElement('div');
  knob.style.cssText =
    'position:absolute;left:' + knobOff + 'px;top:' + knobOff +
    'px;width:' + KS + 'px;height:' + KS + 'px;border-radius:50%;' +
    'background:rgba(255,255,255,0.32);border:2px solid rgba(255,255,255,0.5);';
  joyBase.appendChild(knob);

  const fireBtn = document.createElement('div');
  fireBtn.innerText = 'FIRE';
  fireBtn.style.cssText =
    'position:absolute;right:22px;bottom:22px;width:112px;height:112px;' +
    'border-radius:50%;background:rgba(220,30,30,0.30);' +
    'border:3px solid rgba(255,70,70,0.75);color:#fff;' +
    'font-weight:700;font-size:18px;letter-spacing:2px;' +
    'display:flex;align-items:center;justify-content:center;' +
    'pointer-events:auto;touch-action:none;-webkit-user-select:none;' +
    'user-select:none;-webkit-touch-callout:none;' +
    '-webkit-tap-highlight-color:transparent;';

  wrap.appendChild(joyBase);
  wrap.appendChild(fireBtn);
  document.body.appendChild(wrap);

  let joyPointer = null;

  function setKnob(clientX, clientY) {
    const rect = joyBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > R) { dx *= R / dist; dy *= R / dist; }
    knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    joy.turn = Math.abs(dx) / R;
    joy.thrust = Math.max(0, -dy) / R;
    if (dx < 0) { joy.turn = -joy.turn; }
    if (joy.turn === 0 && joy.thrust === 0) {
      keys.ArrowLeft = false;
      keys.ArrowRight = false;
      keys.ArrowUp = false;
    }
  }

  function joyMove(e) {
    if (e.pointerId !== joyPointer) { return; }
    setKnob(e.clientX, e.clientY);
  }

  joyBase.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); Audio.unlock();
    joyPointer = e.pointerId;
    try { joyBase.setPointerCapture(e.pointerId); } catch (err) {}
    setKnob(e.clientX, e.clientY);
  });
  joyBase.addEventListener('pointermove', joyMove);
  joyBase.addEventListener('pointercancel', joyEnd);
  joyBase.addEventListener('lostpointercapture', joyEnd);

  function joyEnd(e) {
    if (e.pointerId !== joyPointer) { return; }
    joyPointer = null;
    joy.turn = 0;
    joy.thrust = 0;
    keys.ArrowLeft = false;
    keys.ArrowRight = false;
    keys.ArrowUp = false;
    knob.style.transform = 'translate(0px,0px)';
  }

  joyBase.addEventListener('pointerup', joyEnd);

  let firePointer = null;

  function fireStart(e) {
    e.preventDefault(); e.stopPropagation(); Audio.unlock();
    firePointer = e.pointerId;
    try { fireBtn.setPointerCapture(e.pointerId); } catch (err) {}
    keys[' '] = true;
  }

  function fireEnd(e) {
    if (e.pointerId !== firePointer) { return; }
    firePointer = null;
    keys[' '] = false;
  }

  fireBtn.addEventListener('pointerdown', fireStart);
  fireBtn.addEventListener('pointerup', fireEnd);
  fireBtn.addEventListener('pointercancel', fireEnd);
  fireBtn.addEventListener('lostpointercapture', fireEnd);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function init(bundle, parent, options = {}) {
  r360 = new ReactInstance(bundle, parent, {
    fullScreen: true,
    ...options,
    frame: onFrame,
  });

  scene = r360.scene;
  rebuildArena();
  scene.add(buildStars(1100, 720, 1400, 0xffffff, 1.6));
  scene.add(buildStars(70, 720, 1400, 0x8ff7ff, 3.2));

  shipMesh = buildShip();
  scene.add(shipMesh);

  computeCamera();
  _smoothCam.copy(_camPosV);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  buildUiControls();
  buildTouchControls();

  resetGame();
  r360.start();
}

window.React360 = {init};
