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
  {name: 'FIREWORK', emoji: '💥', color: '#ff6e5e', duration: 5},
  {name: 'SHIELD',   emoji: '🛡️', color: '#5e9eff'},
  {name: 'RAPID',    emoji: '🌀', color: '#d05eff', duration: 15},
];
const POWERUP_SPAWN_INTERVAL = 6;   // s between spawn attempts
const POWERUP_LIFETIME = 12;        // s before despawn
const POWERUP_PICKUP_DIST = 5;      // world units

const MATRIX_SHIPS = ['NEBUCHEZZAR','LOGOS','OSIRIS','ICARUS','VIGILANT','NOVALIS','MJOLNIR','DORA','IRONSIDE','WOLFHOUND'];
const MP_COLORS = [0xaef4f4,0x5eff5e,0xff5eff,0xffa500,0x5e9eff];
const MP = {role:null,pc:null,dc:null,connected:false,playerName:'',remotePlayers:{},syncTimer:0,SYNC_RATE:1/15,remoteInput:{name:''}};

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
    vHalf: PI,
    speed: 1,
    point(a, b, out) {
      const R = RADIUS;
      const stripW = 18;
      const bw = (b / PI) * stripW;
      const t = a;
      const half = t * 0.5;
      const cosH = Math.cos(half);
      const sinH = Math.sin(half);
      out.set(
        (R + bw * cosH) * Math.cos(t),
        (R + bw * cosH) * Math.sin(t),
        bw * sinH,
      );
      return out;
    },
    tangent(a, b) {
      const R = RADIUS;
      const stripW = 18;
      const bw = (b / PI) * stripW;
      const t = a;
      const half = t * 0.5;
      const cosH = Math.cos(half);
      const sinH = Math.sin(half);
      const dbw = stripW / PI;
      _eu.set(
        -bw * 0.5 * sinH * Math.cos(t) - (R + bw * cosH) * Math.sin(t),
        -bw * 0.5 * sinH * Math.sin(t) + (R + bw * cosH) * Math.cos(t),
        bw * 0.5 * cosH,
      );
      _ev.set(
        dbw * cosH * Math.cos(t),
        dbw * cosH * Math.sin(t),
        dbw * sinH,
      );
      _eu.normalize();
      _ev.normalize();
      _n.crossVectors(_eu, _ev).normalize();
      _eT.copy(_eu);
      _eP.copy(_ev);
    },
    wrap(body) {
      if (body.theta > PI) { body.theta -= TWO_PI; }
      else if (body.theta < -PI) { body.theta += TWO_PI; }
      if (body.phi > PI) { body.phi -= TWO_PI; }
      else if (body.phi < -PI) { body.phi += TWO_PI; }
    },
  },
  // --- Einstein (flat fabric warped by random gravity wells: planets + orbiting moons) ---
  {
    name: 'EINSTEIN',
    uHalf: PLANE_HALF * 4,
    vHalf: PLANE_HALF * 4,
    speed: 88,
    _bodies: [],
    _generate() {
      const bodies = [];
      const half = this.uHalf - 15;
      const minSep = 160;
      const planetCount = 3 + Math.floor(Math.random() * 3);
      const placed = [];
      const planetColors = [0xff6633, 0x33ccaa, 0xaa55dd, 0xddaa22, 0x5588ff, 0xff4488, 0x88dd44];
      const moonColors = [0x66ddff, 0xff88cc, 0x88ffaa, 0xffcc44, 0xcc88ff];
      const moon2Colors = [0xaaddff, 0xffaadd, 0xaaffcc, 0xffdd88, 0xddaaff];
      for (let i = 0; i < planetCount; i++) {
        let x, z, ok;
        for (let t = 0; t < 30; t++) {
          x = (Math.random() * 2 - 1) * half;
          z = (Math.random() * 2 - 1) * half;
          ok = true;
          if (Math.hypot(x, z) < 35) { ok = false; }
          for (const p of placed) {
            if (Math.hypot(x - p.x, z - p.z) < minSep) { ok = false; break; }
          }
          if (ok) break;
        }
        placed.push({ x, z });
        const mass = 6 + Math.random() * 18;
        const spread = 400 + Math.random() * 400;
        const radius = 3 + mass * 0.35;
        const color = planetColors[i % planetColors.length];
        bodies.push({ x, z, mass, spread, radius, color, orbitAngle: 0, orbitR: 0 });
        const moonCount = Math.random() < 0.6 ? 1 : 0;
        for (let m = 0; m < moonCount; m++) {
          const moonDist = radius + 40 + Math.random() * 25;
          const moonMass = 3 + Math.random() * 8;
          const moonSpread = 200 + Math.random() * 200;
          const moonRadius = 2 + moonMass * 0.3;
          bodies.push({
            x, z, mass: moonMass, spread: moonSpread, radius: moonRadius,
            color: moonColors[Math.floor(Math.random() * moonColors.length)],
            orbitAngle: Math.random() * Math.PI * 2,
            orbitR: moonDist, parentIdx: bodies.length - 1,
          });
          if (Math.random() < 0.1) {
            const m2Dist = radius + 60 + Math.random() * 30;
            const m2Mass = 2 + Math.random() * 5;
            const m2Spread = 100 + Math.random() * 150;
            bodies.push({
              x, z, mass: m2Mass, spread: m2Spread, radius: 1.5 + m2Mass * 0.25,
              color: moon2Colors[Math.floor(Math.random() * moon2Colors.length)],
              orbitAngle: Math.random() * Math.PI * 2,
              orbitR: m2Dist, parentIdx: bodies.length - moonCount - 1,
            });
          }
        }
      }
      this._bodies = bodies;
    },
    _bodyPos(body, out) {
      if (body.orbitR > 0 && body.parentIdx !== undefined) {
        const parent = this._bodies[body.parentIdx];
        this._bodyPos(parent, out);
        out.x += body.orbitR * Math.cos(body.orbitAngle);
        out.z += body.orbitR * Math.sin(body.orbitAngle);
      } else if (body.orbitR > 0) {
        out.set(body.x + body.orbitR * Math.cos(body.orbitAngle), 0, body.z + body.orbitR * Math.sin(body.orbitAngle));
      } else {
        out.set(body.x, 0, body.z);
      }
    },
    point(a, b, out) {
      let y = 0;
      for (const body of this._bodies) {
        this._bodyPos(body, _tmp3);
        const d2 = (a - _tmp3.x) * (a - _tmp3.x) + (b - _tmp3.z) * (b - _tmp3.z);
        y -= body.mass * Math.exp(-d2 / body.spread);
      }
      out.set(a, y, b);
      return out;
    },
    tangent(a, b) {
      const eps = 0.15;
      this.point(a + eps, b, _tmp);
      this.point(a - eps, b, _tmp2);
      _eu.subVectors(_tmp, _tmp2).normalize();
      this.point(a, b + eps, _tmp);
      this.point(a, b - eps, _tmp2);
      _ev.subVectors(_tmp, _tmp2).normalize();
      _n.crossVectors(_ev, _eu).normalize();
      _eT.copy(_eu);
      _eP.copy(_ev);
    },
    wrap(body) {
      const uh = this.uHalf;
      const vh = this.vHalf;
      if (body.theta > uh) { body.theta -= 2 * uh; }
      else if (body.theta < -uh) { body.theta += 2 * uh; }
      if (body.phi > vh) { body.phi -= 2 * vh; }
      else if (body.phi < -vh) { body.phi += 2 * vh; }
    },
  },
];

