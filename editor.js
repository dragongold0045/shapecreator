/* ═══════════════════════════════════════════════════════════════════
   SHAPE EDITOR PRO  v8  —  editor.js
   v8 new: relocate base point, connect mode, drag selection,
   multi-select popup with common base, group rename (dblclick/F2),
   per-segment stroke toggle, shape opacity, ref rotation,
   flexible ref handles, start-point drawing, right-panel card layout.
═══════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════
let _uid = 1;
const uid = () => "s" + _uid++;
const f2 = (v) => parseFloat(v || 0).toFixed(2);
const f3 = (v) => parseFloat(v || 0).toFixed(3);
const hxStr = (c) => {
  if (!c || c.length < 4) return "0x000000";
  return "0x" + c.replace("#", "").toUpperCase();
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const COLORS = [
  "#e8d400",
  "#ff4e7a",
  "#3ec83e",
  "#5272f0",
  "#f0c030",
  "#9070ff",
  "#ff7a3d",
  "#30c8c0",
];
let _ci = 0;
const nextColor = () => COLORS[_ci++ % COLORS.length];
let shapeN = 1;

// ══════════════════════════════════════════
// GRADIENT HELPERS
// ══════════════════════════════════════════
const isGrad = (c) => c && typeof c === "object" && c.type;
const colorToHex = (c) => {
  if (!c) return "#ffffff";
  if (typeof c === "string") return c;
  return c.stops?.[0]?.color || "#ffffff";
};
const mkLinGrad = () => ({
  type: "linear",
  x1: 0,
  y1: -1,
  x2: 0,
  y2: 1,
  stops: [
    { offset: 0, color: "#ffffff" },
    { offset: 1, color: "#5272f0" },
  ],
});

function resolveColorForCtx(color, sh, rep, ctx2d, ltsFn) {
  if (!isGrad(color)) return color || "#ffffff";
  if (color.type === "linear") {
    try {
      const [px1, py1] = ltsFn(sh, color.x1, color.y1, rep);
      const [px2, py2] = ltsFn(sh, color.x2, color.y2, rep);
      const g = ctx2d.createLinearGradient(px1, py1, px2, py2);
      (color.stops || []).forEach((s) =>
        g.addColorStop(clamp(s.offset, 0, 1), s.color),
      );
      return g;
    } catch (e) {
      return color.stops?.[0]?.color || "#ffffff";
    }
  }
  return "#ffffff";
}

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
const S = {
  shapeKey: "PETALS.YOUR_PETAL",
  shapes: [],
  activeId: null,
  selNodeId: null,
  selectedIds: new Set(),
  mode: "select",
  theme: "dark",
  previewSize: 140,
  zoom: 1,
  panX: 0,
  panY: 0,
  showGrid: true,
  showSzRing: true,
  showHandles: true,
  showRepeats: true,
  snapEnabled: true,
  snapAxis: true,
  snapGrid: true,
  snapPoints: true,
  snapRing: false,
  snapGridSize: 0.25,
  snapThreshold: 0.05,
  refImg: null,
  refOpacity: 0.35,
  refScale: 1,
  refOffX: 0,
  refOffY: 0,
  refVisible: true,
  refRotate: 0, // v8: added refRotate
  exportTarget: "pixi",
  groups: {},
  polyOpts: { sides: 6, innerR: 0 },
  rrectRadius: 0.15,
  spiralTurns: 3,
  _prevMode: null,
};
let snapState = null,
  ctxMenuTargetId = null,
  ctxMenuNearNodeId = null;

// v8 module-level drag/interaction state
let drag = null,
  panDrag = null,
  refDrag = null,
  refScaleDrag = null;
let dragSel = null; // {sx,sy,ex,ey}  drag-selection rect
let multiBase = null; // {x,y} center handle in screen coords
let multiBaseDrag = null; // {mx,my, snapshots:[{id,ox,oy}]}
let connectFirst = null; // {shId, nodeId, lx, ly}
let freeDraw = false,
  freePts = [];
let gesture = null;

// ══════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════
const H = { stack: [], idx: -1, max: 80 };
function hPush() {
  const snap = JSON.stringify({
    shapes: S.shapes,
    activeId: S.activeId,
    selNodeId: S.selNodeId,
    groups: S.groups,
  });
  if (H.idx < H.stack.length - 1) H.stack.splice(H.idx + 1);
  H.stack.push(snap);
  if (H.stack.length > H.max) H.stack.shift();
  else H.idx++;
  updUndoRedo();
}
function undo() {
  if (H.idx <= 0) return;
  H.idx--;
  hRestore(H.stack[H.idx]);
  updUndoRedo();
}
function redo() {
  if (H.idx >= H.stack.length - 1) return;
  H.idx++;
  hRestore(H.stack[H.idx]);
  updUndoRedo();
}
function hRestore(snap) {
  const d = JSON.parse(snap);
  S.shapes = d.shapes;
  S.activeId = d.activeId;
  S.selNodeId = d.selNodeId;
  S.groups = d.groups || {};
  renderLayers();
  renderProps();
  redraw();
}
function updUndoRedo() {
  document.getElementById("undoBtn").disabled = H.idx <= 0;
  document.getElementById("redoBtn").disabled = H.idx >= H.stack.length - 1;
}

// ══════════════════════════════════════════
// THEME
// ══════════════════════════════════════════
function toggleTheme() {
  S.theme = S.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", S.theme);
  document.getElementById("themeBtn").textContent =
    S.theme === "dark" ? "🌙" : "☀️";
  redraw();
}

// ══════════════════════════════════════════
// SHAPE FACTORIES  (v8: opacity added)
// ══════════════════════════════════════════
const mkStroke = () => ({
  enabled: false,
  color: "#ffffff",
  width: 0.03,
  dash: [],
  cap: "round",
  join: "round",
});
const nd = (seg, x, y, cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0) => ({
  id: uid(),
  seg,
  x,
  y,
  cx1,
  cy1,
  cx2,
  cy2,
});

function mkPath(name, nodes, color, opts = {}) {
  return Object.assign(
    {
      id: uid(),
      type: "path",
      name,
      color,
      visible: true,
      fill: true,
      closePath: true,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      rotationDeg: 0,
      repeatCount: 1,
      opacity: 1,
      nodes,
      stroke: mkStroke(),
      isMask: false,
      groupId: null,
    },
    opts,
  );
}
function mkCircle(name, color, radius, opts = {}) {
  return Object.assign(
    {
      id: uid(),
      type: "circle",
      name,
      color,
      visible: true,
      fill: true,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      rotationDeg: 0,
      repeatCount: 1,
      opacity: 1,
      x: 0,
      y: 0,
      radius,
      stroke: mkStroke(),
      isMask: false,
      groupId: null,
    },
    opts,
  );
}
function mkFree(name, color, pts, opts = {}) {
  const s = Object.assign(
    {
      id: uid(),
      type: "freehand",
      name,
      color,
      visible: true,
      fill: false,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      rotationDeg: 0,
      repeatCount: 1,
      opacity: 1,
      points: pts || [],
      stroke: mkStroke(),
      isMask: false,
      groupId: null,
    },
    opts,
  );
  s.stroke.enabled = true;
  s.stroke.width = 0.04;
  s.stroke.color = typeof color === "string" ? color : "#ffffff";
  return s;
}
function mkText(name, color, opts = {}) {
  return Object.assign(
    {
      id: uid(),
      type: "text",
      name,
      color,
      visible: true,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      rotationDeg: 0,
      repeatCount: 1,
      opacity: 1,
      text: "Text",
      fontSize: 0.2,
      fontFamily: "Arial",
      fontWeight: "bold",
      textAlign: "center",
      textBaseline: "middle",
      stroke: mkStroke(),
      isMask: false,
      groupId: null,
    },
    opts,
  );
}

// ══════════════════════════════════════════
// PRESETS
// ══════════════════════════════════════════
const pN = () => [
  nd("M", 0, -1),
  nd("C", 0.18, 0.52, 0.82, -0.55, 0.72, 0.08),
  nd("C", 0, -1, -0.08, 0.3, -0.2, 0.05),
];
const flN = () => [
  nd("M", 0, -1),
  nd("C", 0, 0.62, 0.36, -0.78, 0.36, -0.26),
  nd("C", 0, -1, -0.36, -0.26, -0.36, -0.78),
];
const stN = () => [
  nd("M", 0, -1),
  nd("C", 0, 0.18, 0.2, -0.52, 0.2, -0.16),
  nd("C", 0, -1, -0.2, -0.16, -0.2, -0.52),
];
const lfN = () => [
  nd("M", 0, -1),
  nd("C", 0, 0.96, 0.46, -0.56, 0.5, 0.3),
  nd("C", 0, -1, -0.5, 0.3, -0.46, -0.56),
];
const gmN = () => [
  nd("M", -0.3, -1),
  nd("L", 0.3, -1),
  nd("L", 0.62, -0.55),
  nd("L", 0.62, 0.35),
  nd("L", 0, 1),
  nd("L", -0.62, 0.35),
  nd("L", -0.62, -0.55),
];
const gmH = () => [
  nd("M", -0.15, -0.85),
  nd("L", 0.15, -0.85),
  nd("L", 0, -0.35),
];
const arN = () => [
  nd("M", 0, -1),
  nd("L", 0.45, 0),
  nd("L", 0.18, 0),
  nd("L", 0.18, 1),
  nd("L", -0.18, 1),
  nd("L", -0.18, 0),
  nd("L", -0.45, 0),
];
const htN = () => [
  nd("M", 0, 0.9),
  nd("C", -1.1, -1.1, -2.2, 0.8, 0, -0.1),
  nd("C", 2.2, 0.8, 1.1, -1.1, 0, 0.9),
];
const shN = () => [
  nd("M", 0, -1),
  nd("C", 0.5, -1, 1, -0.6, 1, 0),
  nd("C", 1, 0.5, 0.5, 0.9, 0, 1),
  nd("C", -0.5, 0.9, -1, 0.5, -1, 0),
  nd("C", -1, -0.6, -0.5, -1, 0, -1),
];
const crN = () => [
  nd("M", -0.25, -0.25),
  nd("L", -0.25, -1),
  nd("L", 0.25, -1),
  nd("L", 0.25, -0.25),
  nd("L", 1, -0.25),
  nd("L", 1, 0.25),
  nd("L", 0.25, 0.25),
  nd("L", 0.25, 1),
  nd("L", -0.25, 1),
  nd("L", -0.25, 0.25),
  nd("L", -1, 0.25),
  nd("L", -1, -0.25),
];
const crysN = () => [
  nd("M", 0, -1),
  nd("L", 0.4, -0.3),
  nd("L", 0.7, 0.2),
  nd("L", 0.35, 0.6),
  nd("L", 0, 1),
  nd("L", -0.35, 0.6),
  nd("L", -0.7, 0.2),
  nd("L", -0.4, -0.3),
];
const bdgN = () => {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2,
      r = i % 2 === 0 ? 1 : 0.7;
    pts.push(nd(i === 0 ? "M" : "L", Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
};

const PRESETS = {
  talisman: {
    label: "Talisman",
    ai: 2,
    shapes: [
      mkPath("Shadow", pN(), "#8a7800", {
        repeatCount: 3,
        rotationDeg: -90,
        scale: 1.08,
        offsetX: 0.04,
        offsetY: 0.06,
      }),
      mkPath("Outline", pN(), "#c8a800", {
        repeatCount: 3,
        rotationDeg: -90,
        scale: 1.07,
      }),
      mkPath("Blade", pN(), "#e8d400", { repeatCount: 3, rotationDeg: -90 }),
      mkCircle("Hub", "#8a7800", 0.26),
      mkCircle("Ring", "#166e28", 0.22),
      mkCircle("Center", "#22cc44", 0.18),
    ],
  },
  flower: {
    label: "Flower",
    ai: 2,
    shapes: [
      mkPath("Shadow", flN(), "#7a1030", {
        repeatCount: 5,
        rotationDeg: -90,
        scale: 1.11,
        offsetX: 0.03,
        offsetY: 0.05,
      }),
      mkPath("Outline", flN(), "#c42050", {
        repeatCount: 5,
        rotationDeg: -90,
        scale: 1.08,
      }),
      mkPath("Petal", flN(), "#ff4e7a", { repeatCount: 5, rotationDeg: -90 }),
      mkCircle("Hub", "#c09000", 0.22),
      mkCircle("Ring", "#ffdf30", 0.17),
      mkCircle("Center", "#fff3a0", 0.12),
    ],
  },
  star: {
    label: "Star",
    ai: 2,
    shapes: [
      mkPath("Shadow", stN(), "#705500", {
        repeatCount: 5,
        rotationDeg: -90,
        scale: 1.12,
        offsetX: 0.04,
        offsetY: 0.06,
      }),
      mkPath("Outline", stN(), "#b08800", {
        repeatCount: 5,
        rotationDeg: -90,
        scale: 1.09,
      }),
      mkPath("Point", stN(), "#f0c030", { repeatCount: 5, rotationDeg: -90 }),
      mkCircle("Hub", "#b08800", 0.13),
      mkCircle("Ring", "#705500", 0.09),
      mkCircle("Center", "#fef0a0", 0.06),
    ],
  },
  leaf: {
    label: "Leaf",
    ai: 2,
    shapes: [
      mkPath("Shadow", lfN(), "#0e500e", {
        repeatCount: 4,
        rotationDeg: -45,
        scale: 1.09,
        offsetX: 0.03,
        offsetY: 0.05,
      }),
      mkPath("Outline", lfN(), "#1e8c1e", {
        repeatCount: 4,
        rotationDeg: -45,
        scale: 1.07,
      }),
      mkPath("Leaf", lfN(), "#3ec83e", { repeatCount: 4, rotationDeg: -45 }),
      mkCircle("Center", "#b8ffb8", 0.09),
    ],
  },
  gem: {
    label: "Gem",
    ai: 1,
    shapes: [
      mkPath("Outline", gmN(), "#1f6f99", { scale: 1.08 }),
      mkPath("Body", gmN(), "#5ad1ff"),
      mkPath("HL", gmH(), "#d7f5ff"),
    ],
  },
  arrow: { label: "Arrow", ai: 0, shapes: [mkPath("Arrow", arN(), "#5272f0")] },
  heart: {
    label: "Heart",
    ai: 0,
    shapes: [
      mkPath("Shadow", htN(), "#8a0030", {
        scale: 1.07,
        offsetX: 0.03,
        offsetY: 0.05,
      }),
      mkPath("Heart", htN(), "#ff3060"),
      mkCircle("Shine", "#ffccdd", 0.15, {
        offsetX: -0.18,
        offsetY: -0.45,
        scale: 0.5,
      }),
    ],
  },
  shield: {
    label: "Shield",
    ai: 0,
    shapes: [
      mkPath("Shadow", shN(), "#1a3a6a", {
        scale: 1.07,
        offsetX: 0.03,
        offsetY: 0.05,
      }),
      mkPath("Shield", shN(), "#2a60c8"),
      mkPath("Trim", shN(), "#6090ff", { scale: 0.75 }),
    ],
  },
  cross: {
    label: "Cross",
    ai: 0,
    shapes: [
      mkPath("Shadow", crN(), "#5a2200", {
        scale: 1.06,
        offsetX: 0.03,
        offsetY: 0.04,
      }),
      mkPath("Cross", crN(), "#e07020"),
    ],
  },
  moon: {
    label: "Moon",
    ai: 0,
    shapes: [
      mkPath(
        "Moon",
        [
          nd("M", 0, -1),
          nd("C", 0.55, -1, 1, -0.45, 1, 0),
          nd("C", 1, 0.55, 0.55, 1, 0, 1),
          nd("C", 0.1, 0.5, 0.3, -0.1, 0.2, -0.4),
          nd("C", 0.1, -0.7, -0.4, -1, 0, -1),
        ],
        "#f0e050",
      ),
      mkCircle("Glow", "#fff8a0", 0.08, {
        offsetX: -0.1,
        offsetY: -0.2,
        scale: 0.4,
      }),
    ],
  },
  crystal: {
    label: "Crystal",
    ai: 0,
    shapes: [
      mkPath("Shadow", crysN(), "#0a2040", {
        scale: 1.07,
        offsetX: 0.02,
        offsetY: 0.04,
      }),
      mkPath("Body", crysN(), "#1060c0"),
      mkPath(
        "Face",
        [
          nd("M", 0, -1),
          nd("L", 0.4, -0.3),
          nd("L", 0, 0.2),
          nd("L", -0.4, -0.3),
        ],
        "#5090ff",
      ),
      mkPath(
        "HL",
        [
          nd("M", 0, -1),
          nd("L", 0.2, -0.6),
          nd("L", 0, -0.2),
          nd("L", -0.2, -0.6),
        ],
        "#a0d0ff",
      ),
    ],
  },
  badge: {
    label: "Badge",
    ai: 0,
    shapes: [
      mkPath("Shadow", bdgN(), "#4a1a00", {
        scale: 1.07,
        offsetX: 0.02,
        offsetY: 0.04,
      }),
      mkPath("Body", bdgN(), "#d04010"),
      mkCircle("InnerRing", "#ff8040", 0.72),
      mkCircle("Center", "#fff0e0", 0.55),
      mkText("Label", "#c04010", {
        text: "BADGE",
        fontSize: 0.18,
        fontWeight: "bold",
      }),
    ],
  },
};

function cloneShape(s) {
  const c = JSON.parse(JSON.stringify(s));
  c.id = uid();
  if (!c.stroke) c.stroke = mkStroke();
  if (c.fill === undefined) c.fill = c.type !== "freehand";
  if (c.isMask === undefined) c.isMask = false;
  if (c.groupId === undefined) c.groupId = null;
  if (c.opacity === undefined) c.opacity = 1; // v8
  if (c.nodes) c.nodes.forEach((n) => (n.id = uid()));
  return c;
}
function applyPreset(name) {
  const def = PRESETS[name];
  if (!def) return;
  S.shapes = def.shapes.map(cloneShape);
  S.groups = {};
  S.activeId = S.shapes.length
    ? S.shapes[def.ai ?? S.shapes.length - 1].id
    : null;
  S.selNodeId = null;
  S.selectedIds.clear();
  multiBase = null;
  hPush();
  renderLayers();
  renderProps();
  redraw();
  toast('"' + def.label + '" loaded');
}
function resetCanvas() {
  S.shapes = [];
  S.activeId = null;
  S.selNodeId = null;
  S.groups = {};
  S.selectedIds.clear();
  multiBase = null;
  setMode("select");
  hPush();
  renderLayers();
  renderProps();
  redraw();
  toast("Cleared");
}

// ══════════════════════════════════════════
// CANVAS & VIEWPORT
// ══════════════════════════════════════════
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
function getVP() {
  return {
    cx: canvas.width / 2 + S.panX,
    cy: canvas.height / 2 + S.panY,
    s: (S.previewSize / 2) * S.zoom,
  };
}
function getMPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function resize() {
  const el = document.getElementById("carea");
  canvas.width = el.offsetWidth;
  canvas.height = el.offsetHeight;
  redraw();
}

// ══════════════════════════════════════════
// COORDINATE MATH
// ══════════════════════════════════════════
function localToScreen(sh, lx, ly, rep = 0) {
  const { cx, cy, s } = getVP();
  const reps = Math.max(1, Math.round(sh.repeatCount || 1));
  const rotDeg = (sh.rotationDeg || 0) + rep * (360 / reps);
  const rot = (rotDeg * Math.PI) / 180;
  const C = Math.cos(rot),
    SN = Math.sin(rot),
    sc = sh.scale || 1;
  const rx = lx * sc * C - ly * sc * SN,
    ry = lx * sc * SN + ly * sc * C;
  return [cx + s * (rx + (sh.offsetX || 0)), cy + s * (ry + (sh.offsetY || 0))];
}
function screenToLocal(sh, sx, sy) {
  const { cx, cy, s } = getVP();
  const ox = (sx - cx) / s - (sh.offsetX || 0),
    oy = (sy - cy) / s - (sh.offsetY || 0);
  const rot = (-(sh.rotationDeg || 0) * Math.PI) / 180;
  const C = Math.cos(rot),
    SN = Math.sin(rot),
    sc = sh.scale || 1;
  return [(ox * C - oy * SN) / sc, (ox * SN + oy * C) / sc];
}
function setZoom(z) {
  S.zoom = clamp(z, 0.08, 10);
  document.getElementById("zoomDisp").textContent =
    Math.round(S.zoom * 100) + "%";
  redraw();
}
function resetView() {
  S.panX = 0;
  S.panY = 0;
  setZoom(1);
}

// ══════════════════════════════════════════
// SMART SNAP
// ══════════════════════════════════════════
function getSnapped(lx, ly, excludeId = null, forceGrid = false) {
  if (!S.snapEnabled && !forceGrid) {
    snapState = null;
    return [lx, ly];
  }
  const t = S.snapThreshold;
  let rx = lx,
    ry = ly,
    sx = false,
    sy = false,
    sxv = lx,
    syv = ly;
  const tryX = (v) => {
    if (!sx && Math.abs(v - lx) < t) {
      rx = v;
      sx = true;
      sxv = v;
    }
  };
  const tryY = (v) => {
    if (!sy && Math.abs(v - ly) < t) {
      ry = v;
      sy = true;
      syv = v;
    }
  };
  if (forceGrid || S.snapAxis) {
    tryX(0);
    tryY(0);
  }
  if (forceGrid || S.snapGrid) {
    const g = S.snapGridSize;
    tryX(Math.round(lx / g) * g);
    tryY(Math.round(ly / g) * g);
  }
  if (S.snapRing) {
    const d = Math.hypot(lx, ly);
    if (Math.abs(d - 1) < t) {
      const a = Math.atan2(ly, lx);
      tryX(Math.cos(a));
      tryY(Math.sin(a));
    }
  }
  if (S.snapPoints) {
    for (const sh of S.shapes) {
      if (sh.type === "path" && sh.nodes) {
        for (const n of sh.nodes) {
          if (n.id === excludeId) continue;
          tryX(n.x);
          tryY(n.y);
        }
      } else if (sh.type === "circle") {
        tryX(sh.x);
        tryY(sh.y);
      }
    }
  }
  snapState = { sx, sy, sxv, syv };
  return [rx, ry];
}
function drawSnapGuides(cx, cy, s) {
  if (!snapState || (!snapState.sx && !snapState.sy) || !drag) return;
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  if (snapState.sx) {
    const px = cx + snapState.sxv * s;
    ctx.strokeStyle = "rgba(0,212,255,.5)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }
  if (snapState.sy) {
    const py = cy + snapState.syv * s;
    ctx.strokeStyle = "rgba(255,160,0,.5)";
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(canvas.width, py);
    ctx.stroke();
  }
  ctx.restore();
  const parts = [];
  if (snapState.sx) parts.push("x=" + parseFloat(snapState.sxv).toFixed(2));
  if (snapState.sy) parts.push("y=" + parseFloat(snapState.syv).toFixed(2));
  document.getElementById("st-snap").textContent = parts.length
    ? "🧲 " + parts.join(" ")
    : "";
}
function toggleSnap() {
  S.snapEnabled = !S.snapEnabled;
  document.getElementById("snapEnabled").checked = S.snapEnabled;
  updateCtxBar();
  redraw();
}

// ══════════════════════════════════════════
// SHAPE OPERATIONS
// ══════════════════════════════════════════
const getActive = () => S.shapes.find((s) => s.id === S.activeId) || null;
const findNode = (sh, id) =>
  sh && sh.nodes && sh.nodes.find((n) => n.id === id);

function addShape(type) {
  let sh;
  if (type === "path") {
    sh = mkPath("Path " + shapeN++, null, nextColor());
    sh.nodes = [
      { id: uid(), seg: "M", x: 0, y: -1, cx1: 0, cy1: 0, cx2: 0, cy2: 0 },
    ];
    S.shapes.push(sh);
    S.activeId = sh.id;
    S.selNodeId = sh.nodes[0].id;
    setMode("line");
  } else if (type === "circle") {
    sh = mkCircle("Circle " + shapeN++, nextColor(), 0.2);
    S.shapes.push(sh);
    S.activeId = sh.id;
    S.selNodeId = null;
    setMode("select");
  } else if (type === "text") {
    sh = mkText("Text " + shapeN++, nextColor());
    S.shapes.push(sh);
    S.activeId = sh.id;
    S.selNodeId = null;
    setMode("select");
  } else {
    sh = mkFree("Stroke " + shapeN++, nextColor(), null);
    S.shapes.push(sh);
    S.activeId = sh.id;
    S.selNodeId = null;
    setMode("freehand");
  }
  S.selectedIds.clear();
  S.selectedIds.add(sh.id);
  multiBase = null;
  hideSelPopup();
  hPush();
  renderLayers();
  renderProps();
  redraw();
}
function delShape(id) {
  const i = S.shapes.findIndex((s) => s.id === id);
  if (i < 0) return;
  S.shapes.splice(i, 1);
  if (S.activeId === id) {
    S.activeId = S.shapes.length ? S.shapes[Math.max(0, i - 1)].id : null;
    S.selNodeId = null;
  }
  S.selectedIds.delete(id);
  hPush();
  renderLayers();
  renderProps();
  redraw();
}
function dupShape(id) {
  const sh = S.shapes.find((s) => s.id === id);
  if (!sh) return;
  const c = cloneShape(sh);
  c.name = sh.name + " copy";
  c.groupId = null;
  S.shapes.splice(S.shapes.indexOf(sh) + 1, 0, c);
  S.activeId = c.id;
  S.selNodeId = null;
  hPush();
  renderLayers();
  renderProps();
  redraw();
}
function deleteSelected() {
  const ids = [...S.selectedIds];
  ids.forEach((id) => {
    const i = S.shapes.findIndex((s) => s.id === id);
    if (i >= 0) S.shapes.splice(i, 1);
  });
  S.selectedIds.clear();
  S.activeId = S.shapes.length ? S.shapes[S.shapes.length - 1].id : null;
  S.selNodeId = null;
  multiBase = null;
  hideSelPopup();
  hPush();
  renderLayers();
  renderProps();
  redraw();
  toast("Deleted " + ids.length + " layers");
}

function addNode(shape, x, y, seg, insertAfterIdx = -1) {
  if (!shape || shape.type !== "path") {
    toast("Select a path layer first");
    return null;
  }
  if (!shape.nodes || shape.nodes.length === 0) {
    const n = { id: uid(), seg: "M", x, y, cx1: 0, cy1: 0, cx2: 0, cy2: 0 };
    shape.nodes = [n];
    return n;
  }
  const prev =
    insertAfterIdx >= 0
      ? shape.nodes[insertAfterIdx]
      : shape.nodes[shape.nodes.length - 1];
  let cx1 = 0,
    cy1 = 0,
    cx2 = 0,
    cy2 = 0;
  if (seg === "Q" || seg === "C") {
    const dx = x - prev.x,
      dy = y - prev.y,
      len = Math.hypot(-dy, dx) || 1;
    const nx = -dy / len,
      ny = dx / len;
    if (seg === "Q") {
      cx1 = (prev.x + x) / 2 + nx * 0.15;
      cy1 = (prev.y + y) / 2 + ny * 0.15;
    } else {
      cx1 = prev.x + dx * 0.33 + nx * 0.1;
      cy1 = prev.y + dy * 0.33 + ny * 0.1;
      cx2 = prev.x + dx * 0.66 - nx * 0.1;
      cy2 = prev.y + dy * 0.66 - ny * 0.1;
    }
  }
  const n = { id: uid(), seg, x, y, cx1, cy1, cx2, cy2 };
  if (insertAfterIdx >= 0) shape.nodes.splice(insertAfterIdx + 1, 0, n);
  else shape.nodes.push(n);
  return n;
}
function delNode(shape, nid) {
  if (!shape || shape.type !== "path") return;
  if (shape.nodes.length <= 1) {
    toast("Need ≥1 point");
    return;
  }
  const i = shape.nodes.findIndex((n) => n.id === nid);
  if (i < 0) return;
  shape.nodes.splice(i, 1);
  if (i === 0 && shape.nodes.length) shape.nodes[0].seg = "M";
  if (S.selNodeId === nid) S.selNodeId = null;
}

// ══════════════════════════════════════════
// v8: RELOCATE BASE POINT
// ══════════════════════════════════════════
function relocateBasePoint(sh, mx, my) {
  const { cx, cy, s } = getVP();
  const new_ox = (mx - cx) / s;
  const new_oy = (my - cy) / s;
  const delta_X = (sh.offsetX || 0) - new_ox;
  const delta_Y = (sh.offsetY || 0) - new_oy;
  const rot = ((sh.rotationDeg || 0) * Math.PI) / 180;
  const C = Math.cos(rot),
    SN = Math.sin(rot),
    sc = sh.scale || 1;
  const Dx = delta_X / sc,
    Dy = delta_Y / sc;
  const shiftX = Dx * C + Dy * SN;
  const shiftY = -Dx * SN + Dy * C;
  if (sh.type === "path" && sh.nodes) {
    sh.nodes.forEach((n) => {
      n.x += shiftX;
      n.y += shiftY;
      n.cx1 += shiftX;
      n.cy1 += shiftY;
      n.cx2 += shiftX;
      n.cy2 += shiftY;
    });
  } else if (sh.type === "circle") {
    sh.x += shiftX;
    sh.y += shiftY;
  } else if (sh.type === "freehand" && sh.points) {
    sh.points = sh.points.map(([x, y]) => [x + shiftX, y + shiftY]);
  }
  sh.offsetX = new_ox;
  sh.offsetY = new_oy;
  hPush();
  renderProps();
  redraw();
  toast("Base point relocated");
}

// ══════════════════════════════════════════
// v8: CONNECT MODE
// ══════════════════════════════════════════
function handleConnectClick(mx, my) {
  const sh = getActive();
  if (!sh || sh.type !== "path") {
    toast("Select a path layer first");
    return;
  }
  const hit = hitTestHandles(mx, my);
  if (!hit || hit.t !== "anchor" || !hit.n) {
    toast("Click on an anchor point");
    return;
  }
  if (!connectFirst) {
    connectFirst = { shId: sh.id, nodeId: hit.n.id, lx: hit.n.x, ly: hit.n.y };
    document.getElementById("connectInd").style.display = "flex";
    document.getElementById("connectIndTxt").textContent =
      "⟜ Connect: click 2nd anchor";
    redraw();
    return;
  }
  // Connect first → second
  if (!sh.nodes) sh.nodes = [];
  // Add M at first point, then L segment to second
  const seg =
    { line: "L", quad: "Q", cubic: "C" }[S._connectSeg || "line"] || "L";
  const existing = sh.nodes.find((n) => n.id === connectFirst.nodeId);
  if (existing) {
    const n1 = nd("M", existing.x, existing.y);
    const n2 = nd(seg, hit.n.x, hit.n.y);
    // compute bezier handles for Q/C
    if (seg === "Q" || seg === "C") {
      const dx = hit.n.x - existing.x,
        dy = hit.n.y - existing.y,
        len = Math.hypot(dy, dx) || 1;
      const nx = -dy / len,
        ny = dx / len;
      if (seg === "Q") {
        n2.cx1 = (existing.x + hit.n.x) / 2 + nx * 0.1;
        n2.cy1 = (existing.y + hit.n.y) / 2 + ny * 0.1;
      } else {
        n2.cx1 = existing.x + dx * 0.33;
        n2.cy1 = existing.y + dy * 0.33;
        n2.cx2 = existing.x + dx * 0.66;
        n2.cy2 = existing.y + dy * 0.66;
      }
    }
    sh.nodes.push(n1);
    sh.nodes.push(n2);
  }
  cancelConnect();
  hPush();
  renderProps();
  redraw();
  toast("Points connected");
}
function cancelConnect() {
  connectFirst = null;
  document.getElementById("connectInd").style.display = "none";
  document.getElementById("connectIndTxt").textContent =
    "⟜ Connect: click 1st anchor";
  redraw();
}

// ══════════════════════════════════════════
// v8: DRAG SELECTION
// ══════════════════════════════════════════
function findShapesInRect(minX, minY, maxX, maxY) {
  const found = [];
  for (const sh of S.shapes) {
    if (!sh.visible) continue;
    const reps = S.showRepeats
      ? Math.max(1, Math.round(sh.repeatCount || 1))
      : 1;
    let hit = false;
    for (let r = 0; r < reps && !hit; r++) {
      if (sh.type === "path" && sh.nodes) {
        for (const n of sh.nodes) {
          const [px, py] = localToScreen(sh, n.x, n.y, r);
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
            hit = true;
            break;
          }
        }
      } else if (sh.type === "circle") {
        const [px, py] = localToScreen(sh, sh.x, sh.y, r);
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) hit = true;
      } else if (sh.type === "text") {
        const [px, py] = localToScreen(sh, 0, 0, r);
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) hit = true;
      } else if (sh.type === "freehand" && sh.points) {
        for (const [x, y] of sh.points) {
          const [px, py] = localToScreen(sh, x, y, r);
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) found.push(sh.id);
  }
  return found;
}
function calcMultiBase() {
  const shapes = S.shapes.filter((sh) => S.selectedIds.has(sh.id));
  if (!shapes.length) {
    multiBase = null;
    return;
  }
  const { cx, cy, s } = getVP();
  let sumX = 0,
    sumY = 0;
  for (const sh of shapes) {
    sumX += cx + (sh.offsetX || 0) * s;
    sumY += cy + (sh.offsetY || 0) * s;
  }
  multiBase = { x: sumX / shapes.length, y: sumY / shapes.length };
}
function showSelPopup(rx, ry, rw, rh) {
  const popup = document.getElementById("selPopup");
  const count = S.selectedIds.size;
  document.getElementById("selPopupCount").textContent =
    count + " shape" + (count !== 1 ? "s" : "") + " selected";
  // reset controls
  ["spOpacity", "spRot", "spScale"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = id === "spOpacity" ? 1 : id === "spScale" ? 1 : 0;
  });
  document.getElementById("spOpacityV").textContent = "100%";
  document.getElementById("spRotV").textContent = "0°";
  document.getElementById("spScaleV").textContent = "1.00×";
  // position near bottom-right of selection
  const W = window.innerWidth,
    H = window.innerHeight;
  const pw = 220,
    ph = 160;
  let left = Math.min(Math.max(rx + rw, 8), W - pw - 8);
  let top = Math.min(Math.max(ry + rh + 8, 8), H - ph - 40);
  popup.style.left = left + "px";
  popup.style.top = top + "px";
  popup.style.display = "block";
}
function hideSelPopup() {
  document.getElementById("selPopup").style.display = "none";
}

// Apply same property value to all selected shapes
function applySelProp(prop, val) {
  S.shapes.forEach((sh) => {
    if (S.selectedIds.has(sh.id)) sh[prop] = val;
  });
  redraw();
}
// Apply delta to all selected shapes (for rotation where we want additive)
const _selDeltaBase = {}; // store original values
function applySelDelta(prop, val) {
  S.shapes.forEach((sh) => {
    if (S.selectedIds.has(sh.id)) {
      if (_selDeltaBase[sh.id + prop] === undefined)
        _selDeltaBase[sh.id + prop] = sh[prop] || 0;
      sh[prop] = _selDeltaBase[sh.id + prop] + val;
    }
  });
  redraw();
}
function applySelFlip(axis) {
  S.shapes.forEach((sh) => {
    if (S.selectedIds.has(sh.id)) flipShape(sh, axis);
  });
  // flipShape already calls hPush
}

// ══════════════════════════════════════════
// FLIP
// ══════════════════════════════════════════
function flipShape(sh, axis) {
  if (!sh) return;
  if (sh.type === "path" && sh.nodes) {
    sh.nodes.forEach((n) => {
      if (axis === "h") {
        n.x = -n.x;
        n.cx1 = -n.cx1;
        n.cx2 = -n.cx2;
      } else {
        n.y = -n.y;
        n.cy1 = -n.cy1;
        n.cy2 = -n.cy2;
      }
    });
  } else if (sh.type === "circle") {
    if (axis === "h") sh.x = -sh.x;
    else sh.y = -sh.y;
  } else if (sh.type === "freehand" && sh.points) {
    sh.points = sh.points.map(([x, y]) => (axis === "h" ? [-x, y] : [x, -y]));
  }
  hPush();
  renderProps();
  redraw();
}

// ══════════════════════════════════════════
// MERGE / EXPAND
// ══════════════════════════════════════════
function mergeShapes() {
  const ids = S.selectedIds.size
    ? [...S.selectedIds]
    : S.activeId
      ? [S.activeId]
      : [];
  const paths = S.shapes.filter(
    (sh) => ids.includes(sh.id) && sh.type === "path",
  );
  if (paths.length < 2) {
    toast("Ctrl+click 2+ path layers to merge");
    return;
  }
  const target = paths[0];
  const mergedNodes = target.nodes.map((n) => ({ ...n, id: uid() }));
  for (let i = 1; i < paths.length; i++) {
    const sh = paths[i];
    if (sh.nodes && sh.nodes.length) {
      const ns = sh.nodes.map((n, idx) => ({
        ...n,
        id: uid(),
        seg: idx === 0 ? "M" : n.seg,
      }));
      mergedNodes.push(...ns);
    }
  }
  target.nodes = mergedNodes;
  for (let i = 1; i < paths.length; i++) {
    const idx = S.shapes.indexOf(paths[i]);
    if (idx >= 0) S.shapes.splice(idx, 1);
  }
  S.activeId = target.id;
  S.selectedIds.clear();
  S.selectedIds.add(target.id);
  hPush();
  renderLayers();
  renderProps();
  redraw();
  toast("Merged " + paths.length + " paths");
}
function expandRepeats(shId) {
  const sh = S.shapes.find((s) => s.id === (shId || S.activeId));
  if (!sh || sh.type !== "path" || !sh.nodes) {
    toast("Select a path layer");
    return;
  }
  const reps = Math.max(1, Math.round(sh.repeatCount || 1));
  if (reps <= 1) {
    toast("repeatCount is already 1");
    return;
  }
  const idx = S.shapes.indexOf(sh),
    newShapes = [];
  for (let ri = 0; ri < reps; ri++) {
    const rotDeg = (sh.rotationDeg || 0) + ri * (360 / reps);
    const rot = (rotDeg * Math.PI) / 180,
      C = Math.cos(rot),
      SN = Math.sin(rot),
      sc = sh.scale || 1;
    const ox = sh.offsetX || 0,
      oy = sh.offsetY || 0;
    const newSh = {
      ...JSON.parse(JSON.stringify(sh)),
      id: uid(),
      name: sh.name + " " + (ri + 1),
      repeatCount: 1,
      rotationDeg: 0,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      groupId: null,
    };
    newSh.nodes = sh.nodes.map((n) => {
      const rx = n.x * sc * C - n.y * sc * SN + ox,
        ry = n.x * sc * SN + n.y * sc * C + oy;
      const rcx1 = n.cx1 * sc * C - n.cy1 * sc * SN,
        rcy1 = n.cx1 * sc * SN + n.cy1 * sc * C;
      const rcx2 = n.cx2 * sc * C - n.cy2 * sc * SN,
        rcy2 = n.cx2 * sc * SN + n.cy2 * sc * C;
      return {
        ...n,
        id: uid(),
        x: rx,
        y: ry,
        cx1: rcx1,
        cy1: rcy1,
        cx2: rcx2,
        cy2: rcy2,
      };
    });
    newShapes.push(newSh);
  }
  S.shapes.splice(idx, 1, ...newShapes);
  S.activeId = newShapes[newShapes.length - 1].id;
  hPush();
  renderLayers();
  renderProps();
  redraw();
  toast("Expanded to " + reps + " paths");
}

// ══════════════════════════════════════════
// GROUP MANAGEMENT  (v8: rename added)
// ══════════════════════════════════════════
function groupSelected() {
  const ids = [...S.selectedIds].filter((id) =>
    S.shapes.some((s) => s.id === id),
  );
  if (ids.length < 2) {
    toast("Ctrl+click 2+ layers to group");
    return;
  }
  const gid = uid();
  S.groups[gid] = { id: gid, name: "Group " + shapeN++, collapsed: false };
  ids.forEach((id) => {
    const sh = S.shapes.find((s) => s.id === id);
    if (sh) sh.groupId = gid;
  });
  hPush();
  renderLayers();
  redraw();
  toast("Grouped " + ids.length + " layers");
}
function ungroupById(gid) {
  S.shapes
    .filter((sh) => sh.groupId === gid)
    .forEach((sh) => (sh.groupId = null));
  delete S.groups[gid];
  hPush();
  renderLayers();
  redraw();
  toast("Ungrouped");
}
function toggleGroupCollapse(gid) {
  if (S.groups[gid]) S.groups[gid].collapsed = !S.groups[gid].collapsed;
  renderLayers();
}

// v8: start inline rename of a group
function startGroupRename(gid) {
  const g = S.groups[gid];
  if (!g) return;
  const row = document.querySelector(`.lrow[data-gid="${gid}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".l-name");
  if (!nameEl) return;
  const inp = document.createElement("input");
  inp.className = "l-name-inp";
  inp.value = g.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    g.name = inp.value.trim() || g.name;
    hPush();
    renderLayers();
  };
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      done = true;
      renderLayers();
    }
    e.stopPropagation();
  });
}

// ══════════════════════════════════════════
// FONT LOADING
// ══════════════════════════════════════════
const loadedFonts = [];
async function loadFontFromURL() {
  const name = document.getElementById("fontNameInp").value.trim();
  const url = document.getElementById("fontUrlInp").value.trim();
  if (!name || !url) {
    toast("Enter font name and URL");
    return;
  }
  try {
    const f = new FontFace(name, `url(${url})`);
    await f.load();
    document.fonts.add(f);
    loadedFonts.push({ name, src: url });
    renderFontList();
    toast(`✓ Font "${name}" loaded`);
    redraw();
  } catch (e) {
    toast("✗ Font error: " + e.message);
  }
}
async function loadFontFromFile(file) {
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, "");
  try {
    const buf = await file.arrayBuffer();
    const f = new FontFace(name, buf);
    await f.load();
    document.fonts.add(f);
    loadedFonts.push({ name, src: file.name });
    renderFontList();
    toast(`✓ Font "${name}" loaded`);
    redraw();
  } catch (e) {
    toast("✗ Font error: " + e.message);
  }
  document.getElementById("fontFileInp").value = "";
}
function renderFontList() {
  document.getElementById("fontList").innerHTML = loadedFonts
    .map(
      (f, i) =>
        `<div class="font-chip"><span style="font-family:'${f.name}'">${f.name}</span><span class="fc-del" onclick="removeFont(${i})">✕</span></div>`,
    )
    .join("");
}
function removeFont(i) {
  if (i < 0 || i >= loadedFonts.length) return;
  loadedFonts.splice(i, 1);
  renderFontList();
}

// ══════════════════════════════════════════
// FREEHAND
// ══════════════════════════════════════════
function startFree(mx, my) {
  freeDraw = true;
  freePts = [];
  const sh = getActive();
  if (!sh || sh.type !== "freehand") return;
  const [lx, ly] = screenToLocal(sh, mx, my);
  freePts.push([lx, ly]);
}
function moveFree(mx, my) {
  if (!freeDraw) return;
  const sh = getActive();
  if (!sh) return;
  const [lx, ly] = screenToLocal(sh, mx, my);
  const last = freePts[freePts.length - 1];
  if (Math.hypot(lx - last[0], ly - last[1]) > 0.012) {
    freePts.push([lx, ly]);
    redraw();
  }
}
function endFree() {
  if (!freeDraw) return;
  freeDraw = false;
  const sh = getActive();
  if (!sh) return;
  if (freePts.length > 2) sh.points = rdpSimplify(freePts, 0.008);
  freePts = [];
  hPush();
  renderProps();
  redraw();
}
function rdpSimplify(pts, tol) {
  if (pts.length < 3) return pts;
  function rdp(pts, s, e, tol, r) {
    if (e <= s + 1) {
      r.push(pts[e]);
      return;
    }
    let md = 0,
      mi = s + 1;
    const dx = pts[e][0] - pts[s][0],
      dy = pts[e][1] - pts[s][1],
      len = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const d =
        Math.abs((pts[i][0] - pts[s][0]) * dy - (pts[i][1] - pts[s][1]) * dx) /
        len;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol) {
      rdp(pts, s, mi, tol, r);
      rdp(pts, mi, e, tol, r);
    } else r.push(pts[e]);
  }
  const r = [pts[0]];
  rdp(pts, 0, pts.length - 1, tol, r);
  return r;
}

// ══════════════════════════════════════════
// SHAPE GEOMETRY BUILDERS
// ══════════════════════════════════════════
function makePolyNodes(cxp, cyp, outerR, sides, innerR) {
  const n = innerR > 0 ? sides * 2 : sides;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = innerR > 0 && i % 2 === 1 ? innerR : outerR;
    return nd(
      i === 0 ? "M" : "L",
      cxp + Math.cos(a) * r,
      cyp + Math.sin(a) * r,
    );
  });
}
function makeRRectNodes(lft, top, rgt, bot, cr) {
  if (cr <= 0)
    return [
      nd("M", lft, top),
      nd("L", rgt, top),
      nd("L", rgt, bot),
      nd("L", lft, bot),
    ];
  cr = Math.min(cr, (rgt - lft) / 2, (bot - top) / 2);
  const k = cr * 0.5523;
  return [
    nd("M", lft + cr, top),
    nd("L", rgt - cr, top),
    nd("C", rgt, top + cr, rgt - cr + k, top, rgt, top + cr - k),
    nd("L", rgt, bot - cr),
    nd("C", rgt - cr, bot, rgt, bot - cr + k, rgt - cr + k, bot),
    nd("L", lft + cr, bot),
    nd("C", lft, bot - cr, lft + cr - k, bot, lft, bot - cr + k),
    nd("L", lft, top + cr),
    nd("C", lft + cr, top, lft, top + cr - k, lft + cr - k, top),
  ];
}
function makeSpiralNodes(cxp, cyp, outerR, turns) {
  const steps = Math.round(turns * 32);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const a = t * turns * Math.PI * 2 - Math.PI / 2;
    const r = t * outerR;
    return nd(
      i === 0 ? "M" : "L",
      cxp + Math.cos(a) * r,
      cyp + Math.sin(a) * r,
    );
  });
}

// ══════════════════════════════════════════
// GESTURE TOOLS
// ══════════════════════════════════════════
const GESTURE_TYPES = [
  "rect",
  "ellipse",
  "arc",
  "polygon",
  "star",
  "triangle",
  "rrect",
  "spiral",
];
function startGesture(mx, my, type) {
  const sh = getActive();
  if (!sh || sh.type !== "path") {
    toast("Select a path layer first");
    return;
  }
  const [lx, ly] = screenToLocal(sh, mx, my);
  gesture = { type, sx: lx, sy: ly, ex: lx, ey: ly, sh };
}
function moveGesture(mx, my) {
  if (!gesture) return;
  const [lx, ly] = screenToLocal(gesture.sh, mx, my);
  gesture.ex = lx;
  gesture.ey = ly;
  redraw();
}
function drawGesturePreview() {
  if (!gesture) return;
  const { sx, sy, ex, ey, sh, type } = gesture;
  ctx.save();
  ctx.strokeStyle = "rgba(82,114,240,.8)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  const { s } = getVP();
  if (type === "rect" || type === "rrect") {
    const [ax, ay] = localToScreen(sh, sx, sy),
      [bx, by] = localToScreen(sh, ex, ey);
    ctx.beginPath();
    ctx.rect(ax, ay, bx - ax, by - ay);
    ctx.stroke();
  } else if (type === "ellipse" || type === "arc") {
    const [ox, oy] = localToScreen(sh, (sx + ex) / 2, (sy + ey) / 2);
    const rw = (Math.abs(ex - sx) / 2) * s * (sh.scale || 1),
      rh = (Math.abs(ey - sy) / 2) * s * (sh.scale || 1);
    ctx.beginPath();
    ctx.ellipse(ox, oy, rw, rh, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const [ax, ay] = localToScreen(sh, sx, sy);
    const outerR = Math.hypot(ex - sx, ey - sy);
    const rad = outerR * s * (sh.scale || 1);
    ctx.beginPath();
    ctx.arc(ax, ay, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
function commitGesture() {
  if (!gesture) return;
  const { type, sx, sy, ex, ey, sh } = gesture;
  gesture = null;
  const cxp = (sx + ex) / 2,
    cyp = (sy + ey) / 2,
    rx = Math.abs(ex - sx) / 2,
    ry = Math.abs(ey - sy) / 2;
  const outerR = Math.hypot(ex - sx, ey - sy),
    k = 0.5523;
  sh.nodes = [];
  if (type === "rect") {
    [
      [sx, sy],
      [ex, sy],
      [ex, ey],
      [sx, ey],
    ].forEach(([x, y], i) => sh.nodes.push(nd(i === 0 ? "M" : "L", x, y)));
    sh.closePath = true;
  } else if (type === "rrect") {
    const lft = Math.min(sx, ex),
      top = Math.min(sy, ey),
      rgt = Math.max(sx, ex),
      bot = Math.max(sy, ey);
    sh.nodes = makeRRectNodes(lft, top, rgt, bot, S.rrectRadius);
    sh.closePath = true;
  } else if (type === "ellipse") {
    sh.nodes = [
      nd("M", cxp, cyp - ry),
      nd("C", cxp + rx, cyp, cxp + rx * k, cyp - ry, cxp + rx, cyp - ry * k),
      nd("C", cxp, cyp + ry, cxp + rx, cyp + ry * k, cxp + rx * k, cyp + ry),
      nd("C", cxp - rx, cyp, cxp - rx * k, cyp + ry, cxp - rx, cyp + ry * k),
      nd("C", cxp, cyp - ry, cxp - rx, cyp - ry * k, cxp - rx * k, cyp - ry),
    ];
    sh.closePath = true;
  } else if (type === "arc") {
    sh.nodes = [
      nd("M", cxp - rx, cyp),
      nd("C", cxp, cyp - ry, cxp - rx, cyp - ry * k, cxp - rx * k, cyp - ry),
      nd("C", cxp + rx, cyp, cxp + rx * k, cyp - ry, cxp + rx, cyp - ry * k),
    ];
    sh.closePath = false;
  } else if (type === "polygon") {
    sh.nodes = makePolyNodes(sx, sy, outerR, S.polyOpts.sides, 0);
    sh.closePath = true;
  } else if (type === "star") {
    sh.nodes = makePolyNodes(
      sx,
      sy,
      outerR,
      S.polyOpts.sides,
      outerR * (S.polyOpts.innerR || 0.45),
    );
    sh.closePath = true;
  } else if (type === "triangle") {
    sh.nodes = makePolyNodes(sx, sy, outerR, 3, 0);
    sh.closePath = true;
  } else if (type === "spiral") {
    sh.nodes = makeSpiralNodes(sx, sy, outerR, S.spiralTurns);
    sh.closePath = false;
    sh.fill = false;
    sh.stroke.enabled = true;
    sh.stroke.width = 0.03;
    sh.stroke.color = colorToHex(sh.color);
  }
  hPush();
  renderProps();
  redraw();
}

// ══════════════════════════════════════════
// DRAWING
// ══════════════════════════════════════════
function redraw() {
  const W = canvas.width,
    H = canvas.height;
  const { cx, cy, s } = getVP();
  ctx.clearRect(0, 0, W, H);
  drawChecker(W, H);
  if (S.showGrid) drawGrid(W, H, cx, cy);
  if (S.showSzRing) drawSzRing(cx, cy, s);
  drawRef(cx, cy, s);
  for (let i = 0; i < S.shapes.length; i++) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.isMask) continue;
    const maskSh =
      i + 1 < S.shapes.length &&
      S.shapes[i + 1].isMask &&
      S.shapes[i + 1].visible
        ? S.shapes[i + 1]
        : null;
    const n = S.showRepeats ? Math.max(1, Math.round(sh.repeatCount || 1)) : 1;
    if (maskSh) drawWithMask(sh, maskSh, n, cx, cy, s);
    else for (let ri = 0; ri < n; ri++) drawInstance(sh, ri, cx, cy, s);
  }
  drawSnapGuides(cx, cy, s);
  if (gesture) drawGesturePreview();
  // draw drag selection rect
  if (dragSel) {
    const rx = Math.min(dragSel.sx, dragSel.ex),
      ry = Math.min(dragSel.sy, dragSel.ey);
    const rw = Math.abs(dragSel.ex - dragSel.sx),
      rh = Math.abs(dragSel.ey - dragSel.sy);
    ctx.save();
    ctx.fillStyle = "rgba(82,114,240,.07)";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = "rgba(82,114,240,.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(rx, ry, rw, rh);
    const count = findShapesInRect(rx, ry, rx + rw, ry + rh).length;
    if (count > 0) {
      ctx.fillStyle = "rgba(82,114,240,.9)";
      ctx.font = "10px monospace";
      ctx.setLineDash([]);
      ctx.fillText(
        count + " shape" + (count !== 1 ? "s" : ""),
        rx + 5,
        ry + 14,
      );
    }
    ctx.restore();
  }
  // draw multi-base handle
  if (multiBase && S.selectedIds.size > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(multiBase.x, multiBase.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240,200,0,.22)";
    ctx.fill();
    ctx.strokeStyle = "#f0c800";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(multiBase.x - 6, multiBase.y);
    ctx.lineTo(multiBase.x + 6, multiBase.y);
    ctx.moveTo(multiBase.x, multiBase.y - 6);
    ctx.lineTo(multiBase.x, multiBase.y + 6);
    ctx.stroke();
    ctx.restore();
  }
  // draw connect-first indicator
  if (connectFirst) {
    const sh = S.shapes.find((s) => s.id === connectFirst.shId);
    if (sh) {
      const [px, py] = localToScreen(sh, connectFirst.lx, connectFirst.ly, 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(82,114,240,.9)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.fillStyle = "rgba(82,114,240,.3)";
      ctx.fill();
      ctx.restore();
    }
  }
  // relocate mode indicator
  if (S.mode === "relocate") {
    const sh = getActive();
    if (sh) {
      const [ox, oy] = localToScreen(sh, 0, 0, 0);
      ctx.save();
      ctx.strokeStyle = "#ff9d4d";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(ox, oy, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = "9px monospace";
      ctx.fillStyle = "#ff9d4d";
      ctx.fillText("click to set base", ox + 13, oy + 3);
      ctx.restore();
    }
  }
  const active = getActive();
  if (active && S.showHandles) drawHandles(active, cx, cy, s);
  if (freeDraw && freePts.length > 1) {
    const sh = getActive();
    if (sh) drawFreePrev(sh, freePts);
  }
  if (S.mode === "ref" && S.refImg && S.refVisible) drawRefHandles(cx, cy, s);
  if (active && active.isMask) drawMaskIndicator(active, cx, cy, s);
  updStatus();
  generateExport();
  generateJSONView();
  updateExportPreview();
}

function drawChecker(W, H) {
  const cell = 14,
    dk = S.theme === "dark";
  for (let y = 0; y < H; y += cell)
    for (let x = 0; x < W; x += cell) {
      ctx.fillStyle =
        (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
          ? dk
            ? "#0c1020"
            : "#d8dcec"
          : dk
            ? "#090d1a"
            : "#dde1ed";
      ctx.fillRect(x, y, cell, cell);
    }
}
function drawGrid(W, H, cx, cy) {
  ctx.save();
  const cell = 40 * S.zoom,
    dk = S.theme === "dark";
  const ox = ((cx % cell) + cell) % cell,
    oy = ((cy % cell) + cell) % cell;
  ctx.strokeStyle = dk ? "rgba(255,255,255,.03)" : "rgba(0,0,80,.05)";
  ctx.lineWidth = 1;
  for (let x = ox; x < W; x += cell) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = oy; y < H; y += cell) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = dk ? "rgba(255,255,255,.07)" : "rgba(0,0,80,.1)";
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.stroke();
  ctx.restore();
}
function drawSzRing(cx, cy, s) {
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(82,114,240,.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "rgba(82,114,240,.55)";
  ctx.font = "9px monospace";
  ctx.fillText(Math.round(S.previewSize) + "px", cx + s + 4, cy + 3);
}

// v8: ref with rotation support and scale handle
function drawRef(cx, cy, s) {
  if (!S.refImg || !S.refVisible) return;
  const img = S.refImg,
    sc = S.refScale;
  const w = img.width * sc * S.zoom,
    h = img.height * sc * S.zoom;
  const hx = cx + S.refOffX * s,
    hy = cy + S.refOffY * s;
  ctx.save();
  ctx.globalAlpha = S.refOpacity;
  ctx.translate(hx, hy);
  ctx.rotate(((S.refRotate || 0) * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}
function drawRefHandles(cx, cy, s) {
  if (!S.refImg || !S.refVisible) return;
  const img = S.refImg,
    sc = S.refScale;
  const w = img.width * sc * S.zoom,
    h = img.height * sc * S.zoom;
  const hx = cx + S.refOffX * s,
    hy = cy + S.refOffY * s;
  const rot = ((S.refRotate || 0) * Math.PI) / 180;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(rot);
  // center handle
  ctx.strokeStyle = "rgba(0,200,100,.8)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(7, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(0, 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  // scale handle (bottom-right corner)
  ctx.fillStyle = "#f0c800";
  ctx.strokeStyle = "#f0c800";
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 5, 0, Math.PI * 2);
  ctx.fill();
  // rotate handle (top-right)
  ctx.fillStyle = "#5272f0";
  ctx.beginPath();
  ctx.arc(w / 2, -h / 2, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function drawMaskIndicator(sh, cx, cy, s) {
  if (sh.type !== "path" || !sh.nodes || !sh.nodes.length) return;
  ctx.save();
  ctx.strokeStyle = "rgba(128,80,255,.4)";
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  const reps = Math.max(1, Math.round(sh.repeatCount || 1));
  for (let r = 0; r < reps; r++) {
    const p = buildPath2D(sh, r);
    ctx.stroke(p);
  }
  ctx.restore();
}

// v8: separate fill and stroke paths to support per-segment strokeOff
function buildPath2D(sh, rep) {
  const p = new Path2D();
  sh.nodes.forEach((n, i) => {
    const [ax, ay] = localToScreen(sh, n.x, n.y, rep);
    if (i === 0 || n.seg === "M") {
      p.moveTo(ax, ay);
      return;
    }
    if (n.seg === "L") p.lineTo(ax, ay);
    else if (n.seg === "Q") {
      const [hx, hy] = localToScreen(sh, n.cx1, n.cy1, rep);
      p.quadraticCurveTo(hx, hy, ax, ay);
    } else if (n.seg === "C") {
      const [h1x, h1y] = localToScreen(sh, n.cx1, n.cy1, rep);
      const [h2x, h2y] = localToScreen(sh, n.cx2, n.cy2, rep);
      p.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
    }
  });
  if (sh.closePath) p.closePath();
  return p;
}

// v8: stroke path respects n.strokeOff to break strokes at specific nodes
function buildStrokePath2D(sh, rep) {
  const hasBreaks = sh.nodes && sh.nodes.some((n) => n.strokeOff);
  if (!hasBreaks) return buildPath2D(sh, rep); // fast path
  const p = new Path2D();
  let penUp = true;
  sh.nodes.forEach((n, i) => {
    const [ax, ay] = localToScreen(sh, n.x, n.y, rep);
    if (i === 0 || n.seg === "M" || n.strokeOff) {
      p.moveTo(ax, ay);
      penUp = true;
      return;
    }
    if (penUp) {
      p.moveTo(ax, ay);
      penUp = false;
      return;
    } // shouldn't normally hit
    if (n.seg === "L") p.lineTo(ax, ay);
    else if (n.seg === "Q") {
      const [hx, hy] = localToScreen(sh, n.cx1, n.cy1, rep);
      p.quadraticCurveTo(hx, hy, ax, ay);
    } else if (n.seg === "C") {
      const [h1x, h1y] = localToScreen(sh, n.cx1, n.cy1, rep);
      const [h2x, h2y] = localToScreen(sh, n.cx2, n.cy2, rep);
      p.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
    }
  });
  return p;
}

function applyStroke(sh, s2, ctx2d) {
  const st = sh.stroke;
  if (!st || !st.enabled) return false;
  ctx2d.strokeStyle = st.color || colorToHex(sh.color);
  ctx2d.lineWidth = Math.max(
    0.5,
    (st.width || 0.03) * s2 * 2 * (sh.scale || 1),
  );
  ctx2d.lineCap = st.cap || "round";
  ctx2d.lineJoin = st.join || "round";
  ctx2d.setLineDash(
    (st.dash || []).map((d) => d * (st.width || 0.03) * s2 * 2),
  );
  return true;
}

function drawWithMask(sh, maskSh, reps, cx, cy, s) {
  ctx.save();
  const maskReps = Math.max(1, Math.round(maskSh.repeatCount || 1));
  const cp = new Path2D();
  if (maskSh.type === "path" && maskSh.nodes) {
    for (let r = 0; r < maskReps; r++) {
      maskSh.nodes.forEach((mn, i) => {
        const [ax, ay] = localToScreen(maskSh, mn.x, mn.y, r);
        if (i === 0 || mn.seg === "M") cp.moveTo(ax, ay);
        else if (mn.seg === "L") cp.lineTo(ax, ay);
        else if (mn.seg === "Q") {
          const [hx, hy] = localToScreen(maskSh, mn.cx1, mn.cy1, r);
          cp.quadraticCurveTo(hx, hy, ax, ay);
        } else if (mn.seg === "C") {
          const [h1x, h1y] = localToScreen(maskSh, mn.cx1, mn.cy1, r);
          const [h2x, h2y] = localToScreen(maskSh, mn.cx2, mn.cy2, r);
          cp.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
        }
      });
      if (maskSh.closePath) cp.closePath();
    }
  } else if (maskSh.type === "circle") {
    for (let r = 0; r < maskReps; r++) {
      const [px, py] = localToScreen(maskSh, maskSh.x, maskSh.y, r);
      const rad = (maskSh.scale || 1) * maskSh.radius * s;
      cp.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
    }
  }
  ctx.clip(cp);
  for (let ri = 0; ri < reps; ri++) drawInstance(sh, ri, cx, cy, s);
  ctx.restore();
}

function drawInstance(sh, rep, cx, cy, s) {
  ctx.save();
  ctx.globalAlpha = sh.opacity !== undefined ? clamp(sh.opacity, 0, 1) : 1; // v8: opacity
  const ltsFn = (sh2, lx, ly, r2) => localToScreen(sh2, lx, ly, r2);
  if (sh.type === "path") {
    if (!sh.nodes || !sh.nodes.length) {
      ctx.restore();
      return;
    }
    const fp = buildPath2D(sh, rep); // fill path (no breaks)
    const sp = buildStrokePath2D(sh, rep); // stroke path (respects strokeOff)
    if (sh.fill !== false) {
      ctx.fillStyle = resolveColorForCtx(sh.color, sh, rep, ctx, ltsFn);
      ctx.fill(fp);
    }
    if (applyStroke(sh, s, ctx)) ctx.stroke(sp);
  } else if (sh.type === "circle") {
    const [px, py] = localToScreen(sh, sh.x, sh.y, rep);
    const rad = s * (sh.scale || 1) * sh.radius;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
    if (sh.fill !== false) {
      ctx.fillStyle = resolveColorForCtx(sh.color, sh, rep, ctx, ltsFn);
      ctx.fill();
    }
    if (applyStroke(sh, s, ctx)) {
      ctx.beginPath();
      ctx.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (sh.type === "freehand" && sh.points && sh.points.length > 1) {
    if (rep > 0) {
      ctx.restore();
      return;
    }
    const reps2 = S.showRepeats
      ? Math.max(1, Math.round(sh.repeatCount || 1))
      : 1;
    for (let ri = 0; ri < reps2; ri++) {
      ctx.beginPath();
      const [sx0, sy0] = localToScreen(
        sh,
        sh.points[0][0],
        sh.points[0][1],
        ri,
      );
      ctx.moveTo(sx0, sy0);
      sh.points.forEach(([x, y]) => {
        const [px, py] = localToScreen(sh, x, y, ri);
        ctx.lineTo(px, py);
      });
      if (applyStroke(sh, s, ctx)) ctx.stroke();
      else {
        ctx.strokeStyle = colorToHex(sh.color);
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }
  } else if (sh.type === "text") {
    const [px, py] = localToScreen(sh, 0, 0, rep);
    const fs = (sh.fontSize || 0.2) * s * (sh.scale || 1);
    ctx.font = `${sh.fontWeight || "bold"} ${Math.max(6, fs)}px ${sh.fontFamily || "Arial"}`;
    ctx.fillStyle = colorToHex(sh.color);
    ctx.textAlign = sh.textAlign || "center";
    ctx.textBaseline = sh.textBaseline || "middle";
    if (sh.fill !== false) ctx.fillText(sh.text || "", px, py);
    if (applyStroke(sh, s, ctx)) ctx.strokeText(sh.text || "", px, py);
  }
  ctx.restore();
}
function drawFreePrev(sh, pts) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = sh.stroke.color || colorToHex(sh.color);
  ctx.lineWidth = (sh.stroke.width || 0.04) * (S.previewSize / 2) * S.zoom * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const [sx, sy] = localToScreen(sh, pts[0][0], pts[0][1]);
  ctx.moveTo(sx, sy);
  pts.forEach(([x, y]) => {
    const [px, py] = localToScreen(sh, x, y);
    ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}
function dot(x, y, r, col, sel) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = sel ? "#fff" : "rgba(255,255,255,.55)";
  ctx.lineWidth = sel ? 2 : 1;
  ctx.stroke();
}
function drawHandles(sh, cx, cy, s) {
  ctx.save();
  if (sh.type === "path" && sh.nodes) {
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    let prev = null;
    sh.nodes.forEach((n) => {
      const [ax, ay] = localToScreen(sh, n.x, n.y, 0);
      if (n.seg === "Q") {
        const [hx, hy] = localToScreen(sh, n.cx1, n.cy1, 0);
        if (prev) {
          ctx.strokeStyle = "#f0c06080";
          ctx.beginPath();
          ctx.moveTo(...prev);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
        ctx.strokeStyle = "#f0c06080";
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(ax, ay);
        ctx.stroke();
      } else if (n.seg === "C") {
        const [h1x, h1y] = localToScreen(sh, n.cx1, n.cy1, 0);
        const [h2x, h2y] = localToScreen(sh, n.cx2, n.cy2, 0);
        if (prev) {
          ctx.strokeStyle = "#9070ff80";
          ctx.beginPath();
          ctx.moveTo(...prev);
          ctx.lineTo(h1x, h1y);
          ctx.stroke();
        }
        ctx.strokeStyle = "#9070ff80";
        ctx.beginPath();
        ctx.moveTo(h2x, h2y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
      }
      prev = [ax, ay];
    });
    ctx.setLineDash([]);
    sh.nodes.forEach((n) => {
      const [ax, ay] = localToScreen(sh, n.x, n.y, 0);
      const sel = n.id === S.selNodeId;
      if (n.seg === "Q" || n.seg === "C") {
        const [h1x, h1y] = localToScreen(sh, n.cx1, n.cy1, 0);
        dot(h1x, h1y, 4, "#f0c060", false);
      }
      if (n.seg === "C") {
        const [h2x, h2y] = localToScreen(sh, n.cx2, n.cy2, 0);
        dot(h2x, h2y, 4, "#9070ff", false);
      }
      // v8: dim nodes with strokeOff
      if (n.strokeOff) {
        ctx.save();
        ctx.globalAlpha = 0.45;
      }
      dot(ax, ay, sel ? 7 : 5.5, n.seg === "M" ? "#fff" : "#5ad1ff", sel);
      if (n.strokeOff) ctx.restore();
    });
    const [ox, oy] = localToScreen(sh, 0, 0, 0);
    ctx.strokeStyle = "#ff9d4d";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ox - 6, oy);
    ctx.lineTo(ox + 6, oy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy - 6);
    ctx.lineTo(ox, oy + 6);
    ctx.stroke();
    // v8: in connect mode, highlight anchors
    if (S.mode === "connect") {
      sh.nodes.forEach((n) => {
        const [ax, ay] = localToScreen(sh, n.x, n.y, 0);
        ctx.beginPath();
        ctx.arc(ax, ay, 8, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(82,114,240,.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
      });
    }
  } else if (sh.type === "circle") {
    const [px, py] = localToScreen(sh, sh.x, sh.y, 0);
    const [rx, ry] = localToScreen(sh, sh.x + sh.radius, sh.y, 0);
    ctx.strokeStyle = "rgba(82,114,240,.5)";
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(px, py, 6, "#ff9d4d", false);
    dot(rx, ry, 5, "#5ad1ff", false);
  } else if (sh.type === "freehand" && sh.points) {
    sh.points.forEach(([x, y]) => {
      const [px, py] = localToScreen(sh, x, y, 0);
      dot(px, py, 3, "#5ad1ff", false);
    });
  } else if (sh.type === "text") {
    const [px, py] = localToScreen(sh, 0, 0, 0);
    dot(px, py, 6, "#ff9d4d", true);
  }
  ctx.restore();
}

// ══════════════════════════════════════════
// IMAGE EXPORT
// ══════════════════════════════════════════
function renderToOffscreen(size) {
  const oc = document.createElement("canvas");
  oc.width = size;
  oc.height = size;
  const oc2 = oc.getContext("2d");
  const cxp = size / 2,
    cyp = size / 2,
    half = size * 0.38;
  const cell = Math.round(size / 64);
  for (let y = 0; y < size; y += cell)
    for (let x = 0; x < size; x += cell) {
      oc2.fillStyle =
        (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
          ? "#1a1a2a"
          : "#141422";
      oc2.fillRect(x, y, cell, cell);
    }
  function lts(sh, lx, ly, rep = 0) {
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    const rot = (((sh.rotationDeg || 0) + rep * (360 / reps)) * Math.PI) / 180;
    const C = Math.cos(rot),
      SN = Math.sin(rot),
      sc = sh.scale || 1;
    const rx = lx * sc * C - ly * sc * SN,
      ry = lx * sc * SN + ly * sc * C;
    return [
      cxp + half * (rx + (sh.offsetX || 0)),
      cyp + half * (ry + (sh.offsetY || 0)),
    ];
  }
  const ltsFn = (sh, lx, ly, rep) => lts(sh, lx, ly, rep);
  function drawShapeOC(sh, ri) {
    oc2.save();
    oc2.globalAlpha = sh.opacity !== undefined ? clamp(sh.opacity, 0, 1) : 1;
    if (sh.type === "path" && sh.nodes && sh.nodes.length) {
      const p = new Path2D();
      sh.nodes.forEach((n, i) => {
        const [ax, ay] = lts(sh, n.x, n.y, ri);
        if (i === 0 || n.seg === "M") {
          p.moveTo(ax, ay);
          return;
        }
        if (n.seg === "L") p.lineTo(ax, ay);
        else if (n.seg === "Q") {
          const [hx, hy] = lts(sh, n.cx1, n.cy1, ri);
          p.quadraticCurveTo(hx, hy, ax, ay);
        } else if (n.seg === "C") {
          const [h1x, h1y] = lts(sh, n.cx1, n.cy1, ri);
          const [h2x, h2y] = lts(sh, n.cx2, n.cy2, ri);
          p.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
        }
      });
      if (sh.closePath) p.closePath();
      if (sh.fill !== false) {
        oc2.fillStyle = resolveColorForCtx(sh.color, sh, ri, oc2, ltsFn);
        oc2.fill(p);
      }
      const st = sh.stroke;
      if (st && st.enabled) {
        oc2.strokeStyle = st.color || colorToHex(sh.color);
        oc2.lineWidth = Math.max(
          0.5,
          (st.width || 0.03) * half * 2 * (sh.scale || 1),
        );
        oc2.lineCap = st.cap || "round";
        oc2.lineJoin = st.join || "round";
        oc2.setLineDash(
          (st.dash || []).map((d) => d * (st.width || 0.03) * half * 2),
        );
        oc2.stroke(p);
      }
    } else if (sh.type === "circle") {
      const [px, py] = lts(sh, sh.x, sh.y, ri);
      const rad = (sh.scale || 1) * sh.radius * half;
      oc2.beginPath();
      oc2.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
      if (sh.fill !== false) {
        oc2.fillStyle = resolveColorForCtx(sh.color, sh, ri, oc2, ltsFn);
        oc2.fill();
      }
      const st = sh.stroke;
      if (st && st.enabled) {
        oc2.strokeStyle = st.color || colorToHex(sh.color);
        oc2.lineWidth = Math.max(0.5, (st.width || 0.03) * half * 2);
        oc2.beginPath();
        oc2.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
        oc2.stroke();
      }
    } else if (sh.type === "freehand" && sh.points && sh.points.length > 1) {
      oc2.beginPath();
      sh.points.forEach(([x, y], i) => {
        const [px, py] = lts(sh, x, y, ri);
        i === 0 ? oc2.moveTo(px, py) : oc2.lineTo(px, py);
      });
      const st = sh.stroke;
      oc2.strokeStyle = (st && st.color) || colorToHex(sh.color);
      oc2.lineWidth = Math.max(0.5, (st ? st.width : 0.04) * half * 2);
      oc2.lineCap = "round";
      oc2.lineJoin = "round";
      oc2.stroke();
    } else if (sh.type === "text") {
      const [px, py] = lts(sh, 0, 0, ri);
      const fs = (sh.fontSize || 0.2) * (sh.scale || 1) * half * 2;
      oc2.font = `${sh.fontWeight || "bold"} ${Math.max(4, fs)}px ${sh.fontFamily || "Arial"}`;
      oc2.fillStyle = colorToHex(sh.color);
      oc2.textAlign = sh.textAlign || "center";
      oc2.textBaseline = sh.textBaseline || "middle";
      if (sh.fill !== false) oc2.fillText(sh.text || "", px, py);
    }
    oc2.restore();
  }
  for (let i = 0; i < S.shapes.length; i++) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.isMask) continue;
    const maskSh =
      i + 1 < S.shapes.length &&
      S.shapes[i + 1].isMask &&
      S.shapes[i + 1].visible
        ? S.shapes[i + 1]
        : null;
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    if (maskSh) {
      oc2.save();
      const cp = new Path2D();
      const mReps = Math.max(1, Math.round(maskSh.repeatCount || 1));
      if (maskSh.type === "path" && maskSh.nodes) {
        for (let r = 0; r < mReps; r++) {
          maskSh.nodes.forEach((mn, idx) => {
            const [ax, ay] = lts(maskSh, mn.x, mn.y, r);
            if (idx === 0 || mn.seg === "M") cp.moveTo(ax, ay);
            else if (mn.seg === "L") cp.lineTo(ax, ay);
            else if (mn.seg === "C") {
              const [h1x, h1y] = lts(maskSh, mn.cx1, mn.cy1, r);
              const [h2x, h2y] = lts(maskSh, mn.cx2, mn.cy2, r);
              cp.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
            }
          });
          if (maskSh.closePath) cp.closePath();
        }
      }
      oc2.clip(cp);
      for (let ri = 0; ri < reps; ri++) drawShapeOC(sh, ri);
      oc2.restore();
    } else {
      for (let ri = 0; ri < reps; ri++) drawShapeOC(sh, ri);
    }
  }
  return oc;
}
function savePreviewAsImage() {
  const fmt = document.getElementById("imgFormat").value;
  const ext = fmt.split("/")[1];
  const size = 1024;
  const oc = renderToOffscreen(size);
  oc.toBlob(
    (blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download =
        (S.shapeKey || "shape").replace(/[^a-z0-9_]/gi, "_") + "." + ext;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("✓ Saved as " + ext.toUpperCase());
    },
    fmt,
    0.92,
  );
}
async function copyPreviewAsImage() {
  const oc = renderToOffscreen(512);
  oc.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      toast("✓ Image copied to clipboard");
    } catch (e) {
      toast("✗ Copy failed: " + e.message);
    }
  });
}

// ══════════════════════════════════════════
// INTERACTION
// ══════════════════════════════════════════
function hitTestShapes(mx, my) {
  for (let i = S.shapes.length - 1; i >= 0; i--) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.type === "path" && sh.nodes) {
      const oc = document.createElement("canvas");
      oc.width = canvas.width;
      oc.height = canvas.height;
      const octx = oc.getContext("2d");
      const reps = S.showRepeats
        ? Math.max(1, Math.round(sh.repeatCount || 1))
        : 1;
      for (let r = 0; r < reps; r++) {
        const p = new Path2D();
        sh.nodes.forEach((n, idx) => {
          const [ax, ay] = localToScreen(sh, n.x, n.y, r);
          if (idx === 0 || n.seg === "M") {
            p.moveTo(ax, ay);
            return;
          }
          if (n.seg === "L") p.lineTo(ax, ay);
          else if (n.seg === "Q") {
            const [hx, hy] = localToScreen(sh, n.cx1, n.cy1, r);
            p.quadraticCurveTo(hx, hy, ax, ay);
          } else if (n.seg === "C") {
            const [h1x, h1y] = localToScreen(sh, n.cx1, n.cy1, r);
            const [h2x, h2y] = localToScreen(sh, n.cx2, n.cy2, r);
            p.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
          }
        });
        if (sh.closePath) p.closePath();
        octx.lineWidth = 8;
        if (octx.isPointInPath(p, mx, my) || octx.isPointInStroke(p, mx, my))
          return sh.id;
      }
    } else if (sh.type === "circle") {
      const reps = S.showRepeats
        ? Math.max(1, Math.round(sh.repeatCount || 1))
        : 1;
      const { s } = getVP();
      for (let r = 0; r < reps; r++) {
        const [px, py] = localToScreen(sh, sh.x, sh.y, r);
        if (Math.hypot(mx - px, my - py) < s * (sh.scale || 1) * sh.radius)
          return sh.id;
      }
    } else if (sh.type === "text") {
      const [px, py] = localToScreen(sh, 0, 0, 0);
      if (Math.hypot(mx - px, my - py) < 20) return sh.id;
    }
  }
  return null;
}
function hitTestHandles(mx, my) {
  const sh = getActive();
  if (!sh) return null;
  const TH = 9;
  if (sh.type === "path" && sh.nodes) {
    for (const n of sh.nodes) {
      if (n.seg === "Q" || n.seg === "C") {
        const [hx, hy] = localToScreen(sh, n.cx1, n.cy1, 0);
        if (Math.hypot(mx - hx, my - hy) < TH) return { t: "c1", n };
      }
      if (n.seg === "C") {
        const [hx, hy] = localToScreen(sh, n.cx2, n.cy2, 0);
        if (Math.hypot(mx - hx, my - hy) < TH) return { t: "c2", n };
      }
    }
    for (const n of sh.nodes) {
      const [ax, ay] = localToScreen(sh, n.x, n.y, 0);
      if (Math.hypot(mx - ax, my - ay) < TH) return { t: "anchor", n };
    }
    const [ox, oy] = localToScreen(sh, 0, 0, 0);
    if (Math.hypot(mx - ox, my - oy) < TH) return { t: "offset" };
  } else if (sh.type === "circle") {
    const [px, py] = localToScreen(sh, sh.x, sh.y, 0);
    const [rx, ry] = localToScreen(sh, sh.x + sh.radius, sh.y, 0);
    if (Math.hypot(mx - rx, my - ry) < TH) return { t: "cr" };
    if (Math.hypot(mx - px, my - py) < TH) return { t: "cc" };
  } else if (sh.type === "text") {
    const [px, py] = localToScreen(sh, 0, 0, 0);
    if (Math.hypot(mx - px, my - py) < TH) return { t: "textPos" };
  }
  return null;
}

// v8: find nearest node to screen point (for stroke-here context menu)
function nearestNodeToScreen(mx, my, threshold = 14) {
  const sh = getActive();
  if (!sh || !sh.nodes) return null;
  let best = null,
    bestD = threshold;
  for (const n of sh.nodes) {
    const [ax, ay] = localToScreen(sh, n.x, n.y, 0);
    const d = Math.hypot(mx - ax, my - ay);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const [mx, my] = getMPos(e);
  // Check for nearby node (for stroke-here)
  const nearNode = nearestNodeToScreen(mx, my, 16);
  ctxMenuNearNodeId = nearNode ? nearNode.id : null;
  const stHereEl = document.getElementById("cmStrokeHere");
  if (stHereEl) {
    stHereEl.style.display = nearNode && nearNode.seg !== "M" ? "flex" : "none";
    if (nearNode && nearNode.seg !== "M")
      stHereEl.querySelector(".cm-icon").textContent = nearNode.strokeOff
        ? "🔗"
        : "✂";
  }
  const shId = hitTestShapes(mx, my);
  if (shId) {
    ctxMenuTargetId = shId;
    S.activeId = shId;
    renderLayers();
    renderProps();
    showCtxMenu(e.clientX, e.clientY, shId);
  } else if (nearNode) {
    showCtxMenu(e.clientX, e.clientY, S.activeId);
  }
});

canvas.addEventListener("mousedown", (e) => {
  hideCtxMenu();
  const [mx, my] = getMPos(e);
  if (e.button === 2) return;

  // Middle button / pan mode
  if (e.button === 1 || S.mode === "pan") {
    panDrag = { sx: mx, sy: my, px: S.panX, py: S.panY };
    e.preventDefault();
    return;
  }

  // Relocate base point mode (v8)
  if (S.mode === "relocate") {
    const sh = getActive();
    if (sh) relocateBasePoint(sh, mx, my);
    else toast("Select a layer first");
    return;
  }

  // Connect mode (v8)
  if (S.mode === "connect") {
    handleConnectClick(mx, my);
    return;
  }

  // Ref mode (v8: improved with scale+rotate handles)
  if (S.mode === "ref" && S.refImg && S.refVisible) {
    const { cx, cy, s } = getVP();
    const hx = cx + S.refOffX * s,
      hy = cy + S.refOffY * s;
    const rot = ((S.refRotate || 0) * Math.PI) / 180;
    const w = S.refImg.width * S.refScale * S.zoom,
      h = S.refImg.height * S.refScale * S.zoom;
    // rotate handle (top-right corner)
    const rotHx =
      hx +
      Math.cos(rot - Math.PI / 2 + Math.atan2(h / 2, w / 2)) *
        Math.hypot(w / 2, h / 2);
    const rotHy =
      hy +
      Math.sin(rot - Math.PI / 2 + Math.atan2(h / 2, w / 2)) *
        Math.hypot(w / 2, h / 2);
    // scale handle (bottom-right corner)
    const scHx =
      hx + Math.cos(rot + Math.atan2(h / 2, w / 2)) * Math.hypot(w / 2, h / 2);
    const scHy =
      hy + Math.sin(rot + Math.atan2(h / 2, w / 2)) * Math.hypot(w / 2, h / 2);
    if (Math.hypot(mx - scHx, my - scHy) < 10) {
      refScaleDrag = {
        ox: S.refScale,
        baseX: hx,
        baseY: hy,
        startDist: Math.hypot(mx - hx, my - hy),
      };
      return;
    }
    if (Math.hypot(mx - rotHx, my - rotHy) < 10) {
      const startAngle = Math.atan2(my - hy, mx - hx);
      refScaleDrag = {
        rotate: true,
        baseAngle: startAngle,
        startRot: S.refRotate || 0,
        baseX: hx,
        baseY: hy,
      };
      return;
    }
    if (Math.hypot(mx - hx, my - hy) < 20) {
      refDrag = { ox: S.refOffX, oy: S.refOffY, mx, my, s };
      return;
    }
    return;
  }

  // Freehand
  if (S.mode === "freehand") {
    const sh = getActive();
    if (!sh || sh.type !== "freehand") {
      toast("Add a Stroke layer first");
      return;
    }
    startFree(mx, my);
    return;
  }

  // Gesture tools
  if (GESTURE_TYPES.includes(S.mode)) {
    startGesture(mx, my, S.mode);
    return;
  }

  // Select mode
  if (S.mode === "select") {
    // Check multi-base drag (v8)
    if (
      multiBase &&
      S.selectedIds.size > 1 &&
      Math.hypot(mx - multiBase.x, my - multiBase.y) < 12
    ) {
      multiBaseDrag = {
        mx,
        my,
        snapshots: S.shapes
          .filter((sh) => S.selectedIds.has(sh.id))
          .map((sh) => ({
            id: sh.id,
            ox: sh.offsetX || 0,
            oy: sh.offsetY || 0,
          })),
      };
      return;
    }
    // Ctrl/Meta multi-select
    if (e.ctrlKey || e.metaKey) {
      const shId = hitTestShapes(mx, my);
      if (shId) {
        if (S.selectedIds.has(shId)) S.selectedIds.delete(shId);
        else S.selectedIds.add(shId);
        S.activeId = shId;
        calcMultiBase();
        renderLayers();
        renderProps();
        redraw();
      }
      return;
    }
    const hit = hitTestHandles(mx, my);
    if (hit) {
      drag = hit;
      if (hit.n) {
        S.selNodeId = hit.n.id;
        hlSelNode();
      }
      if (hit.t === "anchor") {
        drag.startX = hit.n.x;
        drag.startY = hit.n.y;
      }
      hideSelPopup();
      return;
    }
    const shId = hitTestShapes(mx, my);
    if (shId && shId !== S.activeId) {
      S.activeId = shId;
      S.selNodeId = null;
      S.selectedIds.clear();
      S.selectedIds.add(shId);
      multiBase = null;
      hideSelPopup();
      renderLayers();
      renderProps();
      updateCtxBar();
      redraw();
      return;
    }
    if (shId === S.activeId && S.selectedIds.has(shId)) {
      // just clicking same shape — allow re-select handles next move
      return;
    }
    // start drag selection
    S.selNodeId = null;
    hlSelNode();
    S.selectedIds.clear();
    multiBase = null;
    hideSelPopup();
    dragSel = { sx: mx, sy: my, ex: mx, ey: my };
    redraw();
    return;
  }

  // Drawing modes
  const sh = getActive();
  if (!sh || sh.type !== "path") {
    toast("Add or select a path layer");
    return;
  }
  const [lx, ly] = screenToLocal(sh, mx, my);
  const [sx, sy] = getSnapped(lx, ly, null, e.shiftKey);

  // v8: if an M node is selected, insert after it (start-point connect)
  let insertAfterIdx = -1;
  if (S.selNodeId && sh.nodes) {
    const idx = sh.nodes.findIndex((n) => n.id === S.selNodeId);
    if (idx >= 0 && sh.nodes[idx].seg === "M" && idx < sh.nodes.length - 1) {
      insertAfterIdx = idx;
    }
  }

  const seg =
    sh.nodes.length === 0
      ? "M"
      : { line: "L", quad: "Q", cubic: "C", move: "M" }[S.mode] || "L";
  const n = addNode(sh, sx, sy, seg, insertAfterIdx);
  if (n) {
    S.selNodeId = n.id;
    hPush();
    renderProps();
    redraw();
  }
});

canvas.addEventListener("mousemove", (e) => {
  const [mx, my] = getMPos(e);
  if (panDrag) {
    S.panX = panDrag.px + (mx - panDrag.sx);
    S.panY = panDrag.py + (my - panDrag.sy);
    redraw();
    return;
  }
  if (refDrag) {
    const { s } = getVP();
    S.refOffX = refDrag.ox + (mx - refDrag.mx) / refDrag.s;
    S.refOffY = refDrag.oy + (my - refDrag.my) / refDrag.s;
    if (S.snapEnabled && S.snapAxis) {
      if (Math.abs(S.refOffX) < S.snapThreshold) S.refOffX = 0;
      if (Math.abs(S.refOffY) < S.snapThreshold) S.refOffY = 0;
    }
    redraw();
    showTip(e, `ref:(${S.refOffX.toFixed(2)},${S.refOffY.toFixed(2)})`);
    return;
  }
  if (refScaleDrag) {
    if (refScaleDrag.rotate) {
      const angle = Math.atan2(
        my - refScaleDrag.baseY,
        mx - refScaleDrag.baseX,
      );
      const delta = ((angle - refScaleDrag.baseAngle) * 180) / Math.PI;
      S.refRotate = refScaleDrag.startRot + delta;
      document.getElementById("refRotate").value = Math.round(S.refRotate);
      document.getElementById("vrefRotate").textContent =
        Math.round(S.refRotate) + "°";
    } else {
      const dist = Math.hypot(mx - refScaleDrag.baseX, my - refScaleDrag.baseY);
      S.refScale = Math.max(
        0.1,
        refScaleDrag.ox * (dist / refScaleDrag.startDist),
      );
      document.getElementById("refScale").value = S.refScale.toFixed(2);
      document.getElementById("vrefScale").textContent =
        S.refScale.toFixed(1) + "×";
    }
    redraw();
    return;
  }
  if (freeDraw) {
    moveFree(mx, my);
    return;
  }
  if (gesture) {
    moveGesture(mx, my);
    return;
  }
  // multi-base drag (v8)
  if (multiBaseDrag) {
    const { s } = getVP();
    const dx = (mx - multiBaseDrag.mx) / s,
      dy = (my - multiBaseDrag.my) / s;
    for (const sd of multiBaseDrag.snapshots) {
      const sh = S.shapes.find((s) => s.id === sd.id);
      if (sh) {
        sh.offsetX = sd.ox + dx;
        sh.offsetY = sd.oy + dy;
      }
    }
    calcMultiBase();
    redraw();
    showTip(e, `Δ(${dx.toFixed(2)},${dy.toFixed(2)})`);
    return;
  }
  if (dragSel) {
    dragSel.ex = mx;
    dragSel.ey = my;
    redraw();
    return;
  }
  if (drag) {
    const sh = getActive();
    if (!sh) {
      drag = null;
      return;
    }
    const forceSnap = e.shiftKey;
    if (drag.t === "anchor") {
      const [lx, ly] = screenToLocal(sh, mx, my);
      const [sx, sy] = getSnapped(lx, ly, drag.n.id, forceSnap);
      drag.n.x = sx;
      drag.n.y = sy;
      syncNodeUI(drag.n);
      showTip(e, `(${f2(sx)},${f2(sy)})`);
    } else if (drag.t === "c1") {
      const [lx, ly] = screenToLocal(sh, mx, my);
      drag.n.cx1 = lx;
      drag.n.cy1 = ly;
      syncNodeUI(drag.n);
    } else if (drag.t === "c2") {
      const [lx, ly] = screenToLocal(sh, mx, my);
      drag.n.cx2 = lx;
      drag.n.cy2 = ly;
      syncNodeUI(drag.n);
    } else if (drag.t === "offset" || drag.t === "textPos") {
      const { cx, cy, s } = getVP();
      let ox = (mx - cx) / s,
        oy = (my - cy) / s;
      if (forceSnap) {
        ox = Math.round(ox / S.snapGridSize) * S.snapGridSize;
        oy = Math.round(oy / S.snapGridSize) * S.snapGridSize;
      }
      sh.offsetX = ox;
      sh.offsetY = oy;
      syncPropUI("offsetX", sh.offsetX);
      syncPropUI("offsetY", sh.offsetY);
    } else if (drag.t === "cc") {
      const [lx, ly] = screenToLocal(sh, mx, my);
      sh.x = lx;
      sh.y = ly;
    } else if (drag.t === "cr") {
      const [lx, ly] = screenToLocal(sh, mx, my);
      sh.radius = Math.max(0.01, Math.hypot(lx - sh.x, ly - sh.y));
      syncPropUI("radius", sh.radius);
    }
    redraw();
    return;
  }
  const hit = S.mode === "select" ? hitTestHandles(mx, my) : null;
  // cursor
  if (S.mode === "pan") canvas.style.cursor = "grab";
  else if (S.mode === "relocate") canvas.style.cursor = "crosshair";
  else if (S.mode === "connect") canvas.style.cursor = "cell";
  else if (hit) canvas.style.cursor = "grab";
  else if (S.mode !== "select") canvas.style.cursor = "crosshair";
  else canvas.style.cursor = "default";
  // Show live drag-sel count
  if (dragSel) redraw();
});

window.addEventListener("mouseup", (e) => {
  if (panDrag) {
    panDrag = null;
  }
  if (refDrag) {
    refDrag = null;
  }
  if (refScaleDrag) {
    refScaleDrag = null;
    hPush();
  }
  if (freeDraw) endFree();
  if (gesture) commitGesture();
  if (multiBaseDrag) {
    multiBaseDrag = null;
    hPush();
  }
  if (dragSel) {
    const ds = dragSel;
    dragSel = null;
    const minX = Math.min(ds.sx, ds.ex),
      maxX = Math.max(ds.sx, ds.ex);
    const minY = Math.min(ds.sy, ds.ey),
      maxY = Math.max(ds.sy, ds.ey);
    if (Math.abs(ds.ex - ds.sx) > 6 || Math.abs(ds.ey - ds.sy) > 6) {
      const found = findShapesInRect(minX, minY, maxX, maxY);
      if (found.length > 0) {
        S.selectedIds = new Set(found);
        S.activeId = found[found.length - 1];
        calcMultiBase();
        showSelPopup(minX, minY, maxX - minX, maxY - minY);
        renderLayers();
        renderProps();
      }
    }
    redraw();
    return;
  }
  if (drag) {
    drag = null;
    hPush();
    renderProps();
  }
  document.getElementById("tip").style.display = "none";
  snapState = null;
  document.getElementById("st-snap").textContent = "";
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const [mx, my] = getMPos(e);
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12,
      nz = clamp(S.zoom * f, 0.08, 10);
    const r = nz / S.zoom;
    S.panX = (S.panX - mx + canvas.width / 2) * r + mx - canvas.width / 2;
    S.panY = (S.panY - my + canvas.height / 2) * r + my - canvas.height / 2;
    setZoom(nz);
  },
  { passive: false },
);

function showTip(e, txt) {
  const t = document.getElementById("tip");
  t.style.display = "block";
  t.style.left = e.clientX + 14 + "px";
  t.style.top = e.clientY - 18 + "px";
  t.textContent = txt;
}
function hlSelNode() {
  document
    .querySelectorAll(".node-row")
    .forEach((r) => r.classList.toggle("sel", r.dataset.id === S.selNodeId));
}
function syncNodeUI(n) {
  const sn = (nid, fld, val) => {
    const el = document.querySelector(`[data-nid="${nid}"][data-fld="${fld}"]`);
    if (el) el.value = val;
  };
  sn(n.id, "nx", f2(n.x));
  sn(n.id, "ny", f2(n.y));
  sn(n.id, "c1x", f2(n.cx1));
  sn(n.id, "c1y", f2(n.cy1));
  sn(n.id, "c2x", f2(n.cx2));
  sn(n.id, "c2y", f2(n.cy2));
}
function syncPropUI(fld, val) {
  const el = document.querySelector(`[data-fld="${fld}"]`);
  if (!el) return;
  el.value = val;
  const sib = el.parentElement.querySelector(".cv");
  if (sib) sib.textContent = fmtPV(fld, val);
}
const fmtPV = (f, v) => {
  if (f === "rotationDeg") return Math.round(v) + "°";
  if (f === "repeatCount") return Math.round(v);
  if (f === "opacity") return Math.round(v * 100) + "%";
  return parseFloat(v).toFixed(2);
};

// ══════════════════════════════════════════
// RIGHT-CLICK CONTEXT MENU
// ══════════════════════════════════════════
function showCtxMenu(x, y, shId) {
  const menu = document.getElementById("ctxMenu");
  const sh = S.shapes.find((s) => s.id === shId);
  document.getElementById("cmTitle").textContent = sh
    ? sh.name
    : "Layer Options";
  const toggleMaskEl = menu.querySelector("[data-act='toggle-mask']");
  if (toggleMaskEl)
    toggleMaskEl.textContent =
      (sh && sh.isMask ? "✔ " : "") + "⬛ Toggle Mask Layer";
  const ungroupEl = menu.querySelector("[data-act='ungroup']");
  if (ungroupEl) ungroupEl.classList.toggle("disabled", !sh || !sh.groupId);
  const vw = window.innerWidth,
    vh = window.innerHeight;
  let lx = x,
    ly = y;
  menu.style.display = "block";
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight;
  if (lx + mw > vw) lx = vw - mw - 4;
  if (ly + mh > vh) ly = vh - mh - 4;
  menu.style.left = lx + "px";
  menu.style.top = ly + "px";
  menu.classList.add("show");
}
function hideCtxMenu() {
  document.getElementById("ctxMenu").style.display = "none";
  document.getElementById("ctxMenu").classList.remove("show");
}

document.getElementById("ctxMenu").addEventListener("click", (e) => {
  const item = e.target.closest("[data-act]");
  if (!item) return;
  hideCtxMenu();
  const act = item.dataset.act;
  const sh = ctxMenuTargetId
    ? S.shapes.find((s) => s.id === ctxMenuTargetId)
    : getActive();
  if (!sh && !["group-sel", "merge-shapes"].includes(act)) return;
  if (act === "flip-h") flipShape(sh, "h");
  else if (act === "flip-v") flipShape(sh, "v");
  else if (act === "toggle-mask") {
    sh.isMask = !sh.isMask;
    hPush();
    renderLayers();
    redraw();
    toast(sh.isMask ? "Set as mask" : "Mask disabled");
  } else if (act === "toggle-stroke") {
    if (!sh.stroke) sh.stroke = mkStroke();
    sh.stroke.enabled = !sh.stroke.enabled;
    hPush();
    renderProps();
    redraw();
    toast(sh.stroke.enabled ? "Stroke on" : "Stroke off");
  } else if (act === "toggle-stroke-here") {
    // v8: toggle stroke break at specific node
    if (ctxMenuNearNodeId && sh.nodes) {
      const n = sh.nodes.find((nd) => nd.id === ctxMenuNearNodeId);
      if (n && n.seg !== "M") {
        n.strokeOff = !n.strokeOff;
        hPush();
        renderProps();
        redraw();
        toast(n.strokeOff ? "Stroke break added" : "Stroke break removed");
      }
    }
  } else if (act === "add-subpath") {
    if (sh.type !== "path") {
      toast("Only path layers support subpaths");
      return;
    }
    if (!sh.nodes) sh.nodes = [];
    sh.nodes.push(nd("M", 0, 0));
    S.selNodeId = sh.nodes[sh.nodes.length - 1].id;
    hPush();
    renderProps();
    redraw();
    toast("Subpath added");
  } else if (act === "merge-shapes") mergeShapes();
  else if (act === "expand-repeats") expandRepeats(sh.id);
  else if (act === "group-sel") groupSelected();
  else if (act === "ungroup" && sh.groupId) ungroupById(sh.groupId);
  else if (act === "dup-layer") dupShape(sh.id);
  else if (act === "del-layer") delShape(sh.id);
  ctxMenuTargetId = null;
  ctxMenuNearNodeId = null;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#ctxMenu")) hideCtxMenu();
});

document.getElementById("rp-layers").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const row = e.target.closest(".lrow[data-id]");
  if (!row) return;
  ctxMenuTargetId = row.dataset.id;
  S.activeId = row.dataset.id;
  S.selNodeId = null;
  renderLayers();
  renderProps();
  showCtxMenu(e.clientX, e.clientY, row.dataset.id);
});

// ══════════════════════════════════════════
// MODES & CTX BAR
// ══════════════════════════════════════════
const MODE_LABEL = {
  select: "Select",
  pan: "Pan",
  line: "Line pt",
  quad: "Quad Curve",
  cubic: "Cubic Curve",
  move: "Subpath (M)",
  freehand: "Freehand",
  arc: "Arc",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  ref: "Move Ref",
  polygon: "Polygon",
  star: "Star",
  triangle: "Triangle",
  rrect: "Round Rect",
  spiral: "Spiral",
  relocate: "Rebase Point",
  connect: "Connect Pts",
};
const POLY_MODES = ["polygon", "star", "triangle", "rrect", "spiral"];

function setMode(m) {
  S.mode = m;
  document
    .querySelectorAll(".tbtn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  canvas.style.cursor =
    m === "pan"
      ? "grab"
      : m === "relocate" || m === "connect"
        ? "crosshair"
        : [
              "freehand",
              "rect",
              "ellipse",
              "arc",
              "polygon",
              "star",
              "triangle",
              "rrect",
              "spiral",
            ].includes(m)
          ? "crosshair"
          : m === "text"
            ? "text"
            : "default";
  const polyGrp = document.getElementById("ctx-poly-grp");
  if (polyGrp) polyGrp.style.display = POLY_MODES.includes(m) ? "flex" : "none";
  if (m !== "connect") cancelConnect();
  updateCtxBar();
  updStatus();
}
function updateCtxBar() {
  const gb = document.getElementById("gridBtn"),
    hb = document.getElementById("handlesBtn"),
    sb = document.getElementById("snapBtn");
  if (gb) gb.classList.toggle("on", S.showGrid);
  if (hb) hb.classList.toggle("on", S.showHandles);
  if (sb) sb.classList.toggle("on", S.snapEnabled);
  const lbl = document.getElementById("ctx-mode-lbl");
  if (lbl) lbl.textContent = MODE_LABEL[S.mode] || S.mode;
  const grp = document.getElementById("ctx-mode-grp");
  if (grp) {
    const sh = getActive();
    let extra = "";
    if (
      ["line", "quad", "cubic", "move"].includes(S.mode) &&
      sh &&
      sh.type === "path"
    ) {
      extra = `<span class="ctx-sep"></span><label style="display:flex;align-items:center;gap:3px;font-size:9px;color:var(--t2);cursor:pointer"><input type="checkbox" ${sh.closePath ? "checked" : ""} style="accent-color:var(--ac)" onchange="const a=getActive();if(a){a.closePath=this.checked;redraw();}"> Close path</label>`;
    }
    if (S.mode === "relocate") {
      extra = `<span class="ctx-sep"></span><span style="font-size:8px;color:#ff9d4d">Alt+click to rebase</span>`;
    }
    if (S.mode === "connect") {
      extra = `<span class="ctx-sep"></span><span style="font-size:8px;color:#8aaaff">Click two anchors</span>`;
    }
    grp.innerHTML = `<span class="ctx-label">${MODE_LABEL[S.mode] || S.mode}</span>${extra}`;
  }
}
document.getElementById("toolGrid").addEventListener("click", (e) => {
  const btn = e.target.closest(".tbtn");
  if (!btn) return;
  setMode(btn.dataset.mode);
});

// ══════════════════════════════════════════
// RIGHT PANEL TABS
// ══════════════════════════════════════════
function setRTab(tab) {
  document
    .querySelectorAll(".rtab")
    .forEach((b) => b.classList.toggle("active", b.dataset.rtab === tab));
  ["layers", "props", "export", "json"].forEach((t) =>
    document.getElementById("rp-" + t).classList.toggle("hidden", t !== tab),
  );
}
function setExportTarget(et) {
  S.exportTarget = et;
  document
    .querySelectorAll(".etab")
    .forEach((b) => b.classList.toggle("active", b.dataset.et === et));
  document.getElementById("previewLabel").textContent = {
    pixi: "PixiJS Preview",
    canvas: "Canvas 2D Preview",
    webgl: "WebGL Preview",
  }[et];
  generateExport();
  updateExportPreview();
}

// ══════════════════════════════════════════
// LAYERS PANEL  (v8: group rename)
// ══════════════════════════════════════════
const esc = (s) =>
  String(s).replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );

function renderLayerRow(sh, inGroup) {
  const a = sh.id === S.activeId,
    ms = S.selectedIds.has(sh.id);
  const cls = [
    "lrow",
    a ? "active" : "",
    ms && !a ? "sel-multi" : "",
    sh.isMask ? "is-mask" : "",
    inGroup ? "group-child" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const dotStyle = isGrad(sh.color)
    ? 'class="l-dot is-grad"'
    : `class="l-dot" style="background:${colorToHex(sh.color)}"`;
  const badge = sh.isMask ? '<span class="l-badge mask-badge">mask</span>' : "";
  const opBadge =
    sh.opacity !== undefined && sh.opacity < 1
      ? `<span style="font-size:7px;color:var(--t3);margin-left:1px">${Math.round(sh.opacity * 100)}%</span>`
      : "";
  return `<div class="${cls}" data-act="sel" data-id="${sh.id}" draggable="true">
    <span class="l-handle">⠿</span>
    <button class="ibtn" data-act="vis" data-id="${sh.id}">${sh.visible ? "👁" : "⦰"}</button>
    <span ${dotStyle}></span>
    <span class="l-name">${esc(sh.name)}</span>${badge}${opBadge}
    <span class="l-type">${sh.type}</span>
    <button class="ibtn" data-act="dup" data-id="${sh.id}">⧉</button>
    <button class="ibtn del" data-act="del" data-id="${sh.id}">✕</button>
  </div>`;
}

function renderLayers() {
  const el = document.getElementById("layerList");
  if (!S.shapes.length) {
    el.innerHTML =
      '<div class="empty-h">No layers yet.<br>Add a Path, Circle, Stroke, or Text.</div>';
    return;
  }
  const rev = [...S.shapes].reverse();
  const seenGroups = new Set();
  let html = "";
  for (const sh of rev) {
    if (sh.groupId) {
      const g = S.groups[sh.groupId];
      if (!g) continue;
      if (!seenGroups.has(sh.groupId)) {
        seenGroups.add(sh.groupId);
        html += `<div class="lrow is-group-header" data-gid="${sh.groupId}" data-act="group-hdr">
          <button class="ibtn group-toggle" data-act="toggle-group" data-gid="${sh.groupId}">${g.collapsed ? "▶" : "▼"}</button>
          <span style="font-size:11px">📁</span>
          <span class="l-name" data-rename-gid="${sh.groupId}">${esc(g.name)}</span>
          <span class="l-badge group-badge">group</span>
          <button class="ibtn" data-act="ungroup-btn" data-gid="${sh.groupId}" title="Ungroup">📂</button>
        </div>`;
      }
      if (!g.collapsed) html += renderLayerRow(sh, true);
    } else {
      html += renderLayerRow(sh, false);
    }
  }
  el.innerHTML = html;
  setupDnD();
  setupGroupRename();
}

// v8: wire up double-click rename for group headers
function setupGroupRename() {
  document.querySelectorAll("[data-rename-gid]").forEach((el) => {
    let clicks = 0,
      clickTimer = null;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      clicks++;
      if (clicks === 1) {
        clickTimer = setTimeout(() => {
          clicks = 0;
        }, 300);
      } else if (clicks >= 2) {
        clearTimeout(clickTimer);
        clicks = 0;
        startGroupRename(el.dataset.renameGid);
      }
    });
  });
}

let ddSrc = null;
function setupDnD() {
  document.querySelectorAll(".lrow[draggable]").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      if (e.target.closest("button")) {
        e.preventDefault();
        return;
      }
      ddSrc = row.dataset.id;
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      document
        .querySelectorAll(".lrow")
        .forEach((r) => r.classList.remove("dov"));
      row.classList.add("dov");
    });
    row.addEventListener("dragleave", () => row.classList.remove("dov"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      document
        .querySelectorAll(".lrow")
        .forEach((r) => r.classList.remove("dov"));
      const tid = row.dataset.id;
      if (!ddSrc || ddSrc === tid) return;
      const si = S.shapes.findIndex((s) => s.id === ddSrc),
        ti = S.shapes.findIndex((s) => s.id === tid);
      if (si < 0 || ti < 0) return;
      const [removed] = S.shapes.splice(si, 1);
      S.shapes.splice(ti, 0, removed);
      hPush();
      renderLayers();
      redraw();
    });
  });
}

document.getElementById("rp-layers").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act,
    id = el.dataset.id,
    gid = el.dataset.gid;
  if (act === "add-path") {
    addShape("path");
    return;
  }
  if (act === "add-circle") {
    addShape("circle");
    return;
  }
  if (act === "add-stroke") {
    addShape("freehand");
    return;
  }
  if (act === "add-text") {
    addShape("text");
    return;
  }
  if (act === "add-group") {
    groupSelected();
    return;
  }
  if (act === "toggle-group") {
    toggleGroupCollapse(gid);
    return;
  }
  if (act === "ungroup-btn") {
    ungroupById(gid);
    return;
  }
  if (act === "sel") {
    if (e.ctrlKey || e.metaKey) {
      if (S.selectedIds.has(id)) S.selectedIds.delete(id);
      else S.selectedIds.add(id);
      S.activeId = id;
      calcMultiBase();
    } else {
      S.activeId = id;
      S.selNodeId = null;
      S.selectedIds.clear();
      S.selectedIds.add(id);
      multiBase = null;
      hideSelPopup();
    }
    renderLayers();
    renderProps();
    updateCtxBar();
    redraw();
    return;
  }
  if (act === "vis") {
    const sh = S.shapes.find((s) => s.id === id);
    if (!sh) return;
    sh.visible = !sh.visible;
    hPush();
    renderLayers();
    redraw();
    return;
  }
  if (act === "del") {
    delShape(id);
    return;
  }
  if (act === "dup") {
    dupShape(id);
    return;
  }
});

// v8: F2 to rename group
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "F2") {
      const sh = getActive();
      if (sh && sh.groupId) {
        e.preventDefault();
        startGroupRename(sh.groupId);
      }
    }
  },
  true,
);

// ══════════════════════════════════════════
// PROPERTIES PANEL  (v8 card layout)
// ══════════════════════════════════════════
function renderGradEditor(color, fldPrefix) {
  const stops = color.stops || [
    { offset: 0, color: "#ffffff" },
    { offset: 1, color: "#5272f0" },
  ];
  let h = `<div class="grad-stops-wrap"><div style="font-size:8px;color:var(--t3);margin-bottom:3px">Gradient stops:</div>`;
  stops.forEach((s, i) => {
    h += `<div class="grad-stop-row"><input type="range" class="grad-pos-inp" min="0" max="1" step="0.01" value="${s.offset}" data-fld="${fldPrefix}GradStop${i}Pos" data-si="${i}"/><span class="cv">${(s.offset * 100).toFixed(0)}%</span><input type="color" value="${s.color}" data-fld="${fldPrefix}GradStop${i}Color" data-si="${i}"/>${i >= 2 ? `<button class="ibtn del" data-fld="${fldPrefix}GradRemStop" data-si="${i}">✕</button>` : ""}</div>`;
  });
  h += `<div class="grad-dir-row"><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="0,-1,0,1">↓</button><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="0,1,0,-1">↑</button><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="-1,0,1,0">→</button><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="1,0,-1,0">←</button><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="-1,-1,1,1">↘</button><button class="grad-dir-btn" data-fld="${fldPrefix}GradDir" data-gd="1,-1,-1,1">↙</button></div>
  <button class="hbtn" style="width:100%;justify-content:center;margin-top:3px;font-size:8px" data-fld="${fldPrefix}GradAddStop">+ Add Stop</button></div>`;
  return h;
}

function renderProps() {
  const el = document.getElementById("shapeProps");
  const sh = getActive();
  if (!sh) {
    el.innerHTML = '<div class="empty-h">Select a layer to edit.</div>';
    return;
  }
  const st = sh.stroke || mkStroke();
  const hasFill = sh.type !== "freehand";
  const colorIsGrad = isGrad(sh.color);
  const op = sh.opacity !== undefined ? sh.opacity : 1;

  // ── CARD: General ──
  let colorSection = ``;
  if (hasFill) {
    colorSection = `
    <div class="grad-row">
      <span class="cl" style="font-size:9px;color:var(--t2)">Color</span>
      <select class="grad-type-sel" data-fld="colorType"><option value="solid" ${!colorIsGrad ? "selected" : ""}>Solid</option><option value="linear" ${colorIsGrad && sh.color.type === "linear" ? "selected" : ""}>Linear</option></select>
      ${
        !colorIsGrad
          ? `<span class="colh">${sh.color || "#fff"}</span><input type="color" data-fld="color" value="${colorToHex(sh.color)}"/>`
          : `<div style="width:36px;height:13px;border-radius:2px;border:1px solid var(--bd);background:linear-gradient(to right,${(sh.color.stops || []).map((s) => s.color).join(",")})"></div>`
      }
    </div>
    ${colorIsGrad ? renderGradEditor(sh.color, "fillColor") : ""}
    <div class="togr"><span class="togl" style="font-size:9px">Fill</span><input type="checkbox" data-fld="fill" ${sh.fill !== false ? "checked" : ""}></div>`;
  }
  if (sh.type === "path")
    colorSection += `<div class="togr"><span class="togl" style="font-size:9px">Close path</span><input type="checkbox" data-fld="closePath" ${sh.closePath ? "checked" : ""}></div>`;

  let h = `<details class="prop-card" open><summary>General</summary><div class="prop-card-body">
    <div class="cr"><span class="cl">Name</span><input class="pinp" data-fld="name" value="${esc(sh.name)}"/></div>
    <div class="cr"><span class="cl">Opacity</span><input type="range" data-fld="opacity" min="0" max="1" step="0.05" value="${op}"><span class="cv">${Math.round(op * 100)}%</span></div>
    <div class="togr"><span class="togl" style="font-size:9px">Visible</span><input type="checkbox" data-fld="visible" ${sh.visible ? "checked" : ""}></div>
    <div class="togr"><span class="togl" style="font-size:9px">Is Mask</span><input type="checkbox" data-fld="isMask" ${sh.isMask ? "checked" : ""}></div>
    ${colorSection}
  </div></details>`;

  // ── CARD: Transform ──
  h += `<details class="prop-card" open><summary>Transform</summary><div class="prop-card-body">
    <div class="cr"><span class="cl">Offset X</span><input type="range" data-fld="offsetX" min="-1.5" max="1.5" step="0.01" value="${sh.offsetX}"><span class="cv">${f2(sh.offsetX)}</span></div>
    <div class="cr"><span class="cl">Offset Y</span><input type="range" data-fld="offsetY" min="-1.5" max="1.5" step="0.01" value="${sh.offsetY}"><span class="cv">${f2(sh.offsetY)}</span></div>
    <div class="cr"><span class="cl">Scale</span><input type="range" data-fld="scale" min="0.1" max="2.5" step="0.01" value="${sh.scale}"><span class="cv">${f2(sh.scale)}</span></div>
    <div class="cr"><span class="cl">Rotation</span><input type="range" data-fld="rotationDeg" min="-180" max="180" step="1" value="${sh.rotationDeg}"><span class="cv">${Math.round(sh.rotationDeg)}°</span></div>
    <div class="cr"><span class="cl">Repeat</span><input type="range" data-fld="repeatCount" min="1" max="32" step="1" value="${sh.repeatCount}"><span class="cv">${sh.repeatCount}</span></div>
    <div style="display:flex;gap:3px;margin-top:4px">
      <button class="hbtn" style="flex:1;justify-content:center;font-size:8px" onclick="flipShape(getActive(),'h')">↔ Flip H</button>
      <button class="hbtn" style="flex:1;justify-content:center;font-size:8px" onclick="flipShape(getActive(),'v')">↕ Flip V</button>
      <button class="hbtn" style="flex:1;justify-content:center;font-size:8px" onclick="setMode('relocate')">⊕ Rebase</button>
    </div>
  </div></details>`;

  // ── CARD: Shape-specific ──
  if (sh.type === "circle") {
    h += `<details class="prop-card" open><summary>Circle</summary><div class="prop-card-body">
      <div class="cr"><span class="cl">Radius</span><input type="range" data-fld="radius" min="0" max="0.8" step="0.01" value="${sh.radius}"><span class="cv">${f2(sh.radius)}</span></div>
      <div class="cr"><span class="cl">Center X</span><input type="range" data-fld="circX" min="-1.2" max="1.2" step="0.01" value="${sh.x}"><span class="cv">${f2(sh.x)}</span></div>
      <div class="cr"><span class="cl">Center Y</span><input type="range" data-fld="circY" min="-1.2" max="1.2" step="0.01" value="${sh.y}"><span class="cv">${f2(sh.y)}</span></div>
    </div></details>`;
  }
  if (sh.type === "text") {
    h += `<details class="prop-card" open><summary>Text</summary><div class="prop-card-body">
      <div class="cr"><span class="cl">Content</span><input class="pinp" data-fld="textContent" value="${esc(sh.text || "")}"/></div>
      <div class="cr"><span class="cl">Font size</span><input type="range" data-fld="fontSize" min="0.05" max="0.8" step="0.01" value="${sh.fontSize || 0.2}"><span class="cv">${f2(sh.fontSize || 0.2)}</span></div>
      <div class="cr"><span class="cl">Font</span><input class="pinp" data-fld="fontFamily" value="${esc(sh.fontFamily || "Arial")}" style="flex:1;width:auto"/></div>
      <div class="cr"><span class="cl">Weight</span><select class="selinp" data-fld="fontWeight" style="flex:1"><option value="normal" ${(sh.fontWeight || "bold") === "normal" ? "selected" : ""}>Normal</option><option value="bold" ${(sh.fontWeight || "bold") === "bold" ? "selected" : ""}>Bold</option><option value="900" ${sh.fontWeight === "900" ? "selected" : ""}>Black</option></select></div>
      <div class="cr"><span class="cl">Align</span><select class="selinp" data-fld="textAlign" style="flex:1"><option value="left" ${(sh.textAlign || "center") === "left" ? "selected" : ""}>Left</option><option value="center" ${(sh.textAlign || "center") === "center" ? "selected" : ""}>Center</option><option value="right" ${(sh.textAlign || "center") === "right" ? "selected" : ""}>Right</option></select></div>
    </div></details>`;
  }

  // ── CARD: Stroke ──
  h += `<details class="prop-card"><summary>Stroke</summary><div class="prop-card-body">
    <div class="togr"><span class="togl" style="font-size:9px">Enable</span><input type="checkbox" data-fld="strokeEnabled" ${st.enabled ? "checked" : ""}></div>
    <div class="colr"><span class="coll">Color</span><span class="colh">${st.color || "#fff"}</span><input type="color" data-fld="strokeColor" value="${st.color || "#ffffff"}"/></div>
    <div class="cr"><span class="cl">Width</span><input type="range" data-fld="strokeWidth" min="0.005" max="0.45" step="0.005" value="${st.width || 0.03}"><span class="cv">${f2(st.width || 0.03)}</span></div>
    <div class="cr"><span class="cl">Dash</span><select class="selinp" data-fld="strokeDash" style="flex:1"><option value="solid" ${!st.dash || !st.dash.length ? "selected" : ""}>Solid</option><option value="dash" ${st.dash && st.dash.length === 2 && st.dash[0] === 4 ? "selected" : ""}>Dashed</option><option value="dot" ${st.dash && st.dash.length === 2 && st.dash[0] === 1 ? "selected" : ""}>Dotted</option><option value="dashdot" ${st.dash && st.dash.length === 4 ? "selected" : ""}>Dash·dot</option></select></div>
    <div class="cr"><span class="cl">Cap/Join</span>
      <select class="selinp" data-fld="strokeCap"><option value="butt" ${st.cap === "butt" ? "selected" : ""}>Butt</option><option value="round" ${(st.cap || "round") === "round" ? "selected" : ""}>Round</option><option value="square" ${st.cap === "square" ? "selected" : ""}>Sq</option></select>
      <select class="selinp" data-fld="strokeJoin"><option value="miter" ${st.join === "miter" ? "selected" : ""}>Miter</option><option value="round" ${(st.join || "round") === "round" ? "selected" : ""}>Round</option><option value="bevel" ${st.join === "bevel" ? "selected" : ""}>Bevel</option></select>
    </div>
  </div></details>`;

  // ── CARD: Points ──
  if (sh.type === "path") {
    h += `<details class="prop-card" open><summary>Points (${sh.nodes ? sh.nodes.length : 0})<button class="ibtn" style="float:right;color:var(--acg);margin-top:-1px" onclick="addSubpathFromProps()">+ Sub</button></summary><div class="prop-card-body" style="padding:4px 5px">
      <div style="font-size:8px;color:var(--t3);margin-bottom:3px">Right-click node → Break Stroke · Drag handles</div>`;
    let subI = 0;
    (sh.nodes || []).forEach((n, i) => {
      const sel = n.id === S.selNodeId;
      if (n.seg === "M" && i > 0)
        h += `<div class="subpath-sep">— Subpath ${++subI} —</div>`;
      const segN = { M: "Move", L: "Line", Q: "Quad", C: "Cubic" };
      h += `<div class="node-row${sel ? " sel" : ""}${n.strokeOff ? " stroke-off" : ""}" data-act="sel-node" data-id="${n.id}">
        <span class="node-idx">#${i}</span>
        <select class="nsel" data-nid="${n.id}" data-fld="nseg" ${i === 0 ? "disabled" : ""}>${Object.entries(
          segN,
        )
          .map(
            ([k, v]) =>
              `<option value="${k}" ${n.seg === k ? "selected" : ""}>${v}</option>`,
          )
          .join("")}</select>
        <input class="ninp" type="number" step="0.01" data-nid="${n.id}" data-fld="nx" value="${f2(n.x)}" title="x">
        <input class="ninp" type="number" step="0.01" data-nid="${n.id}" data-fld="ny" value="${f2(n.y)}" title="y">
        <button class="node-stroke-btn${n.strokeOff ? " off" : ""}" data-act="toggle-stroke-node" data-id="${n.id}" title="${n.strokeOff ? "Join stroke" : "Break stroke"}" ${i === 0 || n.seg === "M" ? "disabled" : ""}>${n.strokeOff ? "⌁" : "–"}</button>
        <button class="ibtn del" data-act="del-node" data-id="${n.id}" ${(sh.nodes || []).length <= 1 ? "disabled" : ""}>✕</button>
      </div>`;
      if (n.seg === "Q" || n.seg === "C") {
        h += `<div class="node-sub"><span class="nsub-l" style="color:#f0c060">h1</span><input class="nsub-i" type="number" step="0.01" data-nid="${n.id}" data-fld="c1x" value="${f2(n.cx1)}"><input class="nsub-i" type="number" step="0.01" data-nid="${n.id}" data-fld="c1y" value="${f2(n.cy1)}">${n.seg === "C" ? `<span class="nsub-l" style="color:#9070ff">h2</span><input class="nsub-i" type="number" step="0.01" data-nid="${n.id}" data-fld="c2x" value="${f2(n.cx2)}"><input class="nsub-i" type="number" step="0.01" data-nid="${n.id}" data-fld="c2y" value="${f2(n.cy2)}">` : ""}</div>`;
      }
    });
    h += `</div></details>`;
  } else if (sh.type === "freehand") {
    h += `<details class="prop-card"><summary>Freehand (${sh.points ? sh.points.length : 0} pts)</summary><div class="prop-card-body"><div style="font-size:8.5px;color:var(--t3)">Select Freehand tool and draw on canvas.</div></div></details>`;
  }

  el.innerHTML = h;
}

function addSubpathFromProps() {
  const sh = getActive();
  if (!sh || sh.type !== "path") return;
  if (!sh.nodes) sh.nodes = [];
  sh.nodes.push(nd("M", 0, 0));
  S.selNodeId = sh.nodes[sh.nodes.length - 1].id;
  hPush();
  renderProps();
  redraw();
  toast("New subpath added");
}

document.getElementById("rp-props").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act,
    id = el.dataset.id;
  if (act === "sel-node") {
    S.selNodeId = id;
    hlSelNode();
    redraw();
    return;
  }
  if (act === "del-node") {
    const sh = getActive();
    if (sh) {
      delNode(sh, id);
      hPush();
      renderProps();
      redraw();
    }
    return;
  }
  if (act === "toggle-stroke-node") {
    const sh = getActive();
    if (!sh || !sh.nodes) return;
    const n = sh.nodes.find((nd) => nd.id === id);
    if (n && n.seg !== "M") {
      n.strokeOff = !n.strokeOff;
      hPush();
      renderProps();
      redraw();
    }
    return;
  }
});
document.getElementById("rp-props").addEventListener("input", onPropsInput);
document.getElementById("rp-props").addEventListener("change", onPropsInput);

function onPropsInput(e) {
  const t = e.target,
    fld = t.dataset.fld;
  if (!fld) return;
  const sh = getActive();
  if (t.dataset.nid) {
    const n = findNode(sh, t.dataset.nid);
    if (!n) return;
    if (fld === "nseg") {
      n.seg = t.value;
      hPush();
      renderProps();
      redraw();
      return;
    }
    const k = {
      nx: "x",
      ny: "y",
      c1x: "cx1",
      c1y: "cy1",
      c2x: "cx2",
      c2y: "cy2",
    }[fld];
    if (k) {
      n[k] = parseFloat(t.value) || 0;
      redraw();
    }
    return;
  }
  if (!sh) return;
  // gradient controls
  if (fld === "colorType") {
    sh.color =
      t.value === "linear" ? mkLinGrad() : colorToHex(sh.color) || "#5272f0";
    hPush();
    renderProps();
    redraw();
    return;
  }
  if (fld.startsWith("fillColorGradStop")) {
    if (!isGrad(sh.color)) return;
    const si = parseInt(t.dataset.si) || 0;
    if (!sh.color.stops[si]) return;
    if (fld.endsWith("Pos")) {
      sh.color.stops[si].offset = parseFloat(t.value) || 0;
      syncRng(t);
    } else {
      sh.color.stops[si].color = t.value;
    }
    redraw();
    return;
  }
  if (fld === "fillColorGradDir") {
    if (!isGrad(sh.color)) return;
    const [x1, y1, x2, y2] = (t.dataset.gd || "0,-1,0,1")
      .split(",")
      .map(Number);
    sh.color.x1 = x1;
    sh.color.y1 = y1;
    sh.color.x2 = x2;
    sh.color.y2 = y2;
    redraw();
    return;
  }
  if (fld === "fillColorGradAddStop") {
    if (!isGrad(sh.color)) return;
    sh.color.stops.push({ offset: 0.5, color: "#ffffff" });
    hPush();
    renderProps();
    redraw();
    return;
  }
  if (fld === "fillColorGradRemStop") {
    if (!isGrad(sh.color)) return;
    const si = parseInt(t.dataset.si) || 0;
    if (sh.color.stops.length > 2) sh.color.stops.splice(si, 1);
    hPush();
    renderProps();
    redraw();
    return;
  }
  // stroke
  if (fld.startsWith("stroke")) {
    if (!sh.stroke) sh.stroke = mkStroke();
    const st = sh.stroke;
    if (fld === "strokeEnabled") {
      st.enabled = t.checked;
      hPush();
      redraw();
    } else if (fld === "strokeColor") {
      st.color = t.value;
      t.parentElement.querySelector(".colh").textContent = t.value;
      redraw();
    } else if (fld === "strokeWidth") {
      st.width = parseFloat(t.value);
      syncRng(t);
      redraw();
    } else if (fld === "strokeDash") {
      st.dash =
        { solid: [], dash: [4, 2], dot: [1, 2], dashdot: [4, 2, 1, 2] }[
          t.value
        ] || [];
      redraw();
      hPush();
    } else if (fld === "strokeCap") {
      st.cap = t.value;
      redraw();
      hPush();
    } else if (fld === "strokeJoin") {
      st.join = t.value;
      redraw();
      hPush();
    }
    return;
  }
  if (fld === "name") {
    sh.name = t.value;
    const el2 = document.querySelector(`.lrow[data-id="${sh.id}"] .l-name`);
    if (el2) el2.textContent = sh.name;
    return;
  }
  if (fld === "color") {
    sh.color = t.value;
    t.parentElement.querySelector(".colh").textContent = t.value;
    const d = document.querySelector(`.lrow[data-id="${sh.id}"] .l-dot`);
    if (d) {
      d.style.background = t.value;
      d.classList.remove("is-grad");
    }
    redraw();
    return;
  }
  if (fld === "visible") {
    sh.visible = t.checked;
    redraw();
    return;
  }
  if (fld === "isMask") {
    sh.isMask = t.checked;
    hPush();
    renderLayers();
    redraw();
    return;
  }
  if (fld === "fill") {
    sh.fill = t.checked;
    redraw();
    return;
  }
  if (fld === "closePath") {
    sh.closePath = t.checked;
    redraw();
    return;
  }
  if (fld === "textContent") {
    sh.text = t.value;
    redraw();
    return;
  }
  if (fld === "fontFamily") {
    sh.fontFamily = t.value;
    redraw();
    return;
  }
  if (fld === "fontWeight") {
    sh.fontWeight = t.value;
    redraw();
    return;
  }
  if (fld === "textAlign") {
    sh.textAlign = t.value;
    redraw();
    return;
  }
  if (fld === "fontSize") {
    sh.fontSize = parseFloat(t.value);
    syncRng(t);
    redraw();
    return;
  }
  if (fld === "opacity") {
    sh.opacity = parseFloat(t.value);
    syncRng(t);
    redraw();
    const lb = t.parentElement.querySelector(".cv");
    if (lb) lb.textContent = Math.round(sh.opacity * 100) + "%";
    renderLayers();
    return;
  }
  const maps = {
    offsetX: "offsetX",
    offsetY: "offsetY",
    scale: "scale",
    rotationDeg: "rotationDeg",
    repeatCount: "repeatCount",
    radius: "radius",
    circX: "x",
    circY: "y",
  };
  if (maps[fld] !== undefined) {
    sh[maps[fld]] =
      fld === "repeatCount" ? parseInt(t.value) : parseFloat(t.value);
    syncRng(t);
    redraw();
  }
  if (e.type === "change") hPush();
}
function syncRng(t) {
  if (t.type !== "range") return;
  const s = t.parentElement.querySelector(".cv");
  if (s) s.textContent = fmtPV(t.dataset.fld, parseFloat(t.value));
}

// ══════════════════════════════════════════
// EXPORT CODE GENERATION
// ══════════════════════════════════════════
function fmtRot(deg) {
  const d = parseFloat(deg) || 0;
  if (d === 0) return "0";
  if (d === -90) return "-Math.PI/2";
  if (d === 90) return "Math.PI/2";
  if (Math.abs(d) === 180) return "Math.PI";
  return ((d * Math.PI) / 180).toFixed(5);
}
function hexStr(c) {
  if (!c || typeof c !== "string" || c.length < 4) return "0x000000";
  return "0x" + c.replace("#", "").toUpperCase();
}
function colorExprPixi(color) {
  if (!isGrad(color)) return hexStr(colorToHex(color));
  return hexStr(color.stops?.[0]?.color || "#ffffff");
}
function colorExprCanvas(color) {
  if (!isGrad(color)) return `"${colorToHex(color)}"`;
  if (color.type === "linear") {
    return `(() => { const _g = ctx.createLinearGradient(cx+(${f3(color.x1)})*half, cy+(${f3(color.y1)})*half, cx+(${f3(color.x2)})*half, cy+(${f3(color.y2)})*half); ${(color.stops || []).map((s) => `_g.addColorStop(${f3(s.offset)}, "${s.color}");`).join(" ")} return _g; })()`;
  }
  return `"${colorToHex(color)}"`;
}
function getMaskFor(i) {
  return i + 1 < S.shapes.length &&
    S.shapes[i + 1].isMask &&
    S.shapes[i + 1].visible
    ? S.shapes[i + 1]
    : null;
}

function genPixi() {
  const key = S.shapeKey || "PETALS.YOUR_PETAL";
  const L = [];
  L.push(`// PixiJS — Shape Editor Pro v8`);
  L.push(`[${key}]: ($: PIXI.Graphics, size: number): void => {`);
  L.push(`    const half = size / 2;`);
  L.push(
    `    const rot2d = (lx: number, ly: number, sc: number, rot: number, ox: number, oy: number): [number,number] => { const cos=Math.cos(rot),sin=Math.sin(rot); return [ox+(lx*sc*cos-ly*sc*sin)*half, oy+(lx*sc*sin+ly*sc*cos)*half]; };`,
  );
  if (!S.shapes.length) {
    L.push(`    // No layers`);
    L.push(`},`);
    return L.join("\n");
  }
  for (let i = 0; i < S.shapes.length; i++) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.isMask) continue;
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    const sc = f3(sh.scale || 1);
    const rotBase = fmtRot(sh.rotationDeg);
    L.push(
      `\n    // ${sh.name}${sh.opacity !== undefined && sh.opacity < 1 ? ` [opacity:${sh.opacity.toFixed(2)}]` : ""}`,
    );
    if (sh.opacity !== undefined && sh.opacity < 1)
      L.push(`    $.alpha = ${f3(sh.opacity)};`);
    L.push(`    for (let _i=0;_i<${reps};_i++) {`);
    L.push(
      `        const _rot=${reps > 1 ? `${rotBase}+_i*(Math.PI*2/${reps})` : rotBase};`,
    );
    L.push(
      `        const _ox=${f3(sh.offsetX || 0)}*half, _oy=${f3(sh.offsetY || 0)}*half;`,
    );
    L.push(
      `        const r=(lx:number,ly:number)=>rot2d(lx,ly,${sc},_rot,_ox,_oy);`,
    );
    if (sh.type === "path" && sh.nodes && sh.nodes.length) {
      L.push(`        $.beginPath();`);
      sh.nodes.forEach((n, idx) => {
        const lx = f3(n.x),
          ly = f3(n.y);
        if (idx === 0 || n.seg === "M")
          L.push(`        $.moveTo(...r(${lx},${ly}));`);
        else if (n.strokeOff)
          L.push(`        $.moveTo(...r(${lx},${ly})/* stroke break */;`);
        else if (n.seg === "L") L.push(`        $.lineTo(...r(${lx},${ly}));`);
        else if (n.seg === "Q")
          L.push(
            `        $.quadraticCurveTo(...r(${f3(n.cx1)},${f3(n.cy1)}),...r(${lx},${ly}));`,
          );
        else if (n.seg === "C")
          L.push(
            `        $.bezierCurveTo(...r(${f3(n.cx1)},${f3(n.cy1)}),...r(${f3(n.cx2)},${f3(n.cy2)}),...r(${lx},${ly}));`,
          );
      });
      if (sh.closePath) L.push(`        $.closePath();`);
      if (sh.fill !== false)
        L.push(`        $.fill(${colorExprPixi(sh.color)});`);
      if (sh.stroke && sh.stroke.enabled)
        L.push(
          `        $.stroke({ width:${f3(sh.stroke.width || 0.03)}*half*2, color:${hexStr(sh.stroke.color || colorToHex(sh.color))}, cap:"${sh.stroke.cap || "round"}", join:"${sh.stroke.join || "round"}" });`,
        );
    } else if (sh.type === "circle") {
      L.push(
        `        const [_cx,_cy]=r(${f3(sh.x)},${f3(sh.y)});const _r=${sc}*${f3(sh.radius)}*half;`,
      );
      L.push(`        $.beginPath(); $.arc(_cx,_cy,_r,0,Math.PI*2);`);
      if (sh.fill !== false)
        L.push(`        $.fill(${hexStr(colorToHex(sh.color))});`);
    } else if (sh.type === "freehand" && sh.points && sh.points.length > 1) {
      L.push(`        $.beginPath();`);
      sh.points.forEach(([x, y], idx) => {
        if (idx === 0) L.push(`        $.moveTo(...r(${f3(x)},${f3(y)}));`);
        else L.push(`        $.lineTo(...r(${f3(x)},${f3(y)}));`);
      });
      L.push(
        `        $.stroke({ width:${f3(sh.stroke.width || 0.04)}*half*2, color:${hexStr(sh.stroke.color || colorToHex(sh.color))}, cap:"round", join:"round" });`,
      );
    } else if (sh.type === "text") {
      L.push(`        // Text "${sh.text}" — use PIXI.Text`);
    }
    L.push(`    }`);
    if (sh.opacity !== undefined && sh.opacity < 1)
      L.push(`    $.alpha = 1; // restore`);
  }
  L.push(`},`);
  return L.join("\n");
}

