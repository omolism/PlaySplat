import * as THREE from "three";
import { haptic }    from "./haptic.js";
import { playSound } from "./sounds.js";

// ---------------------------------------------------------------------------
// Sketchfab-style annotation system.
// Each viewpoint = a saved camera pose (position + target) anchored to a 3D
// point in world space. The world point gets a numbered hotspot rendered in
// HTML, projected to screen every frame. Clicking it (or the sidebar row)
// smoothly tweens the camera over to that pose.
// ---------------------------------------------------------------------------

let _id = 0;
const nextId = () => ++_id;

export class AnnotationManager {
  constructor({ camera, controls, layerEl, listEl, addBtnEl, statusEl, storageKey = null }) {
    this.camera = camera;
    this.controls = controls;
    this.layerEl = layerEl;
    this.listEl = listEl;
    this.statusEl = statusEl;
    this.storageKey = storageKey;
    this._suspendSave = false;

    this.viewpoints = []; // { id, name, anchor:Vec3, position:Vec3, target:Vec3, el:HTMLElement }
    this.activeId = null;
    this.tween = null;

    // Pending "click on splat to anchor" mode triggered by + Add
    this.pendingAdd = false;
    this.onArmedChange = null;

    addBtnEl.addEventListener("click", () => {
      this.armAddViewpoint();
    });

    // Hidden world-position scratch buffer
    this._v = new THREE.Vector3();
    this._raycaster = null; // set externally
  }

  setStorageKey(key) {
    this.storageKey = key;
  }

  _save() {
    if (this._suspendSave || !this.storageKey) return;
    try {
      const data = this.viewpoints.map(v => ({
        name: v.name,
        anchor:   [v.anchor.x,   v.anchor.y,   v.anchor.z],
        position: [v.position.x, v.position.y, v.position.z],
        target:   [v.target.x,   v.target.y,   v.target.z],
        createdAt: v.createdAt,
      }));
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (_) { /* quota / disabled — silent */ }
  }

  /**
   * Replace current viewpoints with whatever is in localStorage under storageKey.
   * @returns {boolean} true if at least one viewpoint was restored.
   */
  restoreFromStorage() {
    if (!this.storageKey) return false;
    let raw;
    try { raw = localStorage.getItem(this.storageKey); } catch { return false; }
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    if (!Array.isArray(data) || data.length === 0) return false;

    // Wipe + bulk-restore. Suspend save BEFORE removes so the shrinking
    // viewpoints array never gets written back to storage as `[]` mid-way.
    this._suspendSave = true;
    try {
      this.viewpoints.slice().forEach(vp => this.removeViewpoint(vp.id));
      for (const d of data) {
        this.addViewpoint({
          name: d.name,
          anchor:   new THREE.Vector3(d.anchor[0],   d.anchor[1],   d.anchor[2]),
          position: new THREE.Vector3(d.position[0], d.position[1], d.position[2]),
          target:   new THREE.Vector3(d.target[0],   d.target[1],   d.target[2]),
          createdAt: d.createdAt,
        });
      }
    } finally {
      this._suspendSave = false;
    }
    // Save once at the end so storage reflects the final restored state.
    this._save();
    return true;
  }

  setRaycaster(raycaster, splatMesh) {
    this._raycaster = raycaster;
    this._splat = splatMesh;
  }

  armAddViewpoint() {
    this.pendingAdd = !this.pendingAdd;
    this._setStatus(this.pendingAdd ? "Click on the splat to anchor a new viewpoint…" : "");
    if (this.onArmedChange) this.onArmedChange(this.pendingAdd);
  }

  // Called from the canvas click handler. Returns true if it consumed the click.
  handleCanvasClick(worldHitPoint) {
    if (!this.pendingAdd) return false;
    this.pendingAdd = false;
    if (this.onArmedChange) this.onArmedChange(false);
    this._setStatus("");
    if (worldHitPoint) {
      this.addViewpoint({
        anchor: worldHitPoint.clone(),
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
      });
    }
    return true;
  }

  addViewpoint({ anchor, position, target, name }) {
    const id = nextId();
    const vp = {
      id,
      name: name ?? `View ${this.viewpoints.length + 1}`,
      anchor,
      position,
      target,
      el: null,
    };

    // DOM marker — promoted from <div> to <button> + aria-label so
    // assistive tech announces it as the interactive viewpoint anchor
    // it is. Visual chrome is reset to match the original .annotation
    // styling, so nothing changes for sighted users.
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "annotation";
    dot.textContent = String(this.viewpoints.length + 1);
    dot.setAttribute("aria-label", `Viewpoint ${this.viewpoints.length + 1}: ${name}`);
    dot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.flyTo(id);
    });
    this.layerEl.appendChild(dot);
    vp.el = dot;