// Reorder: TORUS, SPHERE, PSEUDOSPHERE, PLANE, CORRUG, EINSTEIN x2, MOBIUS
{
  const _torus = SHAPES[0];
  const _sphere = SHAPES[1];
  const _pseudo = SHAPES[2];
  const _plane = SHAPES[3];
  const _corrug = SHAPES[4];
  const _einstein = SHAPES[6];
  const _mobius = SHAPES[5];
  const _einstein2 = Object.assign({}, _einstein, {
    _bodies: [],
    _generate() { _einstein._generate.call(this); },
  });
  SHAPES.length = 0;
  SHAPES.push(_torus, _sphere, _pseudo, _plane, _corrug, _einstein, _einstein2, _mobius);
}

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
let einsteinGroup = null;
let toggleBtn = null;
let colorBtn = null;
let fpBtn = null;

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
  fireworkTimer: 0,
  powerupCd: POWERUP_SPAWN_INTERVAL,
  colorMode: false,
  firstPerson: true,
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
  if (SHAPE.uHalf === PLANE_HALF || SHAPE.name === 'EINSTEIN') {
    if (theta * theta + phi * phi < 3600) { return false; }
  }
  if (SHAPE.name === 'EINSTEIN') {
    const s = SHAPE;
    s.point(theta, phi, _tmp);
    for (const body of s._bodies) {
      s._bodyPos(body, _tmp2);
      s.point(_tmp2.x, _tmp2.z, _tmp2);
      if (_tmp.distanceTo(_tmp2) < body.radius + 8) { return false; }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Multiplayer (WebRTC peer-to-peer)
// ---------------------------------------------------------------------------

function encodeSDP(desc) {
  return btoa(JSON.stringify({type: desc.type, sdp: desc.sdp}))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeSDP(str) {
  const pad = str + '=='.slice(0, (4 - str.length % 4) % 4);
  return new RTCSessionDescription(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))));
}
function gatherICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.onicegatheringstatechange = null; resolve(); } };
    pc.onicegatheringstatechange = check;
    check();
  });
}
function randomMatrixName() {
  return MATRIX_SHIPS[Math.floor(Math.random() * MATRIX_SHIPS.length)];
}

function makeRemoteShipMesh(colorIdx) {
  const mat = new THREE.LineBasicMaterial({color: MP_COLORS[(colorIdx + 1) % MP_COLORS.length], transparent: true, opacity: 0.95});
  const edges = [[0,0,4.2,-3,0,-1],[0,0,4.2,3,0,-1],[-3,0,-1,0,0,-3.2],[3,0,-1,0,0,-3.2],[0,0,4.2,0,0,-3.2],[-3,0,-1,0,0,-0.8],[3,0,-1,0,0,-0.8],[0,0,-0.8,0,0,-3.2],[0,0,4.2,0,0,5.6],[-0.7,0,-3.2,0.7,0,-3.2]];
  const pts = [];
  for (const e of edges) { pts.push(new THREE.Vector3(e[0],e[1],e[2])); pts.push(new THREE.Vector3(e[3],e[4],e[5])); }
  const group = new THREE.Group();
  group.add(new THREE.LineSegments(pointsToGeo(pts), mat));
  return group;
}