function genCanvas2D() {
  const L = [];
  L.push(`// Canvas 2D — Shape Editor Pro v8`);
  L.push(
    `function drawShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {`,
  );
  L.push(`    const half = size/2;`);
  L.push(
    `    const rot2d=(lx:number,ly:number,sc:number,rot:number,ox:number,oy:number):[number,number]=>{const cos=Math.cos(rot),sin=Math.sin(rot);return[cx+ox+(lx*sc*cos-ly*sc*sin)*half,cy+oy+(lx*sc*sin+ly*sc*cos)*half];};`,
  );
  if (!S.shapes.length) {
    L.push(`    // No layers`);
    L.push(`}`);
    return L.join("\n");
  }
  for (let i = 0; i < S.shapes.length; i++) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.isMask) continue;
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    const sc = f3(sh.scale || 1),
      rotBase = fmtRot(sh.rotationDeg);
    L.push(`\n    // ${sh.name}`);
    if (sh.opacity !== undefined && sh.opacity < 1)
      L.push(`    ctx.globalAlpha=${f3(sh.opacity)};`);
    L.push(`    for(let _i=0;_i<${reps};_i++){`);
    L.push(
      `        const _rot=${reps > 1 ? `${rotBase}+_i*(Math.PI*2/${reps})` : rotBase};`,
    );
    L.push(
      `        const _ox=${f3(sh.offsetX || 0)}*half,_oy=${f3(sh.offsetY || 0)}*half;`,
    );
    L.push(
      `        const r=(lx:number,ly:number)=>rot2d(lx,ly,${sc},_rot,_ox,_oy);`,
    );
    if (sh.type === "path" && sh.nodes && sh.nodes.length) {
      L.push(`        ctx.beginPath();`);
      sh.nodes.forEach((n, idx) => {
        const lx = f3(n.x),
          ly = f3(n.y);
        if (idx === 0 || n.seg === "M" || n.strokeOff)
          L.push(`        ctx.moveTo(...r(${lx},${ly}));`);
        else if (n.seg === "L")
          L.push(`        ctx.lineTo(...r(${lx},${ly}));`);
        else if (n.seg === "Q")
          L.push(
            `        ctx.quadraticCurveTo(...r(${f3(n.cx1)},${f3(n.cy1)}),...r(${lx},${ly}));`,
          );
        else if (n.seg === "C")
          L.push(
            `        ctx.bezierCurveTo(...r(${f3(n.cx1)},${f3(n.cy1)}),...r(${f3(n.cx2)},${f3(n.cy2)}),...r(${lx},${ly}));`,
          );
      });
      if (sh.closePath) L.push(`        ctx.closePath();`);
      if (sh.fill !== false)
        L.push(
          `        ctx.fillStyle=${colorExprCanvas(sh.color)};ctx.fill();`,
        );
      if (sh.stroke && sh.stroke.enabled)
        L.push(
          `        ctx.strokeStyle="${sh.stroke.color || colorToHex(sh.color)}";ctx.lineWidth=${f3(sh.stroke.width || 0.03)}*size;ctx.lineCap="${sh.stroke.cap || "round"}";ctx.lineJoin="${sh.stroke.join || "round"}";ctx.stroke();`,
        );
    } else if (sh.type === "circle") {
      L.push(
        `        const[_cx2,_cy2]=r(${f3(sh.x)},${f3(sh.y)});ctx.beginPath();ctx.arc(_cx2,_cy2,${sc}*${f3(sh.radius)}*half,0,Math.PI*2);`,
      );
      if (sh.fill !== false)
        L.push(`        ctx.fillStyle="${colorToHex(sh.color)}";ctx.fill();`);
    } else if (sh.type === "freehand" && sh.points && sh.points.length > 1) {
      L.push(
        `        ctx.beginPath();ctx.strokeStyle="${sh.stroke.color || colorToHex(sh.color)}";ctx.lineWidth=${f3(sh.stroke.width || 0.04)}*size;ctx.lineCap="round";ctx.lineJoin="round";`,
      );
      sh.points.forEach(([x, y], idx) => {
        if (idx === 0) L.push(`        ctx.moveTo(...r(${f3(x)},${f3(y)}));`);
        else L.push(`        ctx.lineTo(...r(${f3(x)},${f3(y)}));`);
      });
      L.push(`        ctx.stroke();`);
    } else if (sh.type === "text") {
      L.push(
        `        const[_tx,_ty]=r(0,0);ctx.font="${sh.fontWeight || "bold"} "+Math.round(${f3(sh.fontSize || 0.2)}*size)+"px ${sh.fontFamily || "Arial"}";`,
      );
      L.push(
        `        ctx.fillStyle="${colorToHex(sh.color)}";ctx.textAlign="${sh.textAlign || "center"}";ctx.textBaseline="${sh.textBaseline || "middle"}";`,
      );
      if (sh.fill !== false)
        L.push(
          `        ctx.fillText("${(sh.text || "").replace(/"/g, '\\"')}",_tx,_ty);`,
        );
    }
    L.push(`    }`);
    if (sh.opacity !== undefined && sh.opacity < 1)
      L.push(`    ctx.globalAlpha=1;`);
  }
  L.push(`}`);
  return L.join("\n");
}

