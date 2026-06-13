// ---------------------------------------------------------------------------
// Turntable — scene-agnostic automatic camera tours. Two modes:
//
//   "orbit"    — a bounding-sphere-derived turntable. The bundled scene
//                ships a hand-authored flythrough (the camera-move
//                AnimationMixer in main.js) tied to the garden's frame; any
//                OTHER splat dragged in has its own origin/scale, so the
//                authored clip points at nothing. Orbit is the zero-config
//                fallback: radius, height, and look-at are all derived from
//                mesh.userData.bounds, framing any scene automatically.
//
//   "sequence" — the user-authored tour. The Viewpoints panel already lets
//                visitors stamp camera poses; this strings them into one
//                smooth flight. Position and target each ride a closed
//                Catmull-Rom spline through the saved poses, so the camera
//                eases through every viewpoint and loops back to the first.
//                This is the "record your own camera move" path discussed
//                as the customizable counterpart to the procedural orbit:
//                drop a few viewpoints, press play, no euler-angle tuning.
//
// Both modes are plain rAF-driven math (no AnimationMixer — nothing to
// bake) and stop on any canvas pointerdown so the user can grab control.
// ---------------------------------------------------------------------------

import * as THREE from "three";

const FULL_TURN_S    = 48;    // orbit: seconds per revolution (museum pace)
const EASE_IN_S      = 1.6;   // ramp from rest into full speed (both modes)
const SEQ_DEFAULT_S  = 4.0;   // sequence: seconds spent per viewpoint segment

export class Turntable {
  constructor({ camera, controls }) {
    this.camera   = camera;
    this.controls = controls;
    this.active   = false;
    this.mode     = "orbit";
    // orbit state
    this.center   = new THREE.Vector3();
    this.rOrbit   = 5;
    this.height   = 1;
    this.theta    = 0;
    // sequence state
    this.posCurve = null;
    this.tgtCurve = null;
    this._seqDur  = 1;
    this._u       = 0;
    // shared
    this._ease    = 0;
  }

  // ---- Orbit mode --------------------------------------------------------
  start(center, radius) {
    this.mode = "orbit";
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

  toggleOrbit(center, radius) {
    if (this.active && this.mode === "orbit") { this.stop(); return false; }
    this.start(center, radius);
    return true;
  }

  // ---- Sequence mode -----------------------------------------------------
  // poses: [{ position: Vec3, target: Vec3 }, ...] in any order the user
  // saved them. Returns the running state (false if there aren't enough
  // viewpoints to interpolate).
  playSequence(poses, perSegmentSec = SEQ_DEFAULT_S) {
    if (this.active && this.mode === "sequence") { this.stop(); return false; }
    if (!Array.isArray(poses) || poses.length < 2) return false;

    // Closed Catmull-Rom through the saved poses: the camera flows through
    // every viewpoint and returns to the first, so the tour loops cleanly.
    // "centripetal" parameterization avoids the cusps/overshoot a uniform
    // spline produces when viewpoint spacing is uneven.
    const posPts = poses.map(p => p.position.clone());
    const tgtPts = poses.map(p => p.target.clone());
    this.posCurve = new THREE.CatmullRomCurve3(posPts, true, "centripetal");
    this.tgtCurve = new THREE.CatmullRomCurve3(tgtPts, true, "centripetal");
    this._seqDur  = Math.max(poses.length * perSegmentSec, 1);
    this._u       = 0;
    this._ease    = 0;
    this.mode     = "sequence";
    this.active   = true;
    this.controls.enabled = false;   // the spline owns the camera while playing
    return true;
  }

  stop() {
    this.active = false;
    this.controls.enabled = true;
  }

  // ---- Per-frame driver --------------------------------------------------
  update(dt) {
    if (!this.active) return;
    this._ease = Math.min(this._ease + dt / EASE_IN_S, 1.0);
    const ease = this._ease * this._ease * (3.0 - 2.0 * this._ease);

    if (this.mode === "sequence") {
      this._u = (this._u + (dt / this._seqDur) * ease) % 1;
      this.camera.position.copy(this.posCurve.getPoint(this._u));
      this.controls.target.copy(this.tgtCurve.getPoint(this._u));
      this.controls.update();
      return;
    }

    // orbit
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
