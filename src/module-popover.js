// ---------------------------------------------------------------------------
// Module Popover — per-module parameter popups reached from the Playbar.
//
// Product rationale: the Playbar answers "what do I want to do" (switch
// representation, pick an effect), but the moment a visitor engages a module
// the next question is "what can I tune here". Previously the only answer was
// the full Studio panel, which means leaving the outcome-first surface and
// hunting through 80+ controls for the four that belong to the thing they just
// clicked. Each module now carries its own popup with exactly its own knobs.
//
// Architecture: this component owns NO state and duplicates NO controls. It
// projects existing lil-gui controllers, resolved by property name, into the
// shared .ui-pop shell. Every widget writes through the original controller,
// so all side effects (rebuilds, shader cross-fades, annotation cards, Studio
// visual sync) fire exactly as if the user had used the Studio panel, and the
// two surfaces cannot drift apart. Controllers absent from the current build
// are skipped, so a module definition can safely list optional parameters.
// ---------------------------------------------------------------------------

// Which controllers belong to which Playbar module. Keys are the module ids
// the Playbar passes in; `props` are lil-gui controller property names.
// Sub-form segmented buttons are declared separately because they are raw DOM
// in the Studio panel rather than lil-gui controllers.
// Property names are the real lil-gui controller keys, verified against the
// live panel. `folder` disambiguates a key that exists in more than one place
// (pointSize belongs to both 3DGS/USD and the GPGPU particle pass).
export const MODULE_SPECS = {
  splatLayer: {
    title: "Splat",
    seg:   { label: "Form", vals: [["Gaussian", "Gaussian"], ["Point", "Point"]] },
    props: [{ prop: "pointSize", folder: "3DGS/USD" }],
  },
  quadLayer: {
    title: "Billboard",
    seg:   { label: "Prototype", vals: [["quad", "Quad"], ["circle", "Circle"]] },
    props: ["quadSize"],
  },
  voxelLayer: {
    title: "Voxel",
    seg:   { label: "Prototype", vals: [["cube", "Cube"], ["sphere", "Sphere"]] },
    props: ["voxelSize"],
  },
  effect: {
    title: "Effect",
    props: ["radius", "duration", "intensity", "speed", "noiseScale", "colorOn",
            "brush", "effector"],
  },
};

export class ModulePopover {
  /**
   * @param {object} opts
   * @param {*} opts.gui                - lil-gui root
   * @param {HTMLElement} [opts.mountEl]
   */
  constructor({ gui, mountEl = document.body }) {
    this.gui = gui;
    this.moduleId = null;
    this.open = false;
    this._rows = [];

    this.el = document.createElement("div");
    this.el.className = "ui-pop pop-module";
    this.el.innerHTML = `
      <div class="pop-head">
        <div class="pop-title" data-k="title">Module</div>
        <button class="pop-x" data-act="close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="pop-body" data-k="body"></div>
    `;
    mountEl.appendChild(this.el);
    this.$title = this.el.querySelector('[data-k="title"]');
    this.$body  = this.el.querySelector('[data-k="body"]');
    this.el.querySelector('[data-act="close"]').addEventListener("click", () => this.close());

    // Dismiss on outside click. The Playbar caret is excluded so its own
    // toggle is not fought by an immediate re-close.
    this._onOutside = (e) => {
      if (!this.open) return;
      if (this.el.contains(e.target)) return;
      if (e.target?.closest?.(".pb-gear, .lil-gui")) return;
      this.close();
    };
  }

  // Resolve a lil-gui controller by property name, walking the whole tree.
  // An optional folder title disambiguates keys that appear more than once.
  _find(prop, folder) {
    let hit = null;
    const walk = (g, path) => {
      if (hit) return;
      (g.controllers || []).forEach(c => {
        if (hit || c.property !== prop) return;
        if (folder && !path.includes(folder)) return;
        hit = c;
      });
      (g.folders || []).forEach(f => walk(f, path + "/" + (f._title || "")));
    };
    walk(this.gui, "");
    return hit;
  }