function genWebGL() {
  const L = [];
  L.push("// WebGL GLSL — Shape Editor Pro v8");
  L.push("precision mediump float;");
  L.push("uniform vec2 u_resolution; uniform float u_time;");
  L.push(
    "vec2 rot2d(vec2 p,float a){float c=cos(a),s=sin(a);return vec2(p.x*c-p.y*s,p.x*s+p.y*c);}",
  );
  L.push(
    "float sdSeg(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0);return length(pa-ba*h);}",
  );
  L.push("float sdCircle(vec2 p,vec2 c,float r){return length(p-c)-r;}");
  L.push("void main(){");
  L.push(
    "    vec2 uv=(gl_FragCoord.xy-u_resolution*.5)/min(u_resolution.x,u_resolution.y);",
  );
  L.push("    vec3 color=vec3(0.05,0.06,0.10); float aa=0.004;");
  function hexToRGB01(hex) {
    hex = hex.replace("#", "");
    if (hex.length === 3)
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return `${(parseInt(hex.slice(0, 2), 16) / 255).toFixed(3)},${(parseInt(hex.slice(2, 4), 16) / 255).toFixed(3)},${(parseInt(hex.slice(4, 6), 16) / 255).toFixed(3)}`;
  }
  for (const sh of S.shapes) {
    if (!sh.visible) continue;
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    const sc = parseFloat(sh.scale) || 1,
      ox = sh.offsetX || 0,
      oy = sh.offsetY || 0;
    const rgb = hexToRGB01(colorToHex(sh.color));
    const opa = sh.opacity !== undefined ? f3(sh.opacity) : "1.0";
    L.push(`    // ${sh.name}`);
    L.push(
      reps > 1
        ? `    for(int _i=0;_i<${reps};_i++){float _rot=${fmtRot(sh.rotationDeg)}+float(_i)*(6.28318/float(${reps}));`
        : `    {float _rot=${fmtRot(sh.rotationDeg)};`,
    );
    L.push(
      `        vec2 _off=vec2(${f3(ox)},${f3(oy)});float _sc=${f3(sc)};vec2 _p=rot2d((uv-_off)/_sc,-_rot);`,
    );
    if (sh.type === "circle")
      L.push(
        `        float _d=sdCircle(_p,vec2(${f3(sh.x)},${f3(sh.y)}),${f3(sh.radius)});float _m=(1.0-smoothstep(-aa,aa,_d))*${opa};color=mix(color,vec3(${rgb}),_m);`,
      );
    else if (sh.type === "path" && sh.nodes && sh.nodes.length > 1) {
      L.push(`        float _d=1e9;`);
      const ns = sh.nodes;
      for (let ni = 1; ni < ns.length; ni++) {
        const a = ns[ni - 1],
          b = ns[ni];
        L.push(
          `        _d=min(_d,sdSeg(_p,vec2(${f3(a.x)},${f3(a.y)}),vec2(${f3(b.x)},${f3(b.y)})));`,
        );
      }
      if (sh.closePath && ns.length > 2)
        L.push(
          `        _d=min(_d,sdSeg(_p,vec2(${f3(ns[ns.length - 1].x)},${f3(ns[ns.length - 1].y)}),vec2(${f3(ns[0].x)},${f3(ns[0].y)})));`,
        );
      const sw = f3(sh.stroke && sh.stroke.enabled ? sh.stroke.width : 0.05);
      L.push(
        `        float _m=(1.0-smoothstep(-aa,aa,_d-${sw}*.5))*${opa};color=mix(color,vec3(${rgb}),_m);`,
      );
    }
    L.push(`    }`);
  }
  L.push("    gl_FragColor=vec4(color,1.0);");
  L.push("}");
  return L.join("\n");
}