    this.viewpoints.push(vp);
    this._rebuildList();
    this._save();
    return vp;
  }

  removeViewpoint(id) {
    const idx = this.viewpoints.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const vp = this.viewpoints[idx];
    vp.el?.remove();
    this.viewpoints.splice(idx, 1);
    // Renumber labels
    this.viewpoints.forEach((v, i) => {
      v.el.textContent = String(i + 1);
    });
    if (this.activeId === id) this.activeId = null;
    this._rebuildList();
    this._save();
  }

  _rebuildList() {
    this.listEl.innerHTML = "";
    this.viewpoints.forEach((vp, i) => {
      const li = document.createElement("li");
      if (vp.id === this.activeId) li.classList.add("active");

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(i + 1);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = vp.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", () => {
        const nv = prompt("Rename viewpoint", vp.name);
        if (nv && nv.trim()) {
          vp.name = nv.trim();
          this._rebuildList();
          this._save();
        }
      });

      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "×";
      del.title = "Delete";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeViewpoint(vp.id);
      });

      li.append(badge, name, del);
      li.addEventListener("click", () => this.flyTo(vp.id));
      this.listEl.appendChild(li);
    });
  }

  flyTo(id) {
    const vp = this.viewpoints.find((v) => v.id === id);
    if (!vp) return;

    // Multi-channel "departure" feedback paired with the visual tween.
    // The whoosh sound's 220 ms downward sweep cues motion at the
    // instant the camera begins moving; the brief haptic pulse marks
    // the snap-to commit on touch hardware. No-ops gracefully on
    // platforms without vibrate() / pre-user-gesture audio.
    haptic(8);
    playSound("whoosh");

    this.activeId = id;
    this._rebuildList();

    // Disable controls during tween
    this.controls.enabled = false;
    const fromPos = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const dur = 0.9; // seconds
    this.tween = {
      t: 0,
      duration: dur,
      fromPos, fromTarget,
      toPos: vp.position.clone(),
      toTarget: vp.target.clone(),
    };
  }

  // Number-key shortcut
  flyToIndex(i /* 0-based */) {
    const vp = this.viewpoints[i];
    if (vp) this.flyTo(vp.id);
  }

  // Tween to an arbitrary (position, target) pose without registering a
  // sidebar viewpoint — used by ad-hoc destinations like asset hotspots.
  flyToPose(position, target, duration = 0.9) {
    this.controls.enabled = false;
    this.activeId = null;          // not a saved viewpoint
    this._rebuildList();
    this.tween = {
      t: 0,
      duration,
      fromPos:    this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos:      position.clone(),
      toTarget:   target.clone(),
    };
  }

  // Smoothstep easing
  _ease(x) { return x * x * (3 - 2 * x); }

  updateTween(dt) {
    if (!this.tween) return;
    this.tween.t += dt;
    const a = Math.min(1, this.tween.t / this.tween.duration);
    const e = this._ease(a);
    this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
    this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
    this.controls.update();
    if (a >= 1) {
      this.tween = null;
      this.controls.enabled = true;
    }
  }

  // Master visibility flag. Set false to hide ALL viewpoint markers (e.g.,
  // when the underlying splat is hidden via the Scene panel — the floating
  // numbered dots in empty space were the visual artifact the user
  // flagged: "如果隐藏scene 这个相关的资产卡片也应该消失").
  setVisible(on) {
    this._hidden = !on;
    if (this._hidden) {
      for (const vp of this.viewpoints) {
        if (vp.el) vp.el.style.display = "none";
      }
    }
  }

  // Project anchors to screen each frame
  updateMarkers(width, height) {
    if (this._hidden) return;       // master-hide bypass
    if (!this.viewpoints.length) return;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const camPos = this.camera.position;

    for (const vp of this.viewpoints) {
      // Hide the marker for the viewpoint we're currently sitting at —
      // an anchor at the camera's location is redundant and tends to
      // overlap with whatever asset hotspot the viewpoint is framing
      // (e.g. the Zoom viewpoint sits on top of the Grape Hyacinth dot).
      if (vp.id === this.activeId) {
        vp.el.style.display = "none";
        continue;
      }

      this._v.copy(vp.anchor);
      // Vector from camera to anchor
      const dx = this._v.x - camPos.x;
      const dy = this._v.y - camPos.y;
      const dz = this._v.z - camPos.z;
      const behind = dx * camDir.x + dy * camDir.y + dz * camDir.z <= 0;

      this._v.project(this.camera);
      const x = (this._v.x * 0.5 + 0.5) * width;
      const y = (-this._v.y * 0.5 + 0.5) * height;

      if (behind || this._v.x < -1.2 || this._v.x > 1.2 || this._v.y < -1.2 || this._v.y > 1.2) {
        vp.el.style.display = "none";
      } else {
        vp.el.style.display = "flex";
        vp.el.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
  }

  _setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg || "--";
  }

  // Seed a handful of default viewpoints around the model
  seedDefaults(boundsCenter, boundsRadius) {
    // SUBJECT is the gazebo — the actual visual centre of the scene, not
    // the splat's geometric centroid (which gets pulled off by outlier
    // splats). The four cardinal cameras + Top all orbit around this.
    const SUBJECT = new THREE.Vector3(-0.58, -0.561, 3.774);
    // Fixed cardinal-orbit radius. Calibrated so the cardinal cameras
    // sit far enough back to see the gazebo + flower cluster *and* the
    // surrounding landscape patch in frame, without pulling outlier
    // splats from the bounding sphere in. boundsRadius can be 10 m+
    // once those outliers are counted, so we don't scale by it.
    const r = 6.0;
    // Cardinal Y offset is set above the landscape / foliage band so the
    // camera looks DOWN across the scene to the gazebo, not THROUGH the
    // ground splats. r * 0.20 ~= 1.2 m above SUBJECT, ~0.6 m above origin
    // — clear of the dense ground layer, still close enough to be a
    // sane viewer's eye level rather than a top-down.
    const presets = [
      // Front — hand-tuned absolute pose. The Right / Back / Left / Top
      // cardinal viewpoints used to live here but were removed at the
      // user's request to keep the numbered shortcut list tight.
      { name: "Front",
        absolutePos:    new THREE.Vector3(-1.687,  0.284,  2.195),
        absoluteTarget: new THREE.Vector3(-1.133, -0.278, -0.997) },
      // Center = camera placed at the geometric center of the splat bounds,
      // looking forward into the scene. OrbitControls treats the offset
      // between pos and target as the orbit radius, so we keep target ahead
      // by half the bounds radius — a sane distance to scroll-zoom from.
      // This pose is re-patched by main.js once the FBX preload finishes
      // (Center sampled at frame 460 of the cinematic flythrough).
      { name: "Center", pos: new THREE.Vector3(0, 0, 0),
                        targetOffset: new THREE.Vector3(0, 0, -boundsRadius * 0.5) },
      // Zoom = close-up on the Grape Hyacinth — the showcase's hero asset.
      // worldPos uses the Z-flipped frame (same one the hover hotspot
      // projects in) so the framing matches the floating dot's position.
      // Camera sits ~1.6 m behind and slightly above the flower cluster.
      { name: "Zoom",
        absoluteTarget: new THREE.Vector3(-0.195, -0.730, -2.379),
        positionOffset: new THREE.Vector3(0, 0.4, 1.5) },
    ];
    let centerVp = null;
    for (const p of presets) {
      let position, target, anchor;
      if (p.absoluteTarget) {
        target   = p.absoluteTarget.clone();
        // Fully-baked pose: caller supplied both endpoints. Otherwise derive
        // a position from positionOffset or a sane default behind/above.
        if (p.absolutePos) {
          position = p.absolutePos.clone();
        } else {
          position = p.positionOffset
            ? target.clone().add(p.positionOffset)
            : target.clone().add(new THREE.Vector3(0, boundsRadius * 0.3, r));
        }
        anchor   = target.clone();
      } else {
        // Pivot around the per-preset subject if declared, otherwise fall
        // back to the splat's bounds centre. Cardinal views (Front, Right,
        // Back, Left, Top) use the gazebo as subject so they all face the
        // visual centre of the scene rather than the bounding-box centre.
        const pivot = p.subject || boundsCenter;
        position = pivot.clone().add(p.pos);
        target   = pivot.clone().add(p.targetOffset ?? new THREE.Vector3());
        // Anchor scale matches the camera distance so the numbered dot
        // sits just outside the subject, not on the bounding-sphere of
        // outlier splats (which would push markers off-screen).
        const camDist = p.pos.length() || 1;
        anchor   = pivot.clone().add(p.pos.clone().normalize().multiplyScalar(camDist * 0.6));
      }
      const vp = this.addViewpoint({ name: p.name, anchor, position, target });
      if (p.name === "Center") centerVp = vp;
    }
    // Center = the default startup pose. Mark it active in the sidebar so it
    // matches the camera the loader places after seeding.
    if (centerVp) {
      this.activeId = centerVp.id;
      this._rebuildList();
    }
    return centerVp;
  }
}
