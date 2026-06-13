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
    this.theta    = 0;
    this._baseR   = 5;   // bbox radius captured at start()
    // Live orbit parameters — bound to the Studio "Orbit Tour" folder so the
    // user can reshape the tour while it plays. All distances are multiples
    // of the scene's bounding radius, so they read sanely on any scene.
    this.orbit = {
      turnSeconds: 40,    // seconds for one full revolution
      radiusScale: 1.6,   // orbit radius        = radiusScale * boundsRadius
      heightScale: 0.30,  // camera height        = heightScale * boundsRadius
      lookHeight:  0.05,  // look-at point height = lookHeight  * boundsRadius
      direction:   1,     // +1 clockwise, -1 counter-clockwise
    };
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
    this._baseR = Math.max(radius, 0.01);
    // Seed the starting compass angle from the current pose so the orbit
    // eases out of wherever the user is looking; distance/height/speed are
    // all driven live from this.orbit so the Studio sliders take effect
    // immediately, even mid-tour.
    const off = this.camera.position.clone().sub(center);
    this.theta = Math.atan2(off.z, off.x);
    this._ease = 0;
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

    // orbit — all dimensions read live from this.orbit so Studio sliders
    // reshape the tour mid-flight.
    const o = this.orbit;
    const turn = Math.max(o.turnSeconds, 1);
    const dir  = o.direction < 0 ? -1 : 1;
    this.theta += (Math.PI * 2 / turn) * dt * ease * dir;
    const r = this._baseR * o.radiusScale;
    const h = this._baseR * o.heightScale;
    this.camera.position.set(
      this.center.x + Math.cos(this.theta) * r,
      this.center.y + h,
      this.center.z + Math.sin(this.theta) * r,
    );
    this.controls.target.set(
      this.center.x,
      this.center.y + this._baseR * o.lookHeight,
      this.center.z,
    );
    this.controls.update();
  }
}