function generateExport() {
  const target = S.exportTarget || "pixi";
  let code = "";
  if (target === "pixi") code = genPixi();
  else if (target === "canvas") code = genCanvas2D();
  else if (target === "webgl") code = genWebGL();
  renderExportCode(code);
}
function getExportCode() {
  return (
    document.getElementById("exportOut").innerText ||
    document.getElementById("exportOut").textContent ||
    ""
  );
}
function renderExportCode(src) {
  let h = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  h = h.replace(/(\/\/.*)/g, "<span class='c'>$1</span>");
  h = h.replace(
    /\b(const|let|for|return|number|float|vec2|vec3|void|uniform|precision|mediump|int|function)\b/g,
    "<span class='k'>$1</span>",
  );
  h = h.replace(/(0x[0-9A-Fa-f]+)/g, "<span class='n'>$1</span>");
  h = h.replace(/\b(-?\d+\.\d{2,})\b/g, "<span class='n'>$1</span>");
  h = h.replace(/("(?:[^"\\]|\\.)*")/g, "<span class='s'>$1</span>");
  h = h.replace(
    /\b(Math\.\w+|rot2d|bezierCurveTo|quadraticCurveTo|lineTo|moveTo|beginFill|endFill|closePath|drawCircle|lineStyle|beginPath|fill|stroke|fillText|strokeText|arc|sdCircle|sdSeg|smoothstep|mix|length|cos|sin|dot|clamp|min|max)\b/g,
    "<span class='f'>$1</span>",
  );
  document.getElementById("exportOut").innerHTML = h;
}

