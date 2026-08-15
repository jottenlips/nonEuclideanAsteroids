/**
 * 3D Asteroids for React VR (React 360)
 *
 * Game engine lives on the browser main thread (client.js). The whole arena is
 * the surface of a wireframe sphere ("sphere map"): the player ship, asteroids
 * and shots all slide around the globe. Crossing the longitude seam pops you
 * onto the opposite side of the sphere; crossing a pole mirrors you over it.
 *
 * React renders the minimalist wireframe HUD to a floating 2D Surface, and the
 * game pushes state into it through the runtime bridge (GameHUD module).
 */

import {ReactInstance, Surface} from 'react-360-web';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const RADIUS = 60;                 // radius of the sphere arena (world units)
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
const MIN_SPAWN_ANGLE = 0.55;      // min angular distance from ship (rad)
const HUD_SYNC_INTERVAL = 0.12;    // s

// ---------------------------------------------------------------------------
// Reusable scratch objects (avoid allocation during the game loop)
// ---------------------------------------------------------------------------

const _Z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _eT = new THREE.Vector3();
const _eP = new THREE.Vector3();
const _F = new THREE.Vector3();
const _Rv = new THREE.Vector3();
const _Up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();
const _basisQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Camera: hovers above the ship, which stays centered in view. Mouse drag
// orbits the camera around the ship (yaw / pitch) to "move the sphere".
// ---------------------------------------------------------------------------

const CAM_DIST = 2.6 * RADIUS;      // camera distance from the sphere center
const VIEW = {yaw: 0, pitch: 0.42, tYaw: 0, tPitch: 0.42};

// Camera + HUD panel scratch objects
const _upWorld = new THREE.Vector3(0, 1, 0);
const _camPosV = new THREE.Vector3();
const _smoothCam = new THREE.Vector3();
const _shipPosV = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _lookZ = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _lookUp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _camUpV = new THREE.Vector3();
const _panelPos = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _pRight = new THREE.Vector3();
const _pUp = new THREE.Vector3();
const _camMat = new THREE.Matrix4();
const _camQuat = new THREE.Quaternion();

// Continuous camera frame (no flip when the ship crosses a pole)
const _refT = new THREE.Vector3(0, 1, 0);
const _refE = new THREE.Vector3();
const _prevN = new THREE.Vector3(0, 1, 0);
const _stepQuat = new THREE.Quaternion();
let _refInit = false;

let mouseDown = false;
let lastMX = 0;
let lastMY = 0;

// ---------------------------------------------------------------------------
// Tiny synthesized audio (WebAudio, created on first user gesture)
// ---------------------------------------------------------------------------

const Audio = (() => {
  let ctx = null;
  let master = null;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      return;
    }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }

  function tone(freq, endFreq, dur, type, vol, when) {
    if (!ctx) {
      return;
    }
    const t0 = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
    }
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, when) {
    if (!ctx) {
      return;
    }
    const t0 = ctx.currentTime + (when || 0);
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    }
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
    shoot() {
      ensure();
      tone(920, 240, 0.12, 'square', 0.1);
    },
    explode() {
      ensure();
      noise(0.3, 0.28);
      tone(170, 38, 0.35, 'sawtooth', 0.18);
    },
    die() {
      ensure();
      noise(0.6, 0.4);
      tone(140, 28, 0.6, 'sawtooth', 0.28);
    },
    wave() {
      ensure();
      tone(440, 440, 0.08, 'square', 0.09);
      tone(660, 660, 0.09, 'square', 0.09, 0.1);
      tone(880, 880, 0.12, 'square', 0.09, 0.2);
    },
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
let hudSurface = null;

const keys = {};

let lastMs = 0;
let hudTimer = 0;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function wrapAngle(a) {
  a = a % TWO_PI;
  if (a > PI) {
    a -= TWO_PI;
  }
  if (a < -PI) {
    a += TWO_PI;
  }
  return a;
}

function posOnSphere(theta, phi, out) {
  const cp = Math.cos(phi);
  out.set(
    RADIUS * cp * Math.cos(theta),
    RADIUS * Math.sin(phi),
    RADIUS * cp * Math.sin(theta)
  );
  return out;
}

/**
 * Sphere wrap: longitude wraps to the opposite side (off one edge of the
 * sphere map -> appear on the opposite end). Crossing a pole mirrors the
 * position onto the other meridian and flips the tangent velocity (and, if
 * present, the heading) so motion stays continuous across the pole.
 */
