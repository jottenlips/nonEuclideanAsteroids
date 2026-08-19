/**
 * 3D Asteroids — React VR (React 360) HUD
 *
 * Minimalist wireframe HUD rendered by React onto a floating 2D Surface.
 * The game client (main thread) pushes state into this bundle through the
 * runtime bridge (`r360.runtime.callFunction('GameHUD', 'update', [state])`),
 * which is registered below as a callable module.
 */

import React from 'react';
import {AppRegistry, StyleSheet, Text, View} from 'react-360';
import BatchedBridge from 'react-native/Libraries/BatchedBridge/BatchedBridge';

const PI = Math.PI;
const TWO_PI = 2 * PI;
const PI_HALF = PI / 2;

// --- Bridge: client -> React ------------------------------------------------

const listeners = new Set();

const GameHUDModule = {
  update(state) {
    listeners.forEach(fn => fn(state));
  },
};

BatchedBridge.registerCallableModule('GameHUD', GameHUDModule);

// --- Mini sphere-map --------------------------------------------------------

function mapPoint(theta, phi) {
  return {
    x: (theta + PI) / TWO_PI,
    y: (PI_HALF - phi) / PI,
  };
}

function MiniMap({ship, asteroids}) {
  const W = 250;
  const H = 132;
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - 9;
  const ry = H / 2 - 8;

  const dots = [];
  if (ship) {
    dots.push({x: ship.theta, y: ship.phi, r: 5, color: '#7dffec'});
  }
  for (const a of asteroids) {
    dots.push({
      x: a.theta,
      y: a.phi,
      r: Math.max(4, Math.min(10, a.r * 2.2)),
      color: 'rgba(255,150,120,0.9)',
    });
  }

  const rendered = [];
  let key = 0;
  for (const d of dots) {
    const base = mapPoint(d.x, d.y);
    for (const x of [base.x, base.x - 1, base.x + 1]) {
      if (x < -0.02 || x > 1.02) {
        continue;
      }
      rendered.push({
        key: key++,
        left: cx - rx + x * 2 * rx,
        top: cy - ry + base.y * 2 * ry,
        size: d.r * 2,
        color: d.color,
      });
    }
  }

  return (
    <View
      style={{
        width: W,
        height: H,
        borderWidth: 1,
        borderColor: '#2e6b7a',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: cx - rx,
          top: cy - ry,
          width: 2 * rx,
          height: 2 * ry,
          borderRadius: rx,
          borderWidth: 1,
          borderColor: '#2f7d90',
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: cx,
          top: 0,
          width: 1,
          height: H,
          backgroundColor: 'rgba(46,107,122,0.35)',
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: cy,
          width: W,
          height: 1,
          backgroundColor: 'rgba(46,107,122,0.35)',
        }}
      />
      {rendered.map(d => (
        <View
          key={d.key}
          style={{
            position: 'absolute',
            left: d.left,
            top: d.top,
            width: d.size,
            height: d.size,
            borderRadius: d.size / 2,
            backgroundColor: d.color,
          }}
        />
      ))}
    </View>
  );
}

// --- HUD --------------------------------------------------------------------

class HUD extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      score: 0,
      lives: 3,
      wave: 0,
      status: 'ready',
      msg: 'READY',
      ship: null,
      asteroids: [],
    };
  }

  componentDidMount() {
    this._mounted = true;
    this._onState = state => {
      if (this._mounted) {
        this.setState(state);
      }
    };
    listeners.add(this._onState);
  }

  componentWillUnmount() {
    this._mounted = false;
    listeners.delete(this._onState);
  }

  render() {
    const {score, lives, wave, status, msg, ship, asteroids} = this.state;
    const pad = (n, len) => String(n).padStart(len, '0');
    const msgColor =
      status === 'over' ? '#ff7b7b' : status === 'playing' ? '#6ff7ff' : '#9fe8ea';

    return (
      <View style={styles.panel}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{'//3D·ASTEROIDS'}</Text>
            <Text style={styles.subtitle}>{'REACT·VR · WIREFRAME'}</Text>
          </View>
          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>SCORE</Text>
              <Text style={styles.statValue}>{pad(score, 6)}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>WAVE</Text>
              <Text style={styles.statValue}>{pad(wave, 2)}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>SHIPS</Text>
              <Text style={styles.statValue}>{'▲'.repeat(Math.max(0, lives))}</Text>
            </View>
          </View>
        </View>

        <View style={styles.body}>
          <Text style={[styles.msg, {color: msgColor}]}>{msg}</Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.hint}>
            {'←→ / AD · TURN    ↑ / W · THRUST    SPACE · FIRE    R · RESTART'}
          </Text>
          <MiniMap ship={ship} asteroids={asteroids} />
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  panel: {
    width: 1000,
    height: 360,
    backgroundColor: 'rgba(3, 12, 16, 0.45)',
    borderColor: '#2e6b7a',
    borderWidth: 1,
    padding: 22,
    paddingBottom: 18,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {
    color: '#c8ffff',
    fontSize: 30,
    letterSpacing: 3,
    fontFamily: 'monospace',
  },
  subtitle: {
    color: '#3f7f8a',
    fontSize: 15,
    letterSpacing: 2,
    marginTop: 6,
    fontFamily: 'monospace',
  },
  stats: {flexDirection: 'row'},
  stat: {marginLeft: 26, alignItems: 'flex-end'},
  statLabel: {
    color: '#3f8f9a',
    fontSize: 14,
    letterSpacing: 3,
    fontFamily: 'monospace',
  },
  statValue: {
    color: '#eaffff',
    fontSize: 30,
    letterSpacing: 2,
    marginTop: 4,
    fontFamily: 'monospace',
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 6,
  },
  msg: {
    fontSize: 28,
    letterSpacing: 4,
    fontFamily: 'monospace',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  hint: {
    color: '#4d7b86',
    fontSize: 15,
    letterSpacing: 1,
    fontFamily: 'monospace',
  },
});

AppRegistry.registerComponent('HUD', () => HUD);