  // Build one row per controller, choosing the widget from the controller's
  // own type so the popup inherits the Studio's min/max/step without
  // re-declaring them anywhere.
  _buildRow(ctrl) {
    const row = document.createElement("div");
    row.className = "pop-ctrl";
    const name = document.createElement("span");
    name.className = "pop-name";
    name.textContent = ctrl._name || ctrl.property;
    const widget = document.createElement("span");
    widget.className = "pop-widget";
    row.append(name, widget);

    const v = ctrl.getValue();
    let refresh = () => {};

    if (typeof v === "boolean") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = v;
      cb.addEventListener("change", () => ctrl.setValue(cb.checked));
      widget.appendChild(cb);
      refresh = () => { if (document.activeElement !== cb) cb.checked = ctrl.getValue(); };

    } else if (typeof v === "number") {
      const min  = ctrl._min ?? 0;
      const max  = ctrl._max ?? 1;
      const step = ctrl._step ?? 0.01;
      const sl = document.createElement("input");
      sl.type = "range";
      sl.min = min; sl.max = max; sl.step = step; sl.value = v;
      const out = document.createElement("span");
      out.className = "pop-val";
      const fmt = (n) => (step >= 1 ? String(Math.round(n)) : Number(n).toFixed(2));
      out.textContent = fmt(v);
      sl.addEventListener("input", () => {
        ctrl.setValue(parseFloat(sl.value));
        out.textContent = fmt(sl.value);
      });
      widget.append(sl, out);
      refresh = () => {
        if (document.activeElement === sl) return;
        const cur = ctrl.getValue();
        sl.value = cur;
        out.textContent = fmt(cur);
      };

    } else if (typeof v === "string") {
      // Dropdowns (the effect list) render as a native select styled by the
      // shared popover rules.
      const opts = ctrl._values || ctrl._names;
      if (Array.isArray(opts)) {
        const sel = document.createElement("select");
        sel.className = "pop-btn";
        opts.forEach(o => {
          const op = document.createElement("option");
          op.value = o; op.textContent = o;
          sel.appendChild(op);
        });
        sel.value = v;
        sel.addEventListener("change", () => ctrl.setValue(sel.value));
        widget.appendChild(sel);
        refresh = () => { if (document.activeElement !== sel) sel.value = ctrl.getValue(); };
      } else {
        return null;
      }

    } else {
      return null;
    }

    this._rows.push(refresh);
    return row;
  }

  // Sub-form segmented buttons are raw DOM in the Studio panel, so clicks are
  // proxied to the originals (same idiom the Playbar sub-chips use) to keep
  // the rebuild and shape-callback chain intact.
  _buildSeg(spec) {
    const originals = spec.vals
      .map(([val]) => this.gui.domElement?.querySelector(`.subform-toggle button[data-val="${val}"]`))
      .filter(Boolean);
    if (originals.length !== spec.vals.length) return null;

    const row = document.createElement("div");
    row.className = "pop-ctrl";
    const name = document.createElement("span");
    name.className = "pop-name";
    name.textContent = spec.label;
    const widget = document.createElement("span");
    widget.className = "pop-widget";
    const seg = document.createElement("span");
    seg.className = "pop-seg";

    const btns = spec.vals.map(([val, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.dataset.val = val;
      b.addEventListener("click", () => {
        this.gui.domElement?.querySelector(`.subform-toggle button[data-val="${val}"]`)?.click();
        this._rows.forEach(fn => fn());
      });
      seg.appendChild(b);
      return b;
    });

    widget.appendChild(seg);
    row.append(name, widget);
    this._rows.push(() => {
      btns.forEach(b => {
        const orig = this.gui.domElement?.querySelector(`.subform-toggle button[data-val="${b.dataset.val}"]`);
        b.classList.toggle("active", !!orig?.classList.contains("active"));
      });
    });
    return row;
  }

  // Populate for a module and anchor horizontally under its Playbar button.
  showFor(moduleId, anchorEl) {
    const spec = MODULE_SPECS[moduleId];
    if (!spec) return;
    this.moduleId = moduleId;
    this.$title.textContent = spec.title;
    this.$body.innerHTML = "";
    this._rows = [];

    if (spec.seg) {
      const segRow = this._buildSeg(spec.seg);
      if (segRow) this.$body.appendChild(segRow);
    }
    (spec.props || []).forEach(entry => {
      const { prop, folder } = typeof entry === "string" ? { prop: entry } : entry;
      const ctrl = this._find(prop, folder);
      if (!ctrl) return;                 // optional in this build
      const row = this._buildRow(ctrl);
      if (row) this.$body.appendChild(row);
    });
    if (!this.$body.children.length) {
      const empty = document.createElement("div");
      empty.className = "pop-empty";
      empty.textContent = "No adjustable parameters for this module.";
      this.$body.appendChild(empty);
    }

    this._anchor(anchorEl);
    this.open = true;
    this.el.classList.add("show");
    this._rows.forEach(fn => fn());
    this._timer = setInterval(() => this._rows.forEach(fn => fn()), 300);
    setTimeout(() => {
      if (this.open) document.addEventListener("pointerdown", this._onOutside, true);
    }, 0);
  }

  // Centre on the button that opened it, clamped into the viewport.
  _anchor(anchorEl) {
    if (!anchorEl) { this.el.style.left = "50%"; return; }
    const r = anchorEl.getBoundingClientRect();
    const w = this.el.offsetWidth || 276;
    const margin = 10;
    const x = Math.max(margin, Math.min(window.innerWidth - w - margin, r.left + r.width / 2 - w / 2));
    this.el.style.left = `${x}px`;
  }

  close() {
    this.open = false;
    this.moduleId = null;
    this.el.classList.remove("show");
    clearInterval(this._timer);
    this._timer = null;
    document.removeEventListener("pointerdown", this._onOutside, true);
  }

  toggleFor(moduleId, anchorEl) {
    if (this.open && this.moduleId === moduleId) this.close();
    else this.showFor(moduleId, anchorEl);
  }

  dispose() {
    clearInterval(this._timer);
    document.removeEventListener("pointerdown", this._onOutside, true);
    this.el.remove();
  }
}