function wrapBody(body) {
  if (body.theta > PI) {
    body.theta -= TWO_PI;
  } else if (body.theta < -PI) {
    body.theta += TWO_PI;
  }
  if (body.phi > PI_HALF) {
    body.phi = PI - body.phi;
    body.theta = wrapAngle(body.theta + PI);
    body.vTheta = -body.vTheta;
    body.vPhi = -body.vPhi;
    if (body.heading !== undefined) {
      body.heading = wrapAngle(body.heading + PI);
    }
  } else if (body.phi < -PI_HALF) {
    body.phi = -PI - body.phi;
    body.theta = wrapAngle(body.theta + PI);
    body.vTheta = -body.vTheta;
    body.vPhi = -body.vPhi;
    if (body.heading !== undefined) {
      body.heading = wrapAngle(body.heading + PI);
    }
  }
}

function angDist(a, b) {
  const c =
    Math.sin(a.phi) * Math.sin(b.phi) +
    Math.cos(a.phi) * Math.cos(b.phi) * Math.cos(a.theta - b.theta);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/**
 * Orient an object that lies flat on the sphere surface: local +Z is the
 * tangent heading, local +Y is the outward normal. Optional `bank` rolls it
 * around the heading axis.
 */
function placeOriented(mesh, body) {
  const {theta, phi, heading, bank} = body;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);

  _n.set(cp * ct, sp, cp * st);
  _eT.set(-st, 0, ct);
  _eP.set(-sp * ct, cp, -sp * st);

  const sh = Math.sin(heading);
  const ch = Math.cos(heading);
  _F.copy(_eT).multiplyScalar(sh).addScaledVector(_eP, ch).normalize();

  _Rv.crossVectors(_n, _F).normalize();
  _Up.crossVectors(_F, _Rv).normalize();

  _basisMat.makeBasis(_Rv, _Up, _F);
  _basisQuat.setFromRotationMatrix(_basisMat);
  if (bank) {
    _rollQuat.setFromAxisAngle(_Z, bank);
    _basisQuat.multiply(_rollQuat);
  }
  mesh.quaternion.copy(_basisQuat);
  posOnSphere(theta, phi, _pos);
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

function buildGrid() {
  const grid = new THREE.Group();
  const matDim = new THREE.LineBasicMaterial({
    color: 0x14404d,
    transparent: true,
    opacity: 0.6,
  });
  const matPrime = new THREE.LineBasicMaterial({
    color: 0x2c6f80,
    transparent: true,
    opacity: 0.8,
  });
  const matEq = new THREE.LineBasicMaterial({
    color: 0x3d95a8,
    transparent: true,
    opacity: 0.85,
  });

  const MER = 16;
  for (let i = 0; i < MER; i++) {
    const th = (i / MER) * TWO_PI;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const ph = -PI_HALF + (k / 64) * PI;
      pts.push(
        new THREE.Vector3(
          RADIUS * Math.cos(ph) * Math.cos(th),
          RADIUS * Math.sin(ph),
          RADIUS * Math.cos(ph) * Math.sin(th)
        )
      );
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), i === 0 ? matPrime : matDim));
  }

  const PAR = 8;
  for (let i = 1; i < PAR; i++) {
    const ph = -PI_HALF + (i / PAR) * PI;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const th = (k / 64) * TWO_PI;
      pts.push(
        new THREE.Vector3(
          RADIUS * Math.cos(ph) * Math.cos(th),
          RADIUS * Math.sin(ph),
          RADIUS * Math.cos(ph) * Math.sin(th)
        )
      );
    }
    grid.add(new THREE.LineLoop(pointsToGeo(pts), matDim));
  }

  const eq = [];
  for (let k = 0; k <= 64; k++) {
    const th = (k / 64) * TWO_PI;
    eq.push(new THREE.Vector3(RADIUS * Math.cos(th), 0, RADIUS * Math.sin(th)));
  }
  grid.add(new THREE.LineLoop(pointsToGeo(eq), matEq));

  return grid;
}

// Quadrant fill colors (NE/NW/SE/SW) shared by the sphere and asteroids
const QUADRANT_COLORS = [0x3ad6ff, 0x3dffa5, 0xff9d3d, 0xc14dff];

function quadrantColor(theta, phi) {
  const north = phi >= 0;
  const east = Math.cos(theta) >= 0;
  if (north) {
    return east ? QUADRANT_COLORS[0] : QUADRANT_COLORS[1];
  }
  return east ? QUADRANT_COLORS[2] : QUADRANT_COLORS[3];
}