async function mpCreateRoom(name) {
  MP.role = 'host';
  MP.playerName = name;
  const pc = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
  MP.pc = pc;
  const dc = pc.createDataChannel('game', {ordered: false, maxRetransmits: 0});
  MP.dc = dc;
  dc.onopen = () => { MP.connected = true; updateMpIndicator(); };
  dc.onclose = () => { MP.connected = false; updateMpIndicator(); };
  dc.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'i') { MP.remoteInput = m; MP.remoteInput.name = m.n; } };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await gatherICE(pc);
  const url = location.origin + location.pathname + '#room=' + encodeSDP(pc.localDescription);
  showWaitingUI(url, name);
}

async function mpJoinRoom(encoded, name) {
  MP.role = 'client';
  MP.playerName = name;
  const pc = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
  MP.pc = pc;
  pc.ondatachannel = (e) => {
    MP.dc = e.channel;
    e.channel.onopen = () => { MP.connected = true; updateMpIndicator(); };
    e.channel.onclose = () => { MP.connected = false; updateMpIndicator(); };
    e.channel.onmessage = (e) => handleClientMessage(JSON.parse(e.data));
  };
  await pc.setRemoteDescription(decodeSDP(encoded));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await gatherICE(pc);
  showAnswerUI(encodeSDP(pc.localDescription), name);
}

async function mpAcceptAnswer(encoded) {
  await MP.pc.setRemoteDescription(decodeSDP(encoded));
  hideModal();
}

function sendHostState() {
  if (!MP.dc || MP.dc.readyState !== 'open') return;
  const ps = [{
    n: MP.playerName, θ: G.theta, φ: G.phi, h: G.heading, b: G.bank,
    s: G.score, l: G.lives, v: G.respawnTimer <= 0,
    e: G.respawnTimer <= 0 && engineMesh && engineMesh.visible,
    sh: G.shieldHits,
  }];
  for (const k in MP.remotePlayers) {
    const r = MP.remotePlayers[k];
    ps.push({
      n: r.name, θ: r.theta, φ: r.phi, h: r.heading, b: r.bank,
      s: r.score || 0, l: r.lives || START_LIVES, v: r.respawnTimer <= 0,
      e: false, sh: r.shieldHits || 0,
    });
  }
  MP.dc.send(JSON.stringify({
    t: 's', ps,
    as: asteroids.map(a => ({θ: a.theta, φ: a.phi, t: a.tier})),
    w: G.wave, sh: SHAPE.name, st: G.status,
    mt: {msg: G.msg, timer: G.msgTimer},
  }));
}

function handleClientMessage(msg) {
  if (msg.t === 's') {
    for (const p of msg.ps) {
      if (p.n === MP.playerName) {
        G.theta = p.θ; G.phi = p.φ; G.heading = p.h; G.bank = p.b;
        G.score = p.s; G.lives = p.l; G.shieldHits = p.sh;
        shipMesh.visible = p.v;
        if (engineMesh) engineMesh.visible = p.e;
        if (p.v) placeOriented(shipMesh, G);
      } else {
        ensureRemotePlayer(p);
        const rp = MP.remotePlayers[p.n];
        rp.theta = p.θ; rp.phi = p.φ; rp.heading = p.h; rp.bank = p.b;
        rp.respawnTimer = p.v ? 0 : 999;
        rp.mesh.visible = p.v;
        if (p.v) placeOriented(rp.mesh, rp);
      }
    }
    G.wave = msg.w; G.status = msg.st;
    if (msg.mt && msg.mt.timer > 0) { G.msg = msg.mt.msg; G.msgTimer = msg.mt.timer; }
    updateHudOverlay();
  }
}

function ensureRemotePlayer(p) {
  if (MP.remotePlayers[p.n]) return;
  const ci = Object.keys(MP.remotePlayers).length;
  const mesh = makeRemoteShipMesh(ci);
  scene.add(mesh);
  MP.remotePlayers[p.n] = {name: p.n, theta: p.θ, phi: p.φ, heading: p.h, bank: p.b, score: p.s, lives: p.l, respawnTimer: p.v ? 0 : 999, shieldHits: p.sh || 0, mesh};
}

function processRemoteInput() {
  if (MP.role !== 'host' || !MP.remoteInput || !MP.remoteInput.t) return;
  const inp = MP.remoteInput;
  const name = inp.n || 'PLAYER 2';
  if (!MP.remotePlayers[name]) {
    const ci = Object.keys(MP.remotePlayers).length;
    const mesh = makeRemoteShipMesh(ci);
    scene.add(mesh);
    MP.remotePlayers[name] = {
      name, theta: 0, phi: 0.3, vTheta: 0, vPhi: 0, heading: 0.6, bank: 0,
      targetBank: 0, score: 0, lives: START_LIVES, respawnTimer: 0,
      invuln: INVULN_TIME, shieldHits: 0, mesh,
    };
  }
  const rp = MP.remotePlayers[name];
  const dt = 1 / 15;
  if (rp.respawnTimer > 0) {
    rp.respawnTimer -= dt;
    if (rp.respawnTimer <= 0) {
      rp.theta = 0; rp.phi = 0.3; rp.vTheta = 0; rp.vPhi = 0;
      rp.heading = 0.6; rp.bank = 0; rp.invuln = INVULN_TIME;
    }
    rp.mesh.visible = false;
    return;
  }
  if (rp.invuln > 0) rp.invuln -= dt;
  if (inp.l) { rp.heading -= TURN_RATE * dt; rp.targetBank = -0.5; }
  else if (inp.r) { rp.heading += TURN_RATE * dt; rp.targetBank = 0.5; }
  else { rp.targetBank = 0; }
  rp.heading = wrapAngle(rp.heading);
  rp.bank += (rp.targetBank - rp.bank) * Math.min(1, dt * 7);
  if (inp.u) {
    rp.vTheta += Math.sin(rp.heading) * ACCEL * dt * SHAPE.speed;
    rp.vPhi += Math.cos(rp.heading) * ACCEL * dt * SHAPE.speed;
  }
  const spd = Math.hypot(rp.vTheta, rp.vPhi);
  const maxV = MAX_VEL * SHAPE.speed;
  if (spd > maxV) { rp.vTheta *= maxV / spd; rp.vPhi *= maxV / spd; }
  const damp = SHAPE.name === 'MOBIUS' ? Math.exp(-0.04 * dt) : Math.exp(-DRAG * dt);
  rp.vTheta *= damp; rp.vPhi *= damp;
  rp.theta += rp.vTheta * dt; rp.phi += rp.vPhi * dt;
  wrapBody(rp);
  const blink = rp.invuln > 0 && Math.floor(rp.invuln * 8) % 2 === 0;
  rp.mesh.visible = !blink;
  placeOriented(rp.mesh, rp);
}

