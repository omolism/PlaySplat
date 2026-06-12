// ---------------------------------------------------------------------------
// ViewpointTuner — small floating panel that shows the live camera pose
// and lets you commit the current pose into any seeded viewpoint slot.
//
// Workflow:
//   1. Press K to open the tuner (top-right of the viewport).
//   2. Orbit / WASD around until the framing is right.
//   3. Read the live position / target values (mono, 3 decimals).
//   4. Click "Front" / "Right" / "Back" / "Left" / "Top" / "Center" / "Zoom"
//      to overwrite that viewpoint with the current pose. The choice is
//      persisted via AnnotationManager._save() so it survives reloads.
//   5. Or click "Copy snippet" to grab a JS snippet you can paste into
//      annotations.seedDefaults() for hard-coding the new pose.
//
// Toggle: K. Esc / × button closes.
// ---------------------------------------------------------------------------

export class ViewpointTuner {
  constructor({ mountEl = document.body, camera, controls, annotations }) {
    this.camera      = camera;
    this.controls    = controls;
    this.annotations = annotations;
    this.open        = false;

    this.el = document.createElement("aside");
    this.el.id = "viewpoint-tuner";
    this.el.innerHTML = `
      <header class="vt-head">
        <span class="vt-title">Viewport Tuner</span>
        <span class="vt-key">K</span>
        <button class="vt-min"   data-act="min"   title="Minimize">&minus;</button>
        <button class="vt-close" data-act="close" title="Close (K or Esc)">&times;</button>
      </header>
      <div class="vt-body">
        <div class="vt-row">
          <span class="vt-k">Position</span>
          <code class="vt-v" data-k="pos">—</code>
        </div>
        <div class="vt-row">
          <span class="vt-k">Target</span>
          <code class="vt-v" data-k="tgt">—</code>
        </div>
        <button class="vt-action" data-act="copy">Copy snippet</button>
        <div class="vt-sec-title">Save current pose as</div>
        <div class="vt-grid" data-k="grid"></div>
        <div class="vt-hint">Click any viewpoint name to overwrite it with the live camera pose.</div>
      </div>
    `;
    mountEl.appendChild(this.el);

    this.posEl  = this.el.querySelector('[data-k="pos"]');
    this.tgtEl  = this.el.querySelector('[data-k="tgt"]');
    this.gridEl = this.el.querySelector('[data-k="grid"]');

    this.el.querySelector('[data-act="close"]').addEventListener("click", () => this.hide());
    this.el.querySelector('[data-act="copy"]') .addEventListener("click", () => this._copySnippet());
    // Minimize collapses .vt-body, leaving just the header. Same button
    // (− / +) toggles between states; header stays clickable so the user
    // can grab it / re-expand. Default state is expanded.
    this.minimized = false;
    const minBtn = this.el.querySelector('[data-act="min"]');
    minBtn.addEventListener("click", () => {
      this.minimized = !this.minimized;
      this.el.classList.toggle("minimized", this.minimized);
      minBtn.innerHTML = this.minimized ? "&plus;" : "&minus;";
      minBtn.title     = this.minimized ? "Expand"  : "Minimize";
    });
    // Clicking the header (anywhere except the buttons) also toggles
    // minimize, like Blender's collapsible side panel headers.
    this.el.querySelector(".vt-head").addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      minBtn.click();
    });

    window.addEventListener("keydown", (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.key === "k" || e.key === "K") { e.preventDefault(); this.toggle(); }
      else if (e.key === "Escape" && this.open) { e.preventDefault(); this.hide(); }
    });

    this._lastViewpointCount = -1;
  }

  show()   { this.open = true;  this.el.classList.add("show"); this._rebuildButtons(); }
  hide()   { this.open = false; this.el.classList.remove("show"); }
  toggle() { this.open ? this.hide() : this.show(); }

  // Per-frame DOM refresh — bail when closed so we don't spend cycles.
  update() {
    if (!this.open) return;
    const p = this.camera.position;
    const t = this.controls.target;
    this.posEl.textContent = fmt(p.x) + ", " + fmt(p.y) + ", " + fmt(p.z);
    this.tgtEl.textContent = fmt(t.x) + ", " + fmt(t.y) + ", " + fmt(t.z);

    // Rebuild buttons if viewpoint list changed under us (e.g., user
    // added one via V or removed one).
    if (this.annotations.viewpoints.length !== this._lastViewpointCount) {
      this._rebuildButtons();
    }
  }

  _rebuildButtons() {
    if (!this.annotations) return;
    this.gridEl.innerHTML = "";
    this._lastViewpointCount = this.annotations.viewpoints.length;
    for (const vp of this.annotations.viewpoints) {
      const btn = document.createElement("button");
      btn.className = "vt-save-btn";
      btn.dataset.id = vp.id;
      btn.textContent = vp.name;
      btn.addEventListener("click", () => this._saveAs(vp, btn));
      this.gridEl.appendChild(btn);
    }
  }

  _saveAs(vp, btn) {
    vp.position.copy(this.camera.position);
    vp.target.copy(this.controls.target);
    if (typeof this.annotations._save === "function") this.annotations._save();
    btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), 700);
  }

  _copySnippet() {
    const p = this.camera.position;
    const t = this.controls.target;
    const snippet =
      "position: new THREE.Vector3(" + fmt(p.x) + ", " + fmt(p.y) + ", " + fmt(p.z) + "),\n" +
      "target:   new THREE.Vector3(" + fmt(t.x) + ", " + fmt(t.y) + ", " + fmt(t.z) + "),";
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(snippet);
      const btn = this.el.querySelector('[data-act="copy"]');
      const orig = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = orig; }, 1000);
    } else {
      console.info("[VT] Snippet:\n" + snippet);
    }
  }
}

function fmt(n) {
  return Number(n).toFixed(3);
}