function buildQuadrant(phi0, phi1, th0, th1, color) {
  const SEG = 24;
  const vertices = [];
  const indices = [];
  const r = RADIUS * 0.995;
  const n = SEG + 1;
  for (let i = 0; i <= SEG; i++) {
    const ph = phi0 + ((phi1 - phi0) * i) / SEG;
    for (let j = 0; j <= SEG; j++) {
      const th = th0 + ((th1 - th0) * j) / SEG;
      vertices.push(
        r * Math.cos(ph) * Math.cos(th),
        r * Math.sin(ph),
        r * Math.cos(ph) * Math.sin(th)
      );
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
  const m = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  m.renderOrder = -10;
  return m;
}

function buildQuadrants() {
  const group = new THREE.Group();
  const h = PI_HALF;
  group.add(buildQuadrant(0, h, -h, h, QUADRANT_COLORS[0])); // NE
  group.add(buildQuadrant(0, h, h, 3 * h, QUADRANT_COLORS[1])); // NW
  group.add(buildQuadrant(-h, 0, -h, h, QUADRANT_COLORS[2])); // SE
  group.add(buildQuadrant(-h, 0, h, 3 * h, QUADRANT_COLORS[3])); // SW
  return group;
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
  const m = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  return new THREE.Points(g, m);
}

function buildShip() {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({
    color: 0xaef4f4,
    transparent: true,
    opacity: 0.95,
  });
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

  const engMat = new THREE.LineBasicMaterial({
    color: 0xffb45c,
    transparent: true,
    opacity: 0.9,
  });
  engineMesh = new THREE.LineSegments(
    pointsToGeo([
      new THREE.Vector3(0, 0, -3.2),
      new THREE.Vector3(0, 0, -4.4),
    ]),
    engMat
  );
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
  const mat = new THREE.LineBasicMaterial({
    color: 0xc6d3db,
    transparent: true,
    opacity: 0.9,
  });
  return new THREE.LineSegments(wire, mat);
}

const bulletWire = new THREE.WireframeGeometry(new THREE.OctahedronGeometry(0.5, 0));
const bulletMat = new THREE.LineBasicMaterial({
  color: 0xffd98a,
  transparent: true,
  opacity: 1,
});

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
  for (const b of bullets) {
    scene.remove(b.mesh);
  }
  bullets = [];
  for (const a of asteroids) {
    scene.remove(a.mesh);
  }
  asteroids = [];
  for (const f of fx) {
    scene.remove(f.mesh);
  }
  fx = [];

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
  syncHud();
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
  const count = Math.min(3 + G.wave, 11);
  for (let i = 0; i < count; i++) {
    spawnAsteroid(0);
  }
  setMsg('WAVE ' + G.wave, 1.8);
  Audio.wave();
}

function spawnAsteroid(tier) {
  let theta = 0;
  let phi = 0;
  for (let tries = 0; tries < 40; tries++) {
    theta = (Math.random() * 2 - 1) * PI;
    phi = (Math.random() * 2 - 1) * PI_HALF;
    if (angDist({theta, phi}, G) > MIN_SPAWN_ANGLE) {
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
      Math.random() * 2 - 1
    ).normalize(),
    spinSpeed: 0.4 + Math.random() * 0.9,
  };
  asteroids.push(a);
  scene.add(mesh);
  return a;
}

function removeAsteroid(a) {
  const idx = asteroids.indexOf(a);
  if (idx >= 0) {
    asteroids.splice(idx, 1);
  }
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

function hitAsteroid(bullet, asteroid) {
  G.score += SCORES[asteroid.tier];
  Audio.explode();
  const pos = posOnSphere(asteroid.theta, asteroid.phi, _tmp.clone());
  spawnRing(pos, 0x9ff2ff, {life: 0.35, grow: 26});

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
  if (G.invuln > 0) {
    return;
  }
  Audio.die();
  const pos = posOnSphere(G.theta, G.phi, _tmp.clone());
  spawnRing(pos, 0xff6b6b, {life: 0.6, grow: 34});
  shipMesh.visible = false;
  G.lives--;
  if (G.lives < 0) {
    G.status = 'over';
    G.msg = 'GAME OVER · PRESS R TO RESTART';
  } else {
    setMsg('SHIP DESTROYED', 1.6);
    G.respawnTimer = RESPAWN_TIME;
  }
}

function spawnRing(pos, color, opts) {
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.LineLoop(ringGeo, mat);
  mesh.position.copy(pos);
  mesh.quaternion.setFromUnitVectors(_Z, pos.clone().normalize());
  scene.add(mesh);
  fx.push({mesh, mat, life: opts.life, maxLife: opts.life, grow: opts.grow});
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
    posOnSphere(a.theta, a.phi, _pos);
    a.mesh.position.copy(_pos);
    _spinQ.setFromAxisAngle(a.spinAxis, a.spinSpeed * dt);
    a.mesh.quaternion.multiply(_spinQ);
  }
}

function handleCollisions() {
  if (asteroids.length === 0) {
    return;
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    posOnSphere(b.theta, b.phi, _tmp);
    for (let j = asteroids.length - 1; j >= 0; j--) {
      const a = asteroids[j];
      posOnSphere(a.theta, a.phi, _tmp2);
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
    posOnSphere(G.theta, G.phi, _tmp);
    for (const a of asteroids) {
      posOnSphere(a.theta, a.phi, _tmp2);
      const rr = a.radius + SHIP_RADIUS;
      if (_tmp.distanceToSquared(_tmp2) < rr * rr) {
        killShip();
        break;
      }
    }
  }
}

function update(dt) {
  if (dt <= 0) {
    return;
  }

  if (G.msgTimer > 0) {
    G.msgTimer -= dt;
    if (G.msgTimer <= 0) {
      G.msg = '';
    }
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
    if (G.respawnTimer <= 0) {
      respawnShip();
    }
  }
  if (G.invuln > 0) {
    G.invuln -= dt;
  }

  const shipAlive = G.respawnTimer <= 0;

  if (shipAlive) {
    const left = !!(keys.ArrowLeft || keys.a);
    const right = !!(keys.ArrowRight || keys.d);
    const up = !!(keys.ArrowUp || keys.w);

    if (left) {
      G.heading -= TURN_RATE * dt;
      G.targetBank = -0.5;
    } else if (right) {
      G.heading += TURN_RATE * dt;
      G.targetBank = 0.5;
    } else {
      G.targetBank = 0;
    }
    G.heading = wrapAngle(G.heading);
    G.bank += (G.targetBank - G.bank) * Math.min(1, dt * 7);

    if (up) {
      G.vTheta += Math.sin(G.heading) * ACCEL * dt;
      G.vPhi += Math.cos(G.heading) * ACCEL * dt;
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
// HUD bridge (client -> React bundle)
// ---------------------------------------------------------------------------

function syncHud() {
  if (!r360) {
    return;
  }
  const state = {
    score: G.score,
    lives: Math.max(0, G.lives),
    wave: G.wave,
    status: G.status,
    msg: G.msg,
    ship: G.respawnTimer <= 0 ? {theta: G.theta, phi: G.phi} : null,
    asteroids: asteroids.map(a => ({theta: a.theta, phi: a.phi, r: a.radius})),
  };
  try {
    r360.runtime.callFunction('GameHUD', 'update', [state]);
  } catch (e) {
    // Worker may not have finished loading the bundle yet.
  }
}

// ---------------------------------------------------------------------------
// Frame loop + input
// ---------------------------------------------------------------------------

function computeCamera() {
  posOnSphere(G.theta, G.phi, _shipPosV);
  _n.copy(_shipPosV).normalize();

  if (!_refInit) {
    _refT.copy(_upWorld).addScaledVector(_n, -_upWorld.dot(_n));
    if (_refT.lengthSq() < 1e-6) {
      _refT.set(0, 0, 1);
    }
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
  _camPosV.copy(_camDir).multiplyScalar(CAM_DIST);
}

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
  if (_lookUp.lengthSq() < 1e-6) {
    _lookUp.copy(_refT);
  }
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
  if (k === ' ' || k.indexOf('Arrow') === 0) {
    e.preventDefault();
  }
  keys[k] = true;
  if (k === 'r' && G.status === 'over') {
    resetGame();
  }
}

function onKeyUp(e) {
  keys[keyName(e)] = false;
}

function onBlur() {
  for (const k in keys) {
    keys[k] = false;
  }
}

function onMouseDown(e) {
  Audio.unlock();
  mouseDown = true;
  lastMX = e.clientX;
  lastMY = e.clientY;
}

function onMouseMove(e) {
  if (!mouseDown) {
    return;
  }
  const dx = e.clientX - lastMX;
  const dy = e.clientY - lastMY;
  lastMX = e.clientX;
  lastMY = e.clientY;
  VIEW.tYaw -= dx * 0.008;
  VIEW.tPitch = Math.max(0.05, Math.min(1.35, VIEW.tPitch - dy * 0.008));
}

function onMouseUp() {
  mouseDown = false;
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
  scene.add(buildGrid());
  scene.add(buildQuadrants());
  scene.add(buildStars(1100, 720, 1400, 0xffffff, 1.6));
  scene.add(buildStars(70, 720, 1400, 0x8ff7ff, 3.2));

  shipMesh = buildShip();
  scene.add(shipMesh);

  computeCamera();
  _smoothCam.copy(_camPosV);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mouseleave', onMouseUp);

  resetGame();
  r360.start();
}

window.React360 = {init};