function updateExportPreview() {
  const cv = document.getElementById("previewCanvas");
  if (!cv) return;
  const W = cv.width,
    H = cv.height;
  const pc = cv.getContext("2d");
  pc.clearRect(0, 0, W, H);
  pc.fillStyle = "#08080f";
  pc.fillRect(0, 0, W, H);
  if (S.exportTarget === "webgl") {
    drawWebGLPreview(pc, W, H);
    return;
  }
  const cxp = W / 2,
    cyp = H / 2,
    half = Math.min(W, H) * 0.35;
  function lts(sh, lx, ly, rep = 0) {
    const reps = Math.max(1, Math.round(sh.repeatCount || 1));
    const rot = (((sh.rotationDeg || 0) + rep * (360 / reps)) * Math.PI) / 180;
    const C = Math.cos(rot),
      SN = Math.sin(rot),
      sc = sh.scale || 1;
    const rx = lx * sc * C - ly * sc * SN,
      ry = lx * sc * SN + ly * sc * C;
    return [
      cxp + half * (rx + (sh.offsetX || 0)),
      cyp + half * (ry + (sh.offsetY || 0)),
    ];
  }
  const ltsFn = (sh, lx, ly, rep) => lts(sh, lx, ly, rep);
  for (let i = 0; i < S.shapes.length; i++) {
    const sh = S.shapes[i];
    if (!sh.visible) continue;
    if (sh.isMask) continue;
    const maskSh = getMaskFor(i);
    const reps = S.showRepeats
      ? Math.max(1, Math.round(sh.repeatCount || 1))
      : 1;
    if (maskSh) {
      pc.save();
      const cp = new Path2D();
      const mReps = Math.max(1, Math.round(maskSh.repeatCount || 1));
      if (maskSh.type === "path" && maskSh.nodes) {
        for (let r = 0; r < mReps; r++) {
          maskSh.nodes.forEach((mn, idx) => {
            const [ax, ay] = lts(maskSh, mn.x, mn.y, r);
            if (idx === 0 || mn.seg === "M") cp.moveTo(ax, ay);
            else if (mn.seg === "L") cp.lineTo(ax, ay);
            else if (mn.seg === "C") {
              const [h1x, h1y] = lts(maskSh, mn.cx1, mn.cy1, r);
              const [h2x, h2y] = lts(maskSh, mn.cx2, mn.cy2, r);
              cp.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
            }
          });
          if (maskSh.closePath) cp.closePath();
        }
      }
      pc.clip(cp);
    }
    for (let ri = 0; ri < reps; ri++) {
      pc.save();
      pc.globalAlpha = sh.opacity !== undefined ? clamp(sh.opacity, 0, 1) : 1;
      if (sh.type === "path" && sh.nodes && sh.nodes.length) {
        const p = new Path2D();
        sh.nodes.forEach((n, idx) => {
          const [ax, ay] = lts(sh, n.x, n.y, ri);
          if (idx === 0 || n.seg === "M") {
            p.moveTo(ax, ay);
            return;
          }
          if (n.seg === "L") p.lineTo(ax, ay);
          else if (n.seg === "Q") {
            const [hx, hy] = lts(sh, n.cx1, n.cy1, ri);
            p.quadraticCurveTo(hx, hy, ax, ay);
          } else if (n.seg === "C") {
            const [h1x, h1y] = lts(sh, n.cx1, n.cy1, ri);
            const [h2x, h2y] = lts(sh, n.cx2, n.cy2, ri);
            p.bezierCurveTo(h1x, h1y, h2x, h2y, ax, ay);
          }
        });
        if (sh.closePath) p.closePath();
        if (sh.fill !== false) {
          pc.fillStyle = resolveColorForCtx(sh.color, sh, ri, pc, ltsFn);
          pc.fill(p);
        }
        const st = sh.stroke;
        if (st && st.enabled) {
          pc.strokeStyle = st.color || colorToHex(sh.color);
          pc.lineWidth = Math.max(
            0.5,
            (st.width || 0.03) * half * 2 * (sh.scale || 1),
          );
          pc.lineCap = st.cap || "round";
          pc.lineJoin = st.join || "round";
          pc.stroke(p);
        }
      } else if (sh.type === "circle") {
        const [px, py] = lts(sh, sh.x, sh.y, ri);
        const rad = (sh.scale || 1) * sh.radius * half;
        pc.beginPath();
        pc.arc(px, py, Math.max(0, rad), 0, Math.PI * 2);
        if (sh.fill !== false) {
          pc.fillStyle = resolveColorForCtx(sh.color, sh, ri, pc, ltsFn);
          pc.fill();
        }
      } else if (sh.type === "text" && ri === 0) {
        const [px, py] = lts(sh, 0, 0, 0);
        const fs = (sh.fontSize || 0.2) * (sh.scale || 1) * half * 2;
        pc.font = `${sh.fontWeight || "bold"} ${Math.max(4, fs)}px ${sh.fontFamily || "Arial"}`;
        pc.fillStyle = colorToHex(sh.color);
        pc.textAlign = sh.textAlign || "center";
        pc.textBaseline = sh.textBaseline || "middle";
        if (sh.fill !== false) pc.fillText(sh.text || "", px, py);
      }
      pc.restore();
    }
    if (maskSh) pc.restore();
  }
  pc.fillStyle = "rgba(82,114,240,.6)";
  pc.font = "8px monospace";
  pc.textAlign = "left";
  pc.textBaseline = "top";
  pc.fillText(S.exportTarget === "pixi" ? "PixiJS" : "Canvas 2D", 4, 4);
}