function sendClientInput() {
  if (!MP.dc || MP.dc.readyState !== 'open') return;
  MP.dc.send(JSON.stringify({
    t: 'i',
    l: !!(keys.ArrowLeft || keys.a),
    r: !!(keys.ArrowRight || keys.d),
    u: !!(keys.ArrowUp || keys.w),
    f: !!keys[' '],
    n: MP.playerName,
  }));
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
  const isGreen = SHAPE.name === 'MOBIUS' || SHAPE.uHalf === PLANE_HALF;
  const isBig = SHAPE.name === 'EINSTEIN';
  const matDim = new THREE.LineBasicMaterial({color: isGreen ? 0x0a3318 : 0x14404d, transparent: true, opacity: 0.6});
  const matPrime = new THREE.LineBasicMaterial({color: isGreen ? 0x1a5c2e : 0x2c6f80, transparent: true, opacity: 0.8});
  const matEq = new THREE.LineBasicMaterial({color: isGreen ? 0x2a8c44 : 0x3d95a8, transparent: true, opacity: 0.85});

  const uCount = isBig ? 20 : isGreen ? 24 : 16;
  const vCount = isBig ? 14 : isGreen ? 16 : 8;
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
  if (SHAPE.uHalf === PLANE_HALF || SHAPE.name === 'MOBIUS') { return 0x3dffa5; }
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
  const h = SHAPE.uHalf;
  const vh = SHAPE.vHalf;
  const mono = !G.colorMode;
  const planeLike = SHAPE.uHalf === PLANE_HALF || SHAPE.name === 'MOBIUS';
  const green = 0x3dffa5;
  const c0 = mono ? 0x556666 : planeLike ? green : QUADRANT_COLORS[0];
  const c1 = mono ? 0x556666 : planeLike ? green : QUADRANT_COLORS[1];
  const c2 = mono ? 0x556666 : planeLike ? green : QUADRANT_COLORS[2];
  const c3 = mono ? 0x556666 : planeLike ? green : QUADRANT_COLORS[3];
  const op = mono ? 0.08 : 0.32;
  group.add(buildQuadrantMesh(-h, 0, 0, vh, c0));
  group.add(buildQuadrantMesh(0, h, 0, vh, c1));
  group.add(buildQuadrantMesh(-h, 0, -vh, 0, c2));
  group.add(buildQuadrantMesh(0, h, -vh, 0, c3));
  group.children.forEach(m => { m.material.opacity = op; });
  return group;
}

const _ePos = new THREE.Vector3();

