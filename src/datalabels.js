import * as THREE from "three";

// ---------------------------------------------------------------------------
// DataLabelLayer
//
// Surveillance / forensic-data aesthetic overlay:
//   • Floating cards for each saved viewpoint (Id, Name, Time, Date),
//     anchored to the 3D point with a thin SVG connector.
//   • Faint dashed wireframe around the splat bounding box.
//   • ~24 ambient pseudo-coordinate ticks scattered through the scene volume.
//
// All overlay elements live above the canvas. Toggle on/off via setEnabled.
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

export class DataLabelLayer {
  constructor({ canvas, camera, annotationManager, appEl }) {
    this.canvas      = canvas;
    this.camera      = camera;
    this.anno        = annotationManager;
    this.enabled     = false;
    this._v          = new THREE.Vector3();

    // ---- SVG overlay (connectors, bbox, ticks) ----
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "data-overlay");

    this.gBBox       = document.createElementNS(SVG_NS, "g");
    this.gTicks      = document.createElementNS(SVG_NS, "g");
    this.gConnectors = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.gBBox);
    this.svg.appendChild(this.gTicks);
    this.svg.appendChild(this.gConnectors);

    // ---- HTML cards layer ----
    this.cards = document.createElement("div");
    this.cards.className = "data-cards-layer";

    appEl.appendChild(this.svg);
    appEl.appendChild(this.cards);
    this.svg.style.display   = "none";
    this.cards.style.display = "none";

    this.cardMap   = new Map();           // viewpointId → entry
    this.ticks     = [];
    this.bboxLines = [];

    // For deterministic coord rendering across sessions
    this._creationTime = new Date();
  }

  /** Provide the scene bounding box so bbox lines + ambient ticks can populate. */
  setBounds(center, size) {
    this.gBBox.innerHTML  = "";
    this.gTicks.innerHTML = "";
    this.bboxLines        = [];
    this.ticks            = [];

    // --- 12 bbox edges (drawn as dashed lines) ---
    const half = size.clone().multiplyScalar(0.5);
    const corners = [];
    for (let i = 0; i < 8; i++) {
      corners.push(new THREE.Vector3(
        center.x + ((i & 1) ? half.x : -half.x),
        center.y + ((i & 2) ? half.y : -half.y),
        center.z + ((i & 4) ? half.z : -half.z),
      ));
    }
    const edges = [
      [0,1],[2,3],[4,5],[6,7],
      [0,2],[1,3],[4,6],[5,7],
      [0,4],[1,5],[2,6],[3,7],
    ];
    for (const [a, b] of edges) {
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("class", "bbox-line");
      this.gBBox.appendChild(ln);
      this.bboxLines.push({ a: corners[a], b: corners[b], el: ln });
    }

    // --- Default ambient ticks (replaced by setColmapPoses if available) ---
    this._seedRandomTicks(center, size, 24);
  }

  // Internal: random ambient ticks (fallback when no COLMAP data is loaded).
  _seedRandomTicks(center, size, count) {
    let s = 0xC0FFEE;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);

    for (let i = 0; i < count; i++) {
      const p = new THREE.Vector3(
        center.x + (rand() - 0.5) * size.x * 0.92,
        center.y + (rand() - 0.5) * size.y * 0.92,
        center.z + (rand() - 0.5) * size.z * 0.92,
      );
      const v = (Math.sin(p.x * 7.13 + p.y * 3.27 + p.z * 5.91) * 1000).toFixed(3);
      this._appendTick(p, v);
    }
  }

  // Internal: build one SVG tick (crosshair + label) at world position p.
  _appendTick(pos, label) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "tick");

    const cross = document.createElementNS(SVG_NS, "path");
    cross.setAttribute("d", "M -4 0 L 4 0 M 0 -4 L 0 4");
    cross.setAttribute("class", "tick-cross");
    g.appendChild(cross);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("class", "tick-text");
    text.setAttribute("dx", "8");
    text.setAttribute("dy", "3");
    text.textContent = label;
    g.appendChild(text);

    this.gTicks.appendChild(g);
    this.ticks.push({ pos, el: g });
  }

  /**
   * Replace random ambient ticks with real COLMAP capture positions.
   * @param {Array<{pos: THREE.Vector3, name?: string, imageId?: number}>} poses
   */
  setColmapPoses(poses) {
    // Clear existing ticks
    this.gTicks.innerHTML = "";
    this.ticks = [];
    for (const p of poses) {
      const label = p.name || (p.imageId != null ? `#${p.imageId}` : "");
      this._appendTick(p.pos.clone(), label);
    }
  }

  /** Show / hide the entire overlay layer. */
  setEnabled(on) {
    this.enabled = !!on;
    this.svg.style.display   = on ? "block" : "none";
    this.cards.style.display = on ? "block" : "none";

    // When enabled, hide the simple annotation dots so cards don't compete
    if (this.anno) {
      this.anno.viewpoints.forEach(v => {
        if (v.el) v.el.style.opacity = on ? "0.0" : "";
      });
    }

    if (on) this._rebuildCards();
    else    this._clearCards();
  }

  /** Call when viewpoints change (added / removed / renamed). */
  refresh() {
    if (this.enabled) {
      this._clearCards();
      this._rebuildCards();
    }
  }

  _clearCards() {
    for (const entry of this.cardMap.values()) {
      entry.card.remove();
      entry.connector.remove();
    }
    this.cardMap.clear();
  }

  _rebuildCards() {
    if (!this.anno) return;
    this.anno.viewpoints.forEach((vp, idx) => this._addCard(vp, idx));
  }

  _addCard(vp, idx) {
    const time = this._creationTime.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit",
    });
    const date = this._creationTime.toLocaleDateString("en-GB").replaceAll("/", "-");

    const card = document.createElement("div");
    card.className = "data-card";
    card.innerHTML = `
      <div class="card-row"><span class="k">Id</span><span class="v">${String(idx + 1).padStart(2, "0")}</span></div>
      <div class="card-row"><span class="k">Name</span><span class="v">${vp.name}</span></div>
      <div class="card-row"><span class="k">Time</span><span class="v">${time}</span></div>
      <div class="card-row"><span class="k">Date</span><span class="v">${date}</span></div>
    `;
    this.cards.appendChild(card);

    const connector = document.createElementNS(SVG_NS, "line");
    connector.setAttribute("class", "connector");
    this.gConnectors.appendChild(connector);

    // Distribute card offsets radially around the scene center
    const angle = (idx / Math.max(this.anno.viewpoints.length, 1)) * Math.PI * 2;
    const offset = {
      x: Math.cos(angle) * 240,
      y: Math.sin(angle) * 170,
    };

    this.cardMap.set(vp.id, { vp, card, connector, offset });
  }

  /** Project every overlay element to screen space each frame. */
  update(w, h) {
    if (!this.enabled) return;

    // Bbox edges
    const v = this._v;
    for (const e of this.bboxLines) {
      v.copy(e.a).project(this.camera);
      const ax = (v.x * 0.5 + 0.5) * w;
      const ay = (-v.y * 0.5 + 0.5) * h;
      const aBehind = v.z > 1;
      v.copy(e.b).project(this.camera);
      const bx = (v.x * 0.5 + 0.5) * w;
      const by = (-v.y * 0.5 + 0.5) * h;
      const bBehind = v.z > 1;
      if (aBehind && bBehind) { e.el.style.display = "none"; continue; }
      e.el.style.display = "";
      e.el.setAttribute("x1", ax); e.el.setAttribute("y1", ay);
      e.el.setAttribute("x2", bx); e.el.setAttribute("y2", by);
    }

    // Ambient ticks
    for (const t of this.ticks) {
      v.copy(t.pos).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        t.el.style.display = "none";
        continue;
      }
      t.el.style.display = "";
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      t.el.setAttribute("transform", `translate(${x}, ${y})`);
    }

    // Viewpoint cards + connectors
    //
    // Layout strategy: the left-side UI (sidebar 18+240px, hand-panel 18+224px)
    // occupies x < ~280px, so we keep the cards inside [LEFT_PAD .. w-CARD_W].
    // Cards are also measured to clamp the bottom edge against their real size
    // (the USD prim blocks are taller than the original key/value cards).
    const LEFT_PAD = 280;
    for (const entry of this.cardMap.values()) {
      v.copy(entry.vp.anchor).project(this.camera);
      if (v.z > 1) {
        entry.card.style.display = "none";
        entry.connector.style.display = "none";
        continue;
      }
      const ax = (v.x * 0.5 + 0.5) * w;
      const ay = (-v.y * 0.5 + 0.5) * h;

      // Show the card briefly so offsetWidth/Height are valid for clamping
      if (entry.card.style.display !== "block") entry.card.style.display = "block";
      const cw = entry.card.offsetWidth  || 280;
      const ch = entry.card.offsetHeight || 160;

      const cx = Math.max(LEFT_PAD, Math.min(w - cw - 10, ax + entry.offset.x));
      const cy = Math.max(10,        Math.min(h - ch - 10, ay + entry.offset.y));

      entry.card.style.transform = `translate(${cx}px, ${cy}px)`;

      entry.connector.style.display = "";
      // Connector from card top-left corner to the anchor
      entry.connector.setAttribute("x1", cx + 4);
      entry.connector.setAttribute("y1", cy + 6);
      entry.connector.setAttribute("x2", ax);
      entry.connector.setAttribute("y2", ay);
    }
  }
}