function drawWebGLPreview(pc, W, H) {
  function hexToRGBArr(hex) {
    hex = hex.replace("#", "");
    if (hex.length === 3)
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const img = pc.createImageData(W, H);
  const d = img.data;
  for (let py2 = 0; py2 < H; py2++)
    for (let px2 = 0; px2 < W; px2++) {
      const ux = (px2 - W / 2) / Math.min(W, H),
        uy = (py2 - H / 2) / Math.min(W, H);
      let r = 13,
        g = 15,
        b = 26;
      for (const sh of S.shapes) {
        if (!sh.visible) continue;
        const reps = Math.max(1, Math.round(sh.repeatCount || 1));
        const col = hexToRGBArr(colorToHex(sh.color));
        const opa = sh.opacity !== undefined ? clamp(sh.opacity, 0, 1) : 1;
        for (let ri = 0; ri < reps; ri++) {
          const rotDeg = (sh.rotationDeg || 0) + ri * (360 / reps),
            rot = (rotDeg * Math.PI) / 180;
          const ox = sh.offsetX || 0,
            oy = sh.offsetY || 0,
            sc = sh.scale || 1;
          const cosA = Math.cos(-rot),
            sinA = Math.sin(-rot);
          const lx = ((ux - ox) * cosA - (uy - oy) * sinA) / sc,
            ly = ((ux - ox) * sinA + (uy - oy) * cosA) / sc;
          if (sh.type === "circle") {
            const dist = Math.hypot(lx - sh.x, ly - sh.y) - (sh.radius || 0.2);
            const m = Math.max(0, 1 - dist / 0.005) * opa;
            r = Math.round(r * (1 - m) + col[0] * m);
            g = Math.round(g * (1 - m) + col[1] * m);
            b = Math.round(b * (1 - m) + col[2] * m);
          } else if (sh.type === "path" && sh.nodes && sh.nodes.length > 1) {
            let minD = 1e9;
            const ns = sh.nodes;
            for (let ni = 1; ni < ns.length; ni++) {
              const ax = ns[ni - 1].x,
                ay = ns[ni - 1].y,
                bx = ns[ni].x,
                by2 = ns[ni].y;
              const pa = [lx - ax, ly - ay],
                ba = [bx - ax, by2 - ay];
              const t2 = Math.max(
                0,
                Math.min(
                  1,
                  (pa[0] * ba[0] + pa[1] * ba[1]) /
                    (ba[0] * ba[0] + ba[1] * ba[1] + 1e-9),
                ),
              );
              minD = Math.min(
                minD,
                Math.hypot(lx - ax - ba[0] * t2, ly - ay - ba[1] * t2),
              );
            }
            const sw =
              (sh.stroke && sh.stroke.enabled ? sh.stroke.width : 0.04) * 0.5;
            const m2 = Math.max(0, 1 - (minD - sw) / 0.005) * opa;
            r = Math.round(r * (1 - m2) + col[0] * m2);
            g = Math.round(g * (1 - m2) + col[1] * m2);
            b = Math.round(b * (1 - m2) + col[2] * m2);
          }
        }
      }
      const idx = (py2 * W + px2) * 4;
      d[idx] = r;
      d[idx + 1] = g;
      d[idx + 2] = b;
      d[idx + 3] = 255;
    }
  pc.putImageData(img, 0, 0);
  pc.fillStyle = "rgba(82,114,240,.6)";
  pc.font = "8px monospace";
  pc.textAlign = "left";
  pc.textBaseline = "top";
  pc.fillText("WebGL SDF", 4, 4);
}

// ══════════════════════════════════════════
// AI TRACE
// ══════════════════════════════════════════
let aiImg = null;
function loadAIImg(f) {
  if (!f || !f.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      aiImg = img;
      document.getElementById("aiDropLbl").textContent = "✓ " + f.name;
      document.getElementById("aiDrop").classList.add("has");
      document.getElementById("aiTraceBtn").disabled = false;
      document.getElementById("aiClearBtn").disabled = false;
      aiPreviewUpdate();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(f);
  document.getElementById("aiImgInp").value = "";
}
function clearAIImg() {
  aiImg = null;
  document.getElementById("aiDropLbl").textContent =
    "Drop image (no BG) or click";
  document.getElementById("aiDrop").classList.remove("has");
  document.getElementById("aiTraceBtn").disabled = true;
  document.getElementById("aiClearBtn").disabled = true;
}
function openAIModal() {
  if (!aiImg) return;
  document.getElementById("aiModal").classList.add("open");
  aiPreviewUpdate();
}
function closeAIModal() {
  document.getElementById("aiModal").classList.remove("open");
}
function aiPreviewUpdate() {
  if (!aiImg) return;
  const cv = document.getElementById("aiPreviewCanvas"),
    oc = cv.getContext("2d"),
    W = cv.width,
    H = cv.height;
  oc.clearRect(0, 0, W, H);
  for (let y = 0; y < H; y += 10)
    for (let x = 0; x < W; x += 10) {
      oc.fillStyle =
        (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0
          ? "#1a1a2a"
          : "#141422";
      oc.fillRect(x, y, 10, 10);
    }
  const sc = Math.min(W / aiImg.width, H / aiImg.height) * 0.9;
  const dw = Math.floor(aiImg.width * sc),
    dh = Math.floor(aiImg.height * sc),
    dx = Math.floor((W - dw) / 2),
    dy = Math.floor((H - dh) / 2);
  oc.drawImage(aiImg, dx, dy, dw, dh);
  const thr = parseInt(document.getElementById("alphaThr").value) || 30;
  const imgd = oc.getImageData(dx, dy, dw, dh);
  const dd = imgd.data;
  for (let i = 0; i < dd.length; i += 4) {
    if (dd[i + 3] < thr) {
      dd[i] = 255;
      dd[i + 1] = 0;
      dd[i + 2] = 80;
      dd[i + 3] = 100;
    }
  }
  oc.putImageData(imgd, dx, dy);
}
async function runAITrace() {
  if (!aiImg) return;
  const btn = document.getElementById("runTraceBtn");
  btn.disabled = true;
  setTraceProgress(0, "Preparing...");
  const SIZE = 256,
    oc = document.createElement("canvas");
  oc.width = SIZE;
  oc.height = SIZE;
  const octx = oc.getContext("2d");
  const sc = Math.min(SIZE / aiImg.width, SIZE / aiImg.height);
  const dw = Math.floor(aiImg.width * sc),
    dh = Math.floor(aiImg.height * sc),
    dx = Math.floor((SIZE - dw) / 2),
    dy = Math.floor((SIZE - dh) / 2);
  octx.clearRect(0, 0, SIZE, SIZE);
  octx.drawImage(aiImg, dx, dy, dw, dh);
  const imgd = octx.getImageData(0, 0, SIZE, SIZE);
  setTraceProgress(15, "Masking...");
  await delay(20);
  const thr = parseInt(document.getElementById("alphaThr").value) || 30;
  const smooth = parseInt(document.getElementById("smoothPasses").value) || 2;
  const tol = parseFloat(document.getElementById("simplifyTol").value) || 0.01;
  const mask = new Uint8Array(SIZE * SIZE);
  const pd = imgd.data;
  for (let i = 0; i < SIZE * SIZE; i++) mask[i] = pd[i * 4 + 3] >= thr ? 1 : 0;
  setTraceProgress(30, "Smoothing...");
  await delay(20);
  for (let p = 0; p < smooth; p++) smoothMask(mask, SIZE, SIZE);
  setTraceProgress(50, "Tracing...");
  await delay(20);
  const contours = traceContours(mask, SIZE, SIZE);
  if (!contours.length) {
    toast("No shape found! Lower threshold.");
    btn.disabled = false;
    setTraceProgress(0, "Failed.");
    return;
  }
  setTraceProgress(70, "Simplifying...");
  await delay(20);
  const normC = contours.map((c) =>
    c.map(([x, y]) => [(x / SIZE - 0.5) * 2, (y / SIZE - 0.5) * 2]),
  );
  const simpC = normC
    .map((c) => rdpSimplify(c, tol))
    .filter((c) => c.length >= 3);
  setTraceProgress(85, "Building...");
  await delay(20);
  const mode = document.getElementById("aiLayerMode").value;
  const baseNodes = simpC.flatMap((c, ci) =>
    c.map((pt, i) =>
      nd(
        i === 0 && ci === 0 ? "M" : ci > 0 && i === 0 ? "M" : "L",
        pt[0],
        pt[1],
      ),
    ),
  );
  const newShapes = [];
  if (mode === "shadow" || mode === "full")
    newShapes.push(
      mkPath(
        "Shadow",
        baseNodes.map((n) => ({ ...n, id: uid() })),
        "#0a2040",
        { scale: 1.06, offsetX: 0.02, offsetY: 0.04 },
      ),
    );
  if (mode !== "shadow")
    newShapes.push(
      mkPath(
        "Fill",
        baseNodes.map((n) => ({ ...n, id: uid() })),
        "#5ad1ff",
      ),
    );
  if (mode === "outline" || mode === "full") {
    const out = mkPath(
      "Outline",
      baseNodes.map((n) => ({ ...n, id: uid() })),
      "#80d0ff",
      { scale: 1.01 },
    );
    out.stroke.enabled = true;
    out.stroke.color = "#80d0ff";
    out.stroke.width = 0.025;
    out.fill = false;
    newShapes.push(out);
  }
  for (const sh of newShapes) S.shapes.push(sh);
  S.activeId = newShapes[newShapes.length - 1].id;
  S.selNodeId = null;
  setTraceProgress(100, "Done! " + baseNodes.length + " pts");
  hPush();
  renderLayers();
  renderProps();
  redraw();
  closeAIModal();
  toast("✨ " + newShapes.length + " layers from image!");
  btn.disabled = false;
}
function setTraceProgress(pct, msg) {
  document.getElementById("traceBarFill").style.width = pct + "%";
  document.getElementById("traceStatus").textContent = msg;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function smoothMask(mask, W, H) {
  const out = new Uint8Array(mask);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) s += mask[(y + dy) * W + (x + dx)];
      out[y * W + x] = s >= 5 ? 1 : 0;
    }
  mask.set(out);
}
function traceContours(mask, W, H) {
  const visited = new Uint8Array(W * H),
    contours = [];
  const dirs4 = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  function bpts() {
    const pts = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        let b = false;
        for (const [dx, dy] of dirs4) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || !mask[ny * W + nx]) {
            b = true;
            break;
          }
        }
        if (b) pts.push([x, y]);
      }
    return pts;
  }
  function walk(sx, sy) {
    const pts = [[sx, sy]];
    visited[sy * W + sx] = 1;
    let cx2 = sx,
      cy2 = sy;
    const nb = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
    ];
    for (let st = 0; st < W * H; st++) {
      let found = false;
      for (const [dx, dy] of nb) {
        const nx = cx2 + dx,
          ny = cy2 + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!mask[ny * W + nx] || visited[ny * W + nx]) continue;
        let b = false;
        for (const [dx2, dy2] of dirs4) {
          const nnx = nx + dx2,
            nny = ny + dy2;
          if (
            nnx < 0 ||
            nny < 0 ||
            nnx >= W ||
            nny >= H ||
            !mask[nny * W + nnx]
          ) {
            b = true;
            break;
          }
        }
        if (b) {
          visited[ny * W + nx] = 1;
          pts.push([nx, ny]);
          cx2 = nx;
          cy2 = ny;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return pts;
  }
  const bp = bpts();
  for (const [bx, by] of bp) {
    if (visited[by * W + bx]) continue;
    const c = walk(bx, by);
    if (c.length > 8) contours.push(c);
  }
  contours.sort((a, b) => b.length - a.length);
  return contours.slice(0, 1);
}
const aiDrop = document.getElementById("aiDrop");
aiDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  aiDrop.style.borderColor = "var(--ac)";
});
aiDrop.addEventListener("dragleave", () => {
  aiDrop.style.borderColor = "";
});
aiDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  aiDrop.style.borderColor = "";
  if (e.dataTransfer.files[0]) loadAIImg(e.dataTransfer.files[0]);
});
document.getElementById("aiModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeAIModal();
});