function buildEinsteinBodies() {
  einsteinGroup = new THREE.Group();
  const s = SHAPE;
  if (s._bodies.length === 0) { s._generate(); }

  for (const body of s._bodies) {
    const geo = new THREE.SphereGeometry(body.radius, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ color: body.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.body = body;
    body.mesh = mesh;
    einsteinGroup.add(mesh);
  }

  einsteinGroup.visible = true;
  scene.add(einsteinGroup);
  updateEinsteinMeshPositions();
}

function rebuildEinsteinGrid() {
  if (!arenaGroup) return;
  arenaGroup.traverse(child => {
    if (child.geometry) { child.geometry.dispose(); }
  });
  scene.remove(arenaGroup);
  arenaGroup = buildArenaGrid();
  arenaGroup.visible = true;
  scene.add(arenaGroup);
}

function rebuildArena() {
  if (arenaGroup) { scene.remove(arenaGroup); }
  if (quadrantGroup) { scene.remove(quadrantGroup); }
  if (einsteinGroup) { scene.remove(einsteinGroup); }
  arenaGroup = buildArenaGrid();
  quadrantGroup = buildQuadrants();
  arenaGroup.visible = G.colorMode || SHAPE.name === 'EINSTEIN';
  scene.add(arenaGroup);
  scene.add(quadrantGroup);
  if (SHAPE.name === 'EINSTEIN') {
    buildEinsteinBodies();
  }
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
  G.firstPerson = SHAPE.name !== 'SPHERE' && SHAPE.name !== 'MOBIUS';
  rebuildArena();
  wrapBody(G);
  _refInit = false;
  computeCamera();
  _smoothCam.copy(_camPosV);
  updateToggleLabel();
  updateToggleStyles();

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
  const isFirework = G.fireworkTimer > 0;
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
    G.fireworkTimer = 0;
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
    case 'FIREWORK': G.fireworkTimer += type.duration; break;
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

function updateEinsteinMeshPositions() {
  if (SHAPE.name !== 'EINSTEIN' || !einsteinGroup) return;
  const s = SHAPE;
  for (const body of s._bodies) {
    if (!body.mesh) continue;
    s._bodyPos(body, _ePos);
    body.mesh.position.set(_ePos.x, 0, _ePos.z);
    SHAPE.point(_ePos.x, _ePos.z, _ePos);
    body.mesh.position.y = _ePos.y + body.radius * 0.3;
  }
}

let _einsteinFrame = 0;
function updateEinsteinBodies(dt) {
  if (SHAPE.name !== 'EINSTEIN') return;
  const s = SHAPE;
  for (const body of s._bodies) {
    if (body.orbitR > 0) {
      body.orbitAngle += dt * 0.25;
    }
  }
  updateEinsteinMeshPositions();
  _einsteinFrame++;
  if (_einsteinFrame % 12 === 0) { rebuildEinsteinGrid(); }
}

function handleEinsteinCollisions() {
  if (SHAPE.name !== 'EINSTEIN' || !einsteinGroup) return;
  const s = SHAPE;

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    surfacePoint(b.theta, b.phi, _tmp);
    for (const body of s._bodies) {
      s._bodyPos(body, _tmp2);
      s.point(_tmp2.x, _tmp2.z, _tmp2);
      if (_tmp.distanceTo(_tmp2) < body.radius + 1) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
        spawnRing(b.theta, b.phi, 0xff8844, { life: 0.3, grow: 6 });
        break;
      }
    }
  }

  if (G.status === 'playing' && G.respawnTimer <= 0 && G.invuln <= 0) {
    surfacePoint(G.theta, G.phi, _tmp);
    const hitR = G.shieldHits > 0 ? SHIP_RADIUS * 3 : SHIP_RADIUS;
    for (const body of s._bodies) {
      s._bodyPos(body, _tmp2);
      s.point(_tmp2.x, _tmp2.z, _tmp2);
      if (_tmp.distanceTo(_tmp2) < body.radius + hitR) {
        killShip(null);
        break;
      }
    }
  }

  for (let i = asteroids.length - 1; i >= 0; i--) {
    const a = asteroids[i];
    surfacePoint(a.theta, a.phi, _tmp);
    for (const body of s._bodies) {
      s._bodyPos(body, _tmp2);
      s.point(_tmp2.x, _tmp2.z, _tmp2);
      if (_tmp.distanceTo(_tmp2) < body.radius + a.radius) {
        removeAsteroid(a);
        spawnRing(a.theta, a.phi, 0xff8844, { life: 0.4, grow: 10 });
        break;
      }
    }
    if (asteroids.length === 0 && G.status === 'playing' && G.startTimer <= 0) {
      const nextIdx2 = G.wave % SHAPES.length;
      setMsg('WAVE CLEAR  \u2192  ' + SHAPES[nextIdx2].name, 2.2);
      G.startTimer = 2.3;
    }
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

  if (MP.role === 'client') {
    sendClientInput();
    updateHudOverlay();
    return;
  }

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
  if (G.fireworkTimer > 0) { G.fireworkTimer -= dt; }

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
    const spd = Math.hypot(G.vTheta, G.vPhi);
    const speedMul = G.speedTimer > 0 ? 1.8 : 1;
    const maxV = MAX_VEL * SHAPE.speed * speedMul;
    if (spd > maxV) {
      G.vTheta *= maxV / spd;
      G.vPhi *= maxV / spd;
    }
    const damp = SHAPE.name === 'MOBIUS' ? Math.exp(-0.04 * dt) : Math.exp(-DRAG * dt);
    G.vTheta *= damp;
    G.vPhi *= damp;

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
  updateEinsteinBodies(dt);
  handleCollisions();
  handleEinsteinCollisions();
  updatePowerups(dt);
  updateFx(dt);
  updateHudOverlay();

  if (MP.role === 'host') {
    processRemoteInput();
    MP.syncTimer += dt;
    if (MP.syncTimer >= MP.SYNC_RATE) {
      sendHostState();
      MP.syncTimer = 0;
    }
  }
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
    _camPosV.copy(_shipPosV).addScaledVector(_n, 20);
    const sh = Math.sin(G.heading);
    const ch = Math.cos(G.heading);
    _camPosV.addScaledVector(_eT, -sh * 26);
    _camPosV.addScaledVector(_eP, -ch * 26);
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
    const hover = CAM_HOVER * (SHAPE.name === 'EINSTEIN' ? 2 : 1);
    _camPosV.copy(_shipPosV).addScaledVector(_n, hover);
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
    _tmp.set(1, 0, 0);
    _rollQuat.setFromAxisAngle(_tmp, -0.25);
    _camQuat.multiply(_rollQuat);
    _smoothCam.copy(_shipPosV).addScaledVector(_n, 20);
    const sh = Math.sin(G.heading);
    const ch = Math.cos(G.heading);
    _smoothCam.addScaledVector(_eT, -sh * 26);
    _smoothCam.addScaledVector(_eP, -ch * 26);
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
  if (e.target && e.target.closest && e.target.closest('#r360-ui-controls, #mp-invite-btn, #mp-modal, #r360-touch-controls')) { return; }
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
  if (toggleBtn && toggleBtn.tagName === 'SELECT') {
    toggleBtn.value = shapeIdx;
  }
}

function toggleGeometry() {
  shapeIdx = (shapeIdx + 1) % SHAPES.length;
  SHAPE = SHAPES[shapeIdx];
  G.firstPerson = SHAPE.name !== 'SPHERE' && SHAPE.name !== 'MOBIUS';
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
  updateToggleStyles();
}

function toggleColors() {
  G.colorMode = !G.colorMode;
  rebuildArena();
  for (const a of asteroids) {
    a.mesh.material.color.setHex(quadrantColor(a.theta, a.phi));
  }
  updateToggleStyles();
}

function toggleFirstPerson() {
  G.firstPerson = !G.firstPerson;
  updateToggleStyles();
}

function buildUiControls() {
  const wrap = document.createElement('div');
  wrap.id = 'r360-ui-controls';
  wrap.style.cssText =
    'position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:110;pointer-events:none;' +
    'display:flex;gap:8px;align-items:center;';

  const sel = document.createElement('select');
  sel.style.cssText =
    'pointer-events:auto;cursor:pointer;touch-action:none;' +
    'padding:5px 10px;border-radius:999px;border:2px solid rgba(255,255,255,0.3);' +
    'background:rgba(0,0,0,0.5);color:#cfeeff;font:700 12px/1 monospace;letter-spacing:1px;';
  for (let i = 0; i < SHAPES.length; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = SHAPES[i].name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', e => {
    e.preventDefault();
    e.stopPropagation();
    shapeIdx = parseInt(sel.value, 10);
    SHAPE = SHAPES[shapeIdx];
    G.firstPerson = SHAPE.name !== 'SPHERE' && SHAPE.name !== 'MOBIUS';
    rebuildArena();
    wrapBody(G);
    _refInit = false;
    computeCamera();
    _smoothCam.copy(_camPosV);
    updateToggleStyles();
  });
  wrap.appendChild(sel);
  toggleBtn = sel;

  colorBtn = document.createElement('div');
  colorBtn.innerText = 'COLOR';
  colorBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;touch-action:none;-webkit-user-select:none;' +
    'user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;' +
    'padding:5px 14px;border-radius:999px;border:2px solid rgba(255,255,255,0.3);' +
    'background:rgba(0,0,0,0.25);color:#cfeeff;font:700 12px/1 monospace;letter-spacing:1px;';
  colorBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleColors();
  });
  wrap.appendChild(colorBtn);

  fpBtn = document.createElement('div');
  fpBtn.innerText = 'FPS';
  fpBtn.style.cssText = colorBtn.style.cssText;
  fpBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleFirstPerson();
  });
  wrap.appendChild(fpBtn);

  document.body.appendChild(wrap);
  updateToggleStyles();
}

