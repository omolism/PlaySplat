// ---------------------------------------------------------------------------
// Turntable — scene-agnostic camera tour derived from a bounding sphere.
//
// The bundled scene ships a hand-authored 16.67 s flythrough (the camera
// move AnimationMixer in main.js) that assumes the garden's coordinate
// frame. Any OTHER splat the user drags in has its own origin, scale, and
// up-axis convention, so the authored clip points at nothing. This module
// is the procedural fallback: an orbit whose radius, height, and look-at
// target are all derived from the layer's bounding sphere (stashed on
// mesh.userData.bounds by createSplat), so it frames any scene with zero
// configuration.
//
// Design choices:
//   * The orbit is seeded from the CURRENT camera pose (angle, height, and
//     distance are read from where the user already is, then clamped into
//     a sane band) — pressing Tour eases into motion instead of teleporting.
//   * Plain rAF-driven math, no AnimationMixer — there is nothing to bake.
//   * Any pointerdown on the canvas stops the tour (user grabs the orbit).
// ---------------------------------------------------------------------------

import * as THREE from "three";

const FULL_TURN_S = 48;    // seconds per revolution — unhurried museum pace
const EASE_IN_S   = 1.6;   // ramp from rest into full angular speed

export class Turntable {
  constructor({ camera, controls }) {
    this.camera   = camera;
    this.controls = controls;
    this.active   = false;
    this.center   = new THREE.Vector3();
    this.rOrbit   = 5;
    this.height   = 1;
    this.theta    = 0;
    this._ease    = 0;
  }

  start(center, radius) {
    this.center.copy(center);
    // Seed the orbit from the current pose so entry is seamless: keep the
    // user's compass angle and height, but clamp the orbit radius into a
    // band that's guaranteed to frame the bounding sphere.
    const off = this.camera.position.clone().sub(center);
    const horiz = Math.hypot(off.x, off.z);
    this.theta  = Math.atan2(off.z, off.x);
    this.rOrbit = THREE.MathUtils.clamp(horiz, radius * 0.9, radius * 2.2);
    if (!Number.isFinite(this.rOrbit) || this.rOrbit < 1e-3) this.rOrbit = radius * 1.5;
    this.height = THREE.MathUtils.clamp(off.y, radius * 0.1, radius * 0.9);
    this._ease  = 0;
    this.active = true;
  }

  stop() { this.active = false; }

  toggle(center, radius) {
    if (this.active) this.stop();
    else this.start(center, radius);
    return this.active;
  }

  update(dt) {
    if (!this.active) return;
    this._ease = Math.min(this._ease + dt / EASE_IN_S, 1.0);
    const ease = this._ease * this._ease * (3.0 - 2.0 * this._ease);
    this.theta += (Math.PI * 2 / FULL_TURN_S) * dt * ease;
    this.camera.position.set(
      this.center.x + Math.cos(this.theta) * this.rOrbit,
      this.center.y + this.height,
      this.center.z + Math.sin(this.theta) * this.rOrbit,
    );
    this.controls.target.copy(this.center);
    this.controls.update();
  }
}