// ══════════════════════════════════════════
// REFERENCE IMAGE
// ══════════════════════════════════════════
function loadRefImg(f) {
  if (!f || !f.type.startsWith("image/")) return;
  const r = new FileReader();
  r.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      S.refImg = img;
      S.refOffX = 0;
      S.refOffY = 0;
      document.getElementById("refDropLbl").textContent = "✓ " + f.name;
      document.getElementById("refDrop").classList.add("has");
      redraw();
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(f);
  document.getElementById("refImgInp").value = "";
}
function clearRef() {
  S.refImg = null;
  document.getElementById("refDropLbl").textContent = "📁 Click or drag image";
  document.getElementById("refDrop").classList.remove("has");
  redraw();
}
const refDZ = document.getElementById("refDrop");
refDZ.addEventListener("dragover", (e) => {
  e.preventDefault();
  refDZ.style.borderColor = "var(--ac)";
});
refDZ.addEventListener("dragleave", () => {
  refDZ.style.borderColor = "";
});
refDZ.addEventListener("drop", (e) => {
  e.preventDefault();
  refDZ.style.borderColor = "";
  if (e.dataTransfer.files[0]) loadRefImg(e.dataTransfer.files[0]);
});

// ══════════════════════════════════════════
// JSON
// ══════════════════════════════════════════
function buildExport() {
  return {
    version: "5.0",
    key: S.shapeKey,
    previewSize: S.previewSize,
    shapes: S.shapes,
    groups: S.groups,
  };
}
function exportJSON() {
  const blob = new Blob([JSON.stringify(buildExport(), null, 2)], {
    type: "application/json",
  });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: (S.shapeKey || "shape").replace(/[^a-z0-9_]/gi, "_") + ".json",
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast("✓ JSON exported");
}
function generateJSONView() {
  let src = JSON.stringify(buildExport(), null, 2);
  let h = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  h = h.replace(/"([^"\\]*)":/g, '<span class="k">"$1"</span>:');
  h = h.replace(/: "([^"\\]*)"/g, ': <span class="s">"$1"</span>');
  h = h.replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>');
  h = h.replace(/: (true|false|null)/g, ': <span class="f">$1</span>');
  document.getElementById("jsonOut").innerHTML = h;
}
function copyJSON() {
  navigator.clipboard
    .writeText(document.getElementById("jsonOut").innerText || "")
    .then(() => toast("✓ JSON copied"));
}
function importJSON(inp) {
  const f = inp.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const d = JSON.parse(ev.target.result);
      if (!d.shapes || !Array.isArray(d.shapes))
        throw new Error("Invalid format");
      S.shapes = d.shapes.map((sh) => {
        if (!sh.id) sh.id = uid();
        if (sh.nodes)
          sh.nodes.forEach((n) => {
            if (!n.id) n.id = uid();
          });
        if (!sh.stroke) sh.stroke = mkStroke();
        if (sh.fill === undefined) sh.fill = sh.type !== "freehand";
        if (sh.isMask === undefined) sh.isMask = false;
        if (sh.groupId === undefined) sh.groupId = null;
        if (sh.opacity === undefined) sh.opacity = 1;
        return sh;
      });
      S.groups = d.groups || {};
      if (d.key) {
        S.shapeKey = d.key;
        document.getElementById("keyInp").value = d.key;
      }
      if (d.previewSize) {
        S.previewSize = d.previewSize;
        document.getElementById("previewSize").value = d.previewSize;
        document.getElementById("vpreviewSize").textContent = d.previewSize;
      }
      S.activeId = S.shapes.length ? S.shapes[S.shapes.length - 1].id : null;
      S.selNodeId = null;
      S.selectedIds.clear();
      hPush();
      renderLayers();
      renderProps();
      redraw();
      toast("✓ Imported " + S.shapes.length + " layers");
    } catch (err) {
      toast("✗ Invalid JSON: " + err.message);
    }
    inp.value = "";
  };
  r.readAsText(f);
}