function updateToggleStyles() {
  const base = 'pointer-events:auto;cursor:pointer;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;padding:5px 14px;border-radius:999px;border:2px solid;font:700 12px/1 monospace;letter-spacing:1px;';
  const on = base + 'border-color:rgba(94,255,94,0.7);background:rgba(94,255,94,0.15);color:#5eff5e;';
  const off = base + 'border-color:rgba(255,255,255,0.3);background:rgba(0,0,0,0.25);color:#cfeeff;';
  if (colorBtn) { colorBtn.style.cssText = G.colorMode ? on : off; }
  if (fpBtn) { fpBtn.style.cssText = G.firstPerson ? on : off; }
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
    if (G.fireworkTimer > 0) {
      parts.push('💥 ' + Math.ceil(G.fireworkTimer) + 's');
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
// Multiplayer UI
// ---------------------------------------------------------------------------

let mpModalEl = null;
let mpIndicatorEl = null;

function buildInviteButton() {
  const btn = document.getElementById('mp-invite-btn');
  if (!btn) return;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    Audio.unlock();
    showCreateModal();
  }, true);
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'rgba(94,255,94,0.8)'; btn.style.color = '#fff'; });
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'rgba(94,255,94,0.4)'; btn.style.color = '#5eff5e'; });
}

function updateMpIndicator() {
  if (!mpIndicatorEl) return;
  if (MP.connected) {
    mpIndicatorEl.textContent = (MP.role === 'host' ? 'HOSTED' : 'CONNECTED');
    mpIndicatorEl.style.color = '#5eff5e';
  } else if (MP.role) {
    mpIndicatorEl.textContent = 'CONNECTING...';
    mpIndicatorEl.style.color = '#ffe45e';
  } else {
    mpIndicatorEl.textContent = '';
  }
}

function buildMpIndicator() {
  const el = document.createElement('div');
  el.id = 'mp-indicator';
  el.style.cssText =
    'position:fixed;top:6px;right:12px;z-index:120;' +
    'font-family:monospace;font-size:11px;letter-spacing:1px;color:#5eff5e;' +
    'background:rgba(3,12,16,0.55);border:1px solid rgba(46,107,122,0.5);' +
    'border-radius:6px;padding:3px 10px;white-space:nowrap;pointer-events:none;';
  document.body.appendChild(el);
  mpIndicatorEl = el;
}

