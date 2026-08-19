/**
 * 3D Asteroids for React VR (React 360)
 *
 * Game engine lives on the browser main thread (client.js). The arena is a
 * wireframe surface that changes shape each level (plane, sphere, torus, pseudosphere, ellipsoid).
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
const ACCEL = 0.8;                 // heading-space acceleration (rad/s^2)
const MAX_VEL = 0.7;               // max angular speed (rad/s)
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

// Power-ups
const POWERUP_TYPES = [
  {name: 'LIFE',     emoji: '🚀', color: '#5eff5e'},
  {name: 'TRIPLE',   emoji: '🔫', color: '#ff5e5e', duration: 20},
  {name: 'SPEED',    emoji: '⚡', color: '#ffe45e', duration: 15},
  {name: 'FIREWORK', emoji: '💥', color: '#ff6e5e'},
  {name: 'SHIELD',   emoji: '🛡️', color: '#5e9eff'},
  {name: 'RAPID',    emoji: '🌀', color: '#d05eff', duration: 15},
];
const POWERUP_SPAWN_INTERVAL = 6;   // s between spawn attempts
const POWERUP_LIFETIME = 12;        // s before despawn
const POWERUP_PICKUP_DIST = 5;      // world units

// ---------------------------------------------------------------------------
// Arena shape registry
// ---------------------------------------------------------------------------

const TORUS_MAJOR = 100;
const TORUS_MINOR = 60;
const PSEUDO_UMAX = 1.8;
const ELLIP_RX = 55;
const ELLIP_RY = 35;
const ELLIP_RZ = 45;
const PLANE_HALF = 70;
const SADDLE_K = 0.012;

const SHAPES = [
  // --- Torus ---
  {
    name: 'TORUS',
    uHalf: PI,
    vHalf: PI,
    speed: 1,
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
  // --- Sphere ---
  {
    name: 'SPHERE',
    uHalf: PI,
    vHalf: PI_HALF,
    speed: 1,
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
  // --- Pseudosphere (tractrix revolution, constant negative curvature) ---
  {
    name: 'PSEUDOSPHERE',
    uHalf: PI,
    vHalf: PSEUDO_UMAX,
    speed: 1,
    point(a, b, out) {
      const c = RADIUS / Math.cosh(b);
      out.set(c * Math.cos(a), c * Math.sin(a), RADIUS * (b - Math.tanh(b)));
      return out;
    },
    tangent: null,
    wrap(body) {
      if (body.theta > PI) { body.theta -= TWO_PI; }
      else if (body.theta < -PI) { body.theta += TWO_PI; }
      if (body.phi > PSEUDO_UMAX) {
        body.phi = PSEUDO_UMAX;
        body.vPhi = -Math.abs(body.vPhi);
        body.theta = wrapAngle(body.theta + PI);
        if (body.heading !== undefined) { body.heading = wrapAngle(body.heading + PI); }
        if (body === G) { shipWrapped = true; }
      } else if (body.phi < -PSEUDO_UMAX) {
        body.phi = -PSEUDO_UMAX;
        body.vPhi = Math.abs(body.vPhi);
        body.theta = wrapAngle(body.theta + PI);
        if (body.heading !== undefined) { body.heading = wrapAngle(body.heading + PI); }
        if (body === G) { shipWrapped = true; }
      }
    },
  },
  // --- Saddle plane (hyperbolic paraboloid, negative curvature, toroidal wrap) ---
  {
    name: 'PLANE',
    uHalf: PLANE_HALF,
    vHalf: PLANE_HALF,
    speed: 22,
    point(a, b, out) {
      out.set(a, SADDLE_K * (a * a - b * b), b);
      return out;
    },
    tangent(a, b) {
      _eT.set(1, 2 * SADDLE_K * a, 0).normalize();
      _eP.set(0, -2 * SADDLE_K * b, 1).normalize();
      _n.crossVectors(_eP, _eT).normalize();
    },
    wrap(body) {
      if (body.theta > PLANE_HALF) { body.theta -= 2 * PLANE_HALF; }
      else if (body.theta < -PLANE_HALF) { body.theta += 2 * PLANE_HALF; }
      if (body.phi > PLANE_HALF) { body.phi -= 2 * PLANE_HALF; }
      else if (body.phi < -PLANE_HALF) { body.phi += 2 * PLANE_HALF; }
    },
  },
  // --- Corrugated surface (deep ripples, variable curvature, toroidal wrap) ---
  {
    name: 'CORRUG',
    uHalf: PLANE_HALF,
    vHalf: PLANE_HALF,
    speed: 22,
    point(a, b, out) {
      out.set(a, 8 * Math.sin(0.05 * a) * Math.cos(0.05 * b), b);
      return out;
    },
    tangent(a, b) {
      const ca = 0.05 * a;
      const cb = 0.05 * b;
      _eT.set(1, 8 * 0.05 * Math.cos(ca) * Math.cos(cb), 0).normalize();
      _eP.set(0, -8 * 0.05 * Math.sin(ca) * Math.sin(cb), 1).normalize();
      _n.crossVectors(_eP, _eT).normalize();
    },
    wrap(body) {
      if (body.theta > PLANE_HALF) { body.theta -= 2 * PLANE_HALF; }
      else if (body.theta < -PLANE_HALF) { body.theta += 2 * PLANE_HALF; }
      if (body.phi > PLANE_HALF) { body.phi -= 2 * PLANE_HALF; }
      else if (body.phi < -PLANE_HALF) { body.phi += 2 * PLANE_HALF; }
    },
  },
  // --- Hyperbolic Möbius Strip (non-orientable, half-twist, negative curvature) ---
  {
    name: 'MOBIUS',
    uHalf: PI,
    vHalf: 25,
    speed: 1,
    point(a, b, out) {
      const R = RADIUS;
      const t = a;
      const half = t * 0.5;
      const cosH = Math.cos(half);
      const sinH = Math.sin(half);
      out.set(
        (R + b * cosH) * Math.cos(t),
        (R + b * cosH) * Math.sin(t),
        b * sinH,
      );
      return out;
    },
    tangent: null,
    wrap(body) {
      if (body.theta > PI) { body.theta -= TWO_PI; }
      else if (body.theta < -PI) { body.theta += TWO_PI; }
      if (body.phi > 25) { body.phi -= 50; }
      else if (body.phi < -25) { body.phi += 50; }
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
    powerup() { ensure(); tone(600, 1200, 0.08, 'sine', 0.15); tone(800, 1600, 0.06, 'sine', 0.12, 0.08); },
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
  // Power-up active timers
  tripleTimer: 0,
  speedTimer: 0,
  rapidTimer: 0,
  shieldHits: 0,
  fireworkNext: false,
  powerupCd: POWERUP_SPAWN_INTERVAL,
  colorMode: true,
  firstPerson: false,
};

let r360 = null;
let scene = null;
let shipMesh = null;
let engineMesh = null;
let shieldMesh = null;
let bullets = [];
let asteroids = [];
let fx = [];
let powerups = [];

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

let shipWrapped = false;

function wrapBody(body) {
  SHAPE.wrap(body);
}

function spawnDistOK(theta, phi) {
  surfacePoint(G.theta, G.phi, _tmp);
  surfacePoint(theta, phi, _tmp2);
  if (_tmp.distanceTo(_tmp2) < MIN_SPAWN_DIST) { return false; }
  if (SHAPE.uHalf === PLANE_HALF) {
    if (theta * theta + phi * phi < 1600) { return false; }
  }
  return true;
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
  const isMobius = SHAPE.name === 'MOBIUS';
  const matDim = new THREE.LineBasicMaterial({color: isMobius ? 0x0a3318 : 0x14404d, transparent: true, opacity: 0.6});
  const matPrime = new THREE.LineBasicMaterial({color: isMobius ? 0x1a5c2e : 0x2c6f80, transparent: true, opacity: 0.8});
  const matEq = new THREE.LineBasicMaterial({color: isMobius ? 0x2a8c44 : 0x3d95a8, transparent: true, opacity: 0.85});

  const uCount = 16;
  const vCount = 8;
  const uHalf = SHAPE.uHalf;
  const vMin = -SHAPE.vHalf;
  const vMax = SHAPE.vHalf;

  // Constant-a lines
  for (let i = 0; i < uCount; i++) {
    const u = -uHalf + (2 * uHalf * i) / uCount;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const v = vMin + ((vMax - vMin) * k) / 64;
      pts.push(SHAPE.point(u, v, new THREE.Vector3()));
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), i === 0 ? matPrime : matDim));
  }

  // Constant-b lines
  for (let i = 1; i < vCount; i++) {
    const v = vMin + ((vMax - vMin) * i) / vCount;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const u = -uHalf + (2 * uHalf * k) / 64;
      pts.push(SHAPE.point(u, v, new THREE.Vector3()));
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), matDim));
  }

  // Equator
  const eq = [];
  for (let k = 0; k <= 64; k++) {
    eq.push(SHAPE.point(-uHalf + (2 * uHalf * k) / 64, 0, new THREE.Vector3()));
  }
  grid.add(new THREE.LineLoop(pointsToGeo(eq), matEq));

  return grid;
}

// Quadrant fill colors (NE/NW/SE/SW)
const QUADRANT_COLORS = [0x3ad6ff, 0x3dffa5, 0xff9d3d, 0xc14dff];

function quadrantColor(a, b) {
  if (!G.colorMode) { return 0x556666; }
  if (SHAPE.name === 'MOBIUS') { return 0x3dffa5; }
  const north = b >= 0;
  const east = SHAPE.uHalf === PLANE_HALF ? a >= 0 : Math.cos(a) >= 0;
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
  if (SHAPE.name === 'MOBIUS') { return group; }
  const h = SHAPE.uHalf;
  const vh = SHAPE.vHalf;
  const mono = !G.colorMode;
  const c0 = mono ? 0x556666 : QUADRANT_COLORS[0];
  const c1 = mono ? 0x556666 : QUADRANT_COLORS[1];
  const c2 = mono ? 0x556666 : QUADRANT_COLORS[2];
  const c3 = mono ? 0x556666 : QUADRANT_COLORS[3];
  const op = mono ? 0.08 : 0.32;
  group.add(buildQuadrantMesh(-h, 0, 0, vh, c0));
  group.add(buildQuadrantMesh(0, h, 0, vh, c1));
  group.add(buildQuadrantMesh(-h, 0, -vh, 0, c2));
  group.add(buildQuadrantMesh(0, h, -vh, 0, c3));
  group.children.forEach(m => { m.material.opacity = op; });
  return group;
}

function rebuildArena() {
  if (arenaGroup) { scene.remove(arenaGroup); }
  if (quadrantGroup) { scene.remove(quadrantGroup); }
  arenaGroup = buildArenaGrid();
  quadrantGroup = buildQuadrants();
  arenaGroup.visible = G.colorMode;
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

  shieldMesh = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(8, 1)),
    new THREE.LineBasicMaterial({color: 0x5e9eff, transparent: true, opacity: 0.45})
  );
  shieldMesh.visible = false;
  group.add(shieldMesh);

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
  for (const p of powerups) { scene.remove(p.mesh); }
  powerups = [];

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
  updateHudOverlay();
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
  const vMin = SHAPE.vMin !== undefined ? SHAPE.vMin : -SHAPE.vHalf;
  for (let tries = 0; tries < 40; tries++) {
    theta = (Math.random() * 2 - 1) * SHAPE.uHalf;
    phi = vMin + Math.random() * (SHAPE.vHalf - vMin);
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

  const offsets = G.tripleTimer > 0 ? [-0.35, 0, 0.35] : [0];
  const isFirework = G.fireworkNext;
  if (G.fireworkNext) { G.fireworkNext = false; }
  for (const off of offsets) {
    const b = {
      theta: G.theta + Math.sin(G.heading) * 0.05,
      phi: G.phi + Math.cos(G.heading) * 0.05,
      heading: G.heading + off,
      life: BULLET_LIFE,
      mesh: new THREE.LineSegments(bulletWire, isFirework
        ? new THREE.LineBasicMaterial({color: 0xff5e5e, transparent: true, opacity: 1})
        : bulletMat),
      firework: isFirework,
    };
    bullets.push(b);
    scene.add(b.mesh);
    placeOriented(b.mesh, b);
  }
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

  if (bullet.firework) {
    for (let i = 0; i < 20; i++) {
      const h = bullet.heading + (i / 20) * TWO_PI;
      const fb = {
        theta: asteroid.theta + Math.sin(h) * 0.05,
        phi: asteroid.phi + Math.cos(h) * 0.05,
        heading: h,
        life: BULLET_LIFE * 0.6,
        mesh: new THREE.LineSegments(bulletWire,
          new THREE.LineBasicMaterial({color: 0xff5e5e, transparent: true, opacity: 1})),
        firework: false,
      };
      bullets.push(fb);
      scene.add(fb.mesh);
      placeOriented(fb.mesh, fb);
    }
    spawnRing(asteroid.theta, asteroid.phi, 0xff5e5e, {life: 0.5, grow: 30});
  }

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
    const nextIdx = G.wave % SHAPES.length;
    const nextName = SHAPES[nextIdx].name;
    setMsg('WAVE CLEAR  \u2192  ' + nextName, 2.2);
    G.startTimer = 2.3;
    G.tripleTimer = 0;
    G.speedTimer = 0;
    G.rapidTimer = 0;
    G.shieldHits = 0;
    G.fireworkNext = false;
    G.powerupCd = POWERUP_SPAWN_INTERVAL;
  }
}

function killShip(hitAsteroid) {
  if (G.invuln > 0) { return; }
    if (G.shieldHits > 0) {
    G.shieldHits--;
    Audio.explode();
    spawnRing(G.theta, G.phi, 0x5e9eff, {life: 0.5, grow: 30});
    if (hitAsteroid) {
      spawnRing(hitAsteroid.theta, hitAsteroid.phi, 0x5e9eff, {life: 0.4, grow: 22});
      removeAsteroid(hitAsteroid);
      if (asteroids.length === 0 && G.status === 'playing') {
        const nextIdx2 = G.wave % SHAPES.length;
        setMsg('WAVE CLEAR  \u2192  ' + SHAPES[nextIdx2].name, 2.2);
        G.startTimer = 2.3;
      }
    }
    return;
  }
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

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

function makePowerupSprite(type) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = '80px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(type.emoji, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({map: tex, transparent: true, opacity: 0.92});
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(6, 6, 1);
  return sprite;
}

function spawnPowerup() {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  let theta = 0;
  let phi = 0;
  const vMin = SHAPE.vMin !== undefined ? SHAPE.vMin : -SHAPE.vHalf;
  for (let tries = 0; tries < 40; tries++) {
    theta = (Math.random() * 2 - 1) * SHAPE.uHalf;
    phi = vMin + Math.random() * (SHAPE.vHalf - vMin);
    if (spawnDistOK(theta, phi)) { break; }
  }
  const mesh = makePowerupSprite(type);
  surfacePoint(theta, phi, _pos);
  mesh.position.copy(_pos);
  scene.add(mesh);
  powerups.push({type, theta, phi, life: POWERUP_LIFETIME, mesh});
}

function updatePowerups(dt) {
  G.powerupCd -= dt;
  if (G.powerupCd <= 0 && G.status === 'playing') {
    G.powerupCd = POWERUP_SPAWN_INTERVAL + Math.random() * 3;
    spawnPowerup();
  }

  for (let i = powerups.length - 1; i >= 0; i--) {
    const p = powerups[i];
    p.life -= dt;
    p.mesh.material.opacity = 0.55 + 0.37 * Math.sin(p.life * 3);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      powerups.splice(i, 1);
      continue;
    }
    // Pickup check
    surfacePoint(G.theta, G.phi, _tmp);
    surfacePoint(p.theta, p.phi, _tmp2);
    if (_tmp.distanceTo(_tmp2) < POWERUP_PICKUP_DIST) {
      Audio.powerup();
      applyPowerup(p.type);
      spawnRing(p.theta, p.phi, 0x5eff5e, {life: 0.4, grow: 14});
      scene.remove(p.mesh);
      powerups.splice(i, 1);
    }
  }
}

function applyPowerup(type) {
  switch (type.name) {
    case 'LIFE':     G.lives++; break;
    case 'TRIPLE':   G.tripleTimer += type.duration; break;
    case 'SPEED':    G.speedTimer += type.duration; break;
    case 'FIREWORK': G.fireworkNext = true; break;
    case 'SHIELD':   G.shieldHits++; break;
    case 'RAPID':    G.rapidTimer += type.duration; break;
  }
  updateHudOverlay();
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.theta += Math.sin(b.heading) * BULLET_SPEED * dt * SHAPE.speed;
    b.phi += Math.cos(b.heading) * BULLET_SPEED * dt * SHAPE.speed;
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
    a.theta += a.vTheta * dt * SHAPE.speed;
    a.phi += a.vPhi * dt * SHAPE.speed;
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
      const rr = a.radius + (G.shieldHits > 0 ? SHIP_RADIUS * 3 : SHIP_RADIUS);
      if (_tmp.distanceToSquared(_tmp2) < rr * rr) {
        killShip(a);
        break;
      }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    surfacePoint(b.theta, b.phi, _tmp);
    for (let j = powerups.length - 1; j >= 0; j--) {
      const p = powerups[j];
      surfacePoint(p.theta, p.phi, _tmp2);
      if (_tmp.distanceTo(_tmp2) < POWERUP_PICKUP_DIST) {
        Audio.powerup();
        applyPowerup(p.type);
        spawnRing(p.theta, p.phi, 0x5eff5e, {life: 0.4, grow: 14});
        scene.remove(p.mesh);
        powerups.splice(j, 1);
        scene.remove(b.mesh);
        bullets.splice(i, 1);
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
  if (G.tripleTimer > 0) { G.tripleTimer -= dt; }
  if (G.speedTimer > 0) { G.speedTimer -= dt; }
  if (G.rapidTimer > 0) { G.rapidTimer -= dt; }

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
      G.vTheta += Math.sin(G.heading) * ACCEL * amt * dt * SHAPE.speed;
      G.vPhi += Math.cos(G.heading) * ACCEL * amt * dt * SHAPE.speed;
    }

    if (SHAPE.name === 'MOBIUS') {
      const kbQ = !!keys.q;
      const kbE = !!keys.e;
      if (kbQ) { G.vPhi -= ACCEL * 0.7 * dt; }
      if (kbE) { G.vPhi += ACCEL * 0.7 * dt; }
    }
    const spd = Math.hypot(G.vTheta, G.vPhi);
    const speedMul = G.speedTimer > 0 ? 1.8 : 1;
    const maxV = MAX_VEL * SHAPE.speed * speedMul;
    if (spd > maxV) {
      G.vTheta *= maxV / spd;
      G.vPhi *= maxV / spd;
    }
    if (SHAPE.name === 'MOBIUS') {
      G.vTheta *= Math.exp(-DRAG * dt);
      G.vPhi *= Math.exp(-0.001 * dt);
    } else {
      const damp = Math.exp(-DRAG * dt);
      G.vTheta *= damp;
      G.vPhi *= damp;
    }

    G.theta += G.vTheta * dt;
    G.phi += G.vPhi * dt;
    wrapBody(G);

    G.fireCd -= dt;
    if (keys[' '] && G.fireCd <= 0) {
      fireBullet();
      G.fireCd = G.rapidTimer > 0 ? FIRE_COOLDOWN / 3 : FIRE_COOLDOWN;
    }

    placeOriented(shipMesh, G);
    engineMesh.visible = !!up;
    const blink = G.invuln > 0 && Math.floor(G.invuln * 8) % 2 === 0;
    shipMesh.visible = !blink;
    if (shieldMesh) {
      shieldMesh.visible = G.shieldHits > 0 && !blink;
      shieldMesh.rotation.y += dt * 1.2;
    }
  } else {
    shipMesh.visible = false;
    if (shieldMesh) { shieldMesh.visible = false; }
  }

  updateBullets(dt);
  updateAsteroids(dt);
  handleCollisions();
  updatePowerups(dt);
  updateFx(dt);
  updateHudOverlay();
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

  if (G.firstPerson) {
    _camDir.copy(_eT).multiplyScalar(Math.sin(G.heading))
      .addScaledVector(_eP, Math.cos(G.heading))
      .normalize();
    _camPosV.copy(_shipPosV).addScaledVector(_n, 0.3);
  } else {
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
  if (shipWrapped) {
    _smoothCam.copy(_camPosV);
    _refInit = false;
    shipWrapped = false;
  }

  if (G.firstPerson) {
    _camQuat.copy(shipMesh.quaternion);
    _tmp.set(0, 1, 0);
    _rollQuat.setFromAxisAngle(_tmp, PI);
    _camQuat.multiply(_rollQuat);
    _smoothCam.copy(_shipPosV).addScaledVector(_n, 0.3);
  } else {
    _lookZ.subVectors(_smoothCam, _shipPosV).normalize();
    _lookUp.copy(_refT).addScaledVector(_lookZ, -_refT.dot(_lookZ));
    if (_lookUp.lengthSq() < 1e-6) { _lookUp.copy(_refT); }
    _lookUp.normalize();
    _camRight.crossVectors(_lookUp, _lookZ).normalize();
    _lookUp.crossVectors(_lookZ, _camRight).normalize();
    _camMat.makeBasis(_camRight, _lookUp, _lookZ);
    _camQuat.setFromRotationMatrix(_camMat);
  }

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
  if (k === 'c') { toggleColors(); }
  if (k === 'f') { toggleFirstPerson(); }
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
    if (SHAPE.uHalf === PLANE_HALF) {
      const d = Math.hypot(a.theta, a.phi);
      if (d < 40) {
        const push = 40 / (d || 1);
        a.theta *= push;
        a.phi *= push;
      }
    }
    a.mesh.material.color.setHex(quadrantColor(a.theta, a.phi));
  }
  for (const b of bullets) { wrapBody(b); }
  _refInit = false;
  computeCamera();
  _smoothCam.copy(_camPosV);
  updateToggleLabel();
}

function toggleColors() {
  G.colorMode = !G.colorMode;
  rebuildArena();
  for (const a of asteroids) {
    a.mesh.material.color.setHex(quadrantColor(a.theta, a.phi));
  }
}

function toggleFirstPerson() {
  G.firstPerson = !G.firstPerson;
}

function buildUiControls() {
  const wrap = document.createElement('div');
  wrap.id = 'r360-ui-controls';
  wrap.style.cssText =
    'position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:110;pointer-events:none;' +
    'display:flex;gap:8px;';

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
  toggleBtn = btn;

  const colorBtn = document.createElement('div');
  colorBtn.innerText = 'COLOR';
  colorBtn.style.cssText = btn.style.cssText;
  colorBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleColors();
  });
  wrap.appendChild(colorBtn);

  const fpBtn = document.createElement('div');
  fpBtn.innerText = 'FPS';
  fpBtn.style.cssText = btn.style.cssText;
  fpBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleFirstPerson();
  });
  wrap.appendChild(fpBtn);

  document.body.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// DOM HUD overlay (score, lives, power-ups)
// ---------------------------------------------------------------------------

let hudEl = null;

function buildHudOverlay() {
  const el = document.createElement('div');
  el.id = 'hud-overlay';
  el.style.cssText =
    'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:120;' +
    'pointer-events:none;display:flex;gap:14px;align-items:center;' +
    'font-family:monospace;color:#eaffff;font-size:12px;letter-spacing:1px;' +
    'background:rgba(3,12,16,0.55);border:1px solid rgba(46,107,122,0.5);' +
    'border-radius:8px;padding:4px 12px;white-space:nowrap;';
  el.innerHTML =
    '<span id="hud-score">SCORE 000000</span>' +
    '<span style="color:rgba(46,107,122,0.6);">│</span>' +
    '<span id="hud-level">LVL 01</span>' +
    '<span style="color:rgba(46,107,122,0.6);">│</span>' +
    '<span id="hud-lives">▲▲▲</span>' +
    '<span style="color:rgba(46,107,122,0.6);">│</span>' +
    '<span id="hud-powerups" style="font-size:11px;color:#5eff5e;"></span>';
  document.body.appendChild(el);
  hudEl = el;
}

function updateHudOverlay() {
  if (!hudEl) { return; }
  const scoreEl = document.getElementById('hud-score');
  const levelEl = document.getElementById('hud-level');
  const livesEl = document.getElementById('hud-lives');
  const pupEl = document.getElementById('hud-powerups');
  if (scoreEl) {
    scoreEl.textContent = 'SCORE ' + String(G.score).padStart(6, '0');
  }
  if (levelEl) {
    levelEl.textContent = 'LVL ' + String(Math.max(1, G.wave)).padStart(2, '0');
  }
  if (livesEl) {
    livesEl.textContent = '▲'.repeat(Math.max(0, G.lives));
  }
  if (pupEl) {
    const parts = [];
    if (G.tripleTimer > 0) {
      parts.push('🔫 ' + Math.ceil(G.tripleTimer) + 's');
    }
    if (G.speedTimer > 0) {
      parts.push('⚡ ' + Math.ceil(G.speedTimer) + 's');
    }
    if (G.fireworkNext) {
      parts.push('💥 READY');
    }
    if (G.shieldHits > 0) {
      parts.push('🛡️ x' + G.shieldHits);
    }
    if (G.rapidTimer > 0) {
      parts.push('🌀 ' + Math.ceil(G.rapidTimer) + 's');
    }
    pupEl.textContent = parts.join('  ');
  }
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
  buildHudOverlay();
  buildTouchControls();

  resetGame();
  r360.start();
}

window.React360 = {init};