// ══════════════════════════════════════════
// COPY / DOWNLOAD / TOAST
// ══════════════════════════════════════════
function copyExport() {
  navigator.clipboard.writeText(getExportCode()).then(() => toast("✓ Copied"));
}
function downloadExport() {
  const ext =
    { pixi: ".ts", canvas: ".ts", webgl: ".glsl" }[S.exportTarget] || ".txt";
  const slug = (S.shapeKey || "shape").replace(/[^a-z0-9_]/gi, "_");
  const blob = new Blob([getExportCode()], { type: "text/plain" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: slug + ext,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast("✓ Downloaded " + slug + ext);
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2400);
}

// ══════════════════════════════════════════
// STATUS
// ══════════════════════════════════════════
function updStatus() {
  const a = getActive();
  document.getElementById("st-layer").textContent = a ? a.name : "—";
  document.getElementById("st-mode").textContent = MODE_LABEL[S.mode] || S.mode;
  const pts =
    a && a.type === "path"
      ? a.nodes
        ? a.nodes.length
        : "—"
      : a && a.type === "freehand" && a.points
        ? a.points.length
        : "—";
  document.getElementById("st-pts").textContent = pts;
  document.getElementById("st-sel").textContent = S.selectedIds.size;
}

// ══════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.key === "Tab") {
    e.preventDefault();
    if (S.mode !== "pan") {
      S._prevMode = S.mode;
      setMode("pan");
    }
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === "z" && e.shiftKey) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "c") {
      copyExport();
      return;
    }
    if (e.key === "a") {
      e.preventDefault();
      S.selectedIds = new Set(S.shapes.map((s) => s.id));
      calcMultiBase();
      renderLayers();
      redraw();
      return;
    }
    if (e.key === "d" && S.activeId) {
      e.preventDefault();
      dupShape(S.activeId);
      return;
    }
    if (e.key === "g") {
      e.preventDefault();
      groupSelected();
      return;
    }
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && S.selNodeId) {
    const sh = getActive();
    if (sh) {
      delNode(sh, S.selNodeId);
      hPush();
      renderProps();
      redraw();
    }
    e.preventDefault();
    return;
  }
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    S.selectedIds.size > 0 &&
    !S.selNodeId
  ) {
    deleteSelected();
    return;
  }
  if (e.key === "Escape") {
    S.selNodeId = null;
    cancelConnect();
    setMode("select");
    S.selectedIds.clear();
    multiBase = null;
    hideSelPopup();
    renderProps();
    redraw();
  }
  // mode shortcuts
  const km = {
    1: "select",
    2: "line",
    3: "quad",
    4: "cubic",
    5: "move",
    6: "freehand",
    7: "arc",
    8: "rect",
    9: "ellipse",
  };
  if (km[e.key]) setMode(km[e.key]);
  if (e.key === "t" || e.key === "T") setMode("text");
  if (e.key === "h" || e.key === "H")
    setMode(S.mode === "pan" ? "select" : "pan");
  if (e.key === "r" || e.key === "R") setMode("ref");
  if (e.key === "p" || e.key === "P") setMode("polygon");
  if (e.key === "*") setMode("star");
  if (e.key === "b" || e.key === "B") setMode("relocate"); // v8 new
  if (e.key === "j" || e.key === "J") setMode("connect"); // v8 new
  if (e.key === "s" || e.key === "S") toggleSnap();
  if (e.key === "g" || e.key === "G") {
    S.showGrid = !S.showGrid;
    document.getElementById("showGrid").checked = S.showGrid;
    updateCtxBar();
    redraw();
  }
  if (e.key === "=" || e.key === "+") setZoom(S.zoom * 1.25);
  if (e.key === "-") setZoom(S.zoom / 1.25);
  if (e.key === "0") resetView();
  if (e.key === "f" || e.key === "F") {
    const sh = getActive();
    if (sh) flipShape(sh, e.shiftKey ? "v" : "h");
  }
  if (e.key === "m" || e.key === "M") mergeShapes();
  // v8: Alt shortcuts
  if (e.altKey && (e.key === "b" || e.key === "B")) {
    e.preventDefault();
    setMode("relocate");
  }
  if (e.altKey && (e.key === "j" || e.key === "J")) {
    e.preventDefault();
    setMode("connect");
  }
});

window.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key === " " &&
      !["input", "select", "textarea"].includes(
        (e.target.tagName || "").toLowerCase(),
      )
    ) {
      if (S.mode !== "pan") {
        S._prevMode = S.mode;
        setMode("pan");
      }
      e.preventDefault();
    }
  },
  { capture: true },
);
window.addEventListener("keyup", (e) => {
  if ((e.key === "Tab" || e.key === " ") && S._prevMode) {
    setMode(S._prevMode);
    delete S._prevMode;
  }
});

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
window.addEventListener("resize", resize);
resize();
setMode("select");
updateCtxBar();
hPush();
applyPreset("talisman");
console.log("v8 applied");