function showModal(html) {
  hideModal();
  const overlay = document.createElement('div');
  overlay.id = 'mp-modal';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';
  const box = document.createElement('div');
  box.style.cssText =
    'background:rgba(3,12,16,0.95);border:1px solid rgba(46,107,122,0.6);' +
    'border-radius:12px;padding:24px 32px;min-width:340px;max-width:520px;' +
    'font-family:monospace;color:#eaffff;';
  box.innerHTML = html;
  overlay.appendChild(box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) { e.preventDefault(); hideModal(); } }, true);
  document.body.appendChild(overlay);
  mpModalEl = overlay;
  return box;
}

function bindBtn(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.pointerEvents = 'auto';
  el.style.touchAction = 'none';
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(e); }, true);
}

function hideModal() {
  if (mpModalEl) { mpModalEl.remove(); mpModalEl = null; }
}

const STEP_STYLE = 'display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;font-size:11px;font-weight:700;margin-right:8px;';
const STEP_ACTIVE = STEP_STYLE + 'color:#030c10;background:#5eff5e;';
const STEP_DONE = STEP_STYLE + 'color:#030c10;background:#5e9eff;';
const STEP_WAIT = STEP_STYLE + 'color:rgba(234,255,255,0.3);background:rgba(46,107,122,0.3);';
const INPUT_STYLE = 'width:100%;box-sizing:border-box;padding:8px 12px;font-family:monospace;font-size:13px;background:rgba(0,0,0,0.4);border:1px solid rgba(46,107,122,0.5);border-radius:6px;color:#eaffff;letter-spacing:1px;outline:none;text-transform:uppercase;';
const BTN_GREEN = 'margin-top:16px;text-align:center;padding:10px;cursor:pointer;font-size:12px;letter-spacing:2px;color:#030c10;background:#5eff5e;border-radius:6px;font-weight:700;';
const BTN_BLUE = 'margin-top:12px;text-align:center;padding:10px;cursor:pointer;font-size:12px;letter-spacing:2px;color:#030c10;background:#5e9eff;border-radius:6px;font-weight:700;';
const LABEL = 'font-size:11px;color:rgba(234,255,255,0.5);margin-bottom:6px;';
const HINT = 'margin-top:14px;text-align:center;font-size:11px;color:rgba(234,255,255,0.4);line-height:1.6;';

function showCreateModal() {
  const name = randomMatrixName();
  const box = showModal(
    '<div style="text-align:center;margin-bottom:18px;font-size:14px;letter-spacing:2px;color:#5eff5e;">MULTIPLAYER</div>' +
    '<div style="margin-bottom:12px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_ACTIVE + '">1</span>Name your ship</div>' +
    '<input id="mp-name-input" type="text" value="' + name + '" maxlength="20" style="' + INPUT_STYLE + '" />' +
    '<div id="mp-create-btn" style="' + BTN_GREEN + '">HOST A ROOM</div>' +
    '<div style="' + HINT + '">You\'ll get a link to send to a friend.<br>Works on any device — no account needed.</div>'
  );
  bindBtn('mp-create-btn', async () => {
    const n = box.querySelector('#mp-name-input').value.trim().toUpperCase() || randomMatrixName();
    await mpCreateRoom(n);
  });
  box.querySelector('#mp-name-input').focus();
  box.querySelector('#mp-name-input').select();
}

function showWaitingUI(url, name) {
  const box = showModal(
    '<div style="text-align:center;margin-bottom:18px;font-size:14px;letter-spacing:2px;color:#5eff5e;">' + name + '</div>' +
    '<div style="margin-bottom:12px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_DONE + '">&#10003;</span>Room created</div>' +
    '<div style="margin-bottom:12px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_ACTIVE + '">2</span>Send this link to your friend</div>' +
    '<div style="position:relative;">' +
    '<input id="mp-url" type="text" readonly value="' + url + '" ' +
    'style="width:100%;box-sizing:border-box;padding:8px 12px;font-family:monospace;font-size:9px;' +
    'background:rgba(0,0,0,0.4);border:1px solid rgba(46,107,122,0.5);border-radius:6px;' +
    'color:#eaffff;letter-spacing:0.5px;outline:none;" />' +
    '<div id="mp-copy-btn" style="position:absolute;right:4px;top:4px;bottom:4px;padding:0 10px;' +
    'cursor:pointer;font-size:10px;letter-spacing:1px;color:#030c10;background:#5eff5e;' +
    'border-radius:4px;display:flex;align-items:center;">COPY</div>' +
    '</div>' +
    '<div style="margin-top:18px;font-size:12px;color:#eaffff;">' +
      '<span id="mp-step3-num" style="' + STEP_WAIT + '">3</span>Paste their answer code</div>' +
    '<textarea id="mp-answer-input" rows="3" placeholder="Waiting for friend to join..." ' +
    'style="width:100%;box-sizing:border-box;padding:8px 12px;font-family:monospace;font-size:10px;' +
    'background:rgba(0,0,0,0.4);border:1px solid rgba(46,107,122,0.5);border-radius:6px;' +
    'color:#eaffff;letter-spacing:0.5px;outline:none;resize:none;margin-top:6px;"></textarea>' +
    '<div id="mp-connect-btn" style="' + BTN_BLUE + '">CONNECT</div>' +
    '<div style="' + HINT + '">Copy the link, text it to your friend,<br>then paste the code they send back.</div>'
  );
  bindBtn('mp-copy-btn', () => {
    navigator.clipboard.writeText(url).then(() => {
      box.querySelector('#mp-copy-btn').textContent = 'COPIED!';
      setTimeout(() => { box.querySelector('#mp-copy-btn').textContent = 'COPY'; }, 1500);
    }).catch(() => {
      const inp = box.querySelector('#mp-url');
      inp.select();
      document.execCommand('copy');
      box.querySelector('#mp-copy-btn').textContent = 'COPIED!';
      setTimeout(() => { box.querySelector('#mp-copy-btn').textContent = 'COPY'; }, 1500);
    });
  });
  bindBtn('mp-connect-btn', async () => {
    const code = box.querySelector('#mp-answer-input').value.trim();
    if (!code) {
      box.querySelector('#mp-answer-input').style.borderColor = 'rgba(255,94,94,0.8)';
      box.querySelector('#mp-answer-input').placeholder = 'Paste the code your friend sent you...';
      return;
    }
    box.querySelector('#mp-connect-btn').textContent = 'CONNECTING...';
    box.querySelector('#mp-connect-btn').style.opacity = '0.6';
    try { await mpAcceptAnswer(code); } catch (err) {
      box.querySelector('#mp-connect-btn').textContent = 'CONNECT';
      box.querySelector('#mp-connect-btn').style.opacity = '1';
      box.querySelector('#mp-answer-input').style.borderColor = 'rgba(255,94,94,0.8)';
      box.querySelector('#mp-answer-input').value = '';
      box.querySelector('#mp-answer-input').placeholder = 'Invalid code — ask your friend to send it again';
    }
  });
}

function showAnswerUI(answerCode, name) {
  const box = showModal(
    '<div style="text-align:center;margin-bottom:18px;font-size:14px;letter-spacing:2px;color:#5eff5e;">' + name + '</div>' +
    '<div style="margin-bottom:12px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_DONE + '">&#10003;</span>Joined room</div>' +
    '<div style="margin-bottom:12px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_ACTIVE + '">2</span>Send this code to the host</div>' +
    '<textarea id="mp-answer-code" rows="4" readonly ' +
    'style="width:100%;box-sizing:border-box;padding:8px 12px;font-family:monospace;font-size:9px;' +
    'background:rgba(0,0,0,0.4);border:1px solid rgba(46,107,122,0.5);border-radius:6px;' +
    'color:#eaffff;letter-spacing:0.5px;outline:none;resize:none;">' + answerCode + '</textarea>' +
    '<div id="mp-copy-answer" style="' + BTN_GREEN + '">COPY CODE &amp; SHARE</div>' +
    '<div style="' + HINT + '">Copy this code and send it to the host<br>(text, email, carrier pigeon, etc.)<br><br>The game will start once the host pastes your code.</div>'
  );
  bindBtn('mp-copy-answer', () => {
    navigator.clipboard.writeText(answerCode).then(() => {
      box.querySelector('#mp-copy-answer').textContent = 'COPIED!';
      setTimeout(() => { box.querySelector('#mp-copy-answer').textContent = 'COPY CODE & SHARE'; }, 1500);
    }).catch(() => {
      box.querySelector('#mp-answer-code').select();
      document.execCommand('copy');
      box.querySelector('#mp-copy-answer').textContent = 'COPIED!';
      setTimeout(() => { box.querySelector('#mp-copy-answer').textContent = 'COPY CODE & SHARE'; }, 1500);
    });
  });
}

function showJoinModal(encoded) {
  const name = randomMatrixName();
  const box = showModal(
    '<div style="text-align:center;margin-bottom:18px;font-size:14px;letter-spacing:2px;color:#5eff5e;">JOIN MULTIPLAYER</div>' +
    '<div style="margin-bottom:4px;font-size:12px;color:rgba(234,255,255,0.6);line-height:1.5;">' +
      'A friend invited you to play.<br>Enter a ship name to join the game.</div>' +
    '<div style="margin-top:14px;margin-bottom:8px;font-size:12px;color:#eaffff;">' +
      '<span style="' + STEP_ACTIVE + '">1</span>Name your ship</div>' +
    '<input id="mp-name-input" type="text" value="' + name + '" maxlength="20" style="' + INPUT_STYLE + '" />' +
    '<div id="mp-join-btn" style="' + BTN_GREEN + '">JOIN GAME</div>' +
    '<div style="' + HINT + '">After joining, you\'ll get a code to send back<br>to the host to finish connecting.</div>'
  );
  bindBtn('mp-join-btn', async () => {
    const n = box.querySelector('#mp-name-input').value.trim().toUpperCase() || randomMatrixName();
    box.querySelector('#mp-join-btn').textContent = 'JOINING...';
    box.querySelector('#mp-join-btn').style.opacity = '0.6';
    try { await mpJoinRoom(encoded, n); } catch (err) {
      box.querySelector('#mp-join-btn').textContent = 'JOIN GAME';
      box.querySelector('#mp-join-btn').style.opacity = '1';
      box.querySelector('#mp-name-input').style.borderColor = 'rgba(255,94,94,0.8)';
    }
  });
  box.querySelector('#mp-name-input').focus();
  box.querySelector('#mp-name-input').select();
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
  buildInviteButton();
  buildMpIndicator();

  const hash = location.hash;
  if (hash && hash.startsWith('#room=')) {
    const encoded = hash.substring(6);
    showJoinModal(encoded);
    history.replaceState(null, '', location.pathname + location.search);
  }

  resetGame();
  r360.start();
}

window.React360 = {init};
