/* Minimal WebGL2 renderer for the range: lit triangle meshes, an infinite
   grid baseplate and back wall, point sprites (holes, muzzle flash) and
   camera-facing tracer quads. No external libraries. */
"use strict";

const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
    return m;
  },
  trans(x, y, z) { const m = M4.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
  // Roblox CFrame components (x,y,z,r00..r22) -> column-major matrix
  fromCF(c) {
    const m = M4.ident();
    m[0] = c[3]; m[4] = c[4]; m[8] = c[5];
    m[1] = c[6]; m[5] = c[7]; m[9] = c[8];
    m[2] = c[9]; m[6] = c[10]; m[10] = c[11];
    m[12] = c[0]; m[13] = c[1]; m[14] = c[2];
    return m;
  },
  // rotation by an axis-angle vector (CFrameLib.fromAxisAngle)
  axisAngle(v) {
    const th = Math.hypot(v[0], v[1], v[2]);
    if (th < 1e-9) return M4.ident();
    const x = v[0] / th, y = v[1] / th, z = v[2] / th, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    const m = M4.ident();
    m[0] = c + x * x * C; m[4] = x * y * C - z * s; m[8] = x * z * C + y * s;
    m[1] = y * x * C + z * s; m[5] = c + y * y * C; m[9] = y * z * C - x * s;
    m[2] = z * x * C - y * s; m[6] = z * y * C + x * s; m[10] = c + z * z * C;
    return m;
  },
  rotY(a) { const m = M4.ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[8] = s; m[2] = -s; m[10] = c; return m; },
  rotX(a) { const m = M4.ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[9] = -s; m[6] = s; m[10] = c; return m; },
  scale(x, y, z) { const m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; },
  invRigid(m) {
    // inverse of a rotation+translation matrix
    const o = M4.ident();
    o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
    o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
    o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
    o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
    o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
    o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
    return o;
  },
  apply(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  },
  lookAt(eye, at) {
    // camera-to-world matrix looking from eye to at (camera looks down -Z)
    let fz = [eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]];
    const l = Math.hypot(...fz) || 1; fz = fz.map((v) => v / l);
    let rx = [fz[2], 0, -fz[0]];
    const lr = Math.hypot(...rx) || 1; rx = rx.map((v) => v / lr);
    const uy = [fz[1] * rx[2] - fz[2] * rx[1], fz[2] * rx[0] - fz[0] * rx[2], fz[0] * rx[1] - fz[1] * rx[0]];
    const m = M4.ident();
    m[0] = rx[0]; m[1] = rx[1]; m[2] = rx[2];
    m[4] = uy[0]; m[5] = uy[1]; m[6] = uy[2];
    m[8] = fz[0]; m[9] = fz[1]; m[10] = fz[2];
    m[12] = eye[0]; m[13] = eye[1]; m[14] = eye[2];
    return m;
  },
};

const LIT_VS = `#version 300 es
in vec3 aPos; in vec3 aNorm; in vec4 aCol;
uniform mat4 uProj, uView, uModel;
out vec3 vNorm; out vec4 vCol; out vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNorm = mat3(uModel) * aNorm;
  vCol = aCol;
  gl_Position = uProj * uView * w;
}`;
const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNorm; in vec4 vCol; in vec3 vWorld;
uniform vec3 uLight; uniform vec3 uEye; uniform vec3 uFog; uniform vec2 uFogRange;
uniform float uAlphaMul;
out vec4 frag;
void main() {
  vec3 n = normalize(vNorm);
  float diff = max(dot(n, uLight), 0.0);
  float rim = max(dot(n, normalize(uEye - vWorld)), 0.0);
  vec3 c = vCol.rgb * (0.4 + 0.6 * diff) + vCol.rgb * 0.08 * rim;
  float alpha = vCol.a * uAlphaMul;
  if (vCol.a < 0.0) { c = vCol.rgb * 1.5; alpha = uAlphaMul; } // neon parts glow
  float d = distance(uEye, vWorld);
  float f = clamp((d - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  frag = vec4(mix(c, uFog, f), alpha);
}`;

const GRID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uProj, uView;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const GRID_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform vec3 uEye; uniform vec3 uFog; uniform vec2 uFogRange;
uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uMajor; uniform int uAxis; // 0 ground (xz), 1 wall (xy)
out vec4 frag;
float gridLine(vec2 p, float size) {
  vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = uAxis == 0 ? vWorld.xz : vWorld.xy;
  float minor = gridLine(p, 4.0);
  float major = gridLine(p, 40.0);
  vec3 c = uBase;
  c = mix(c, uLine, minor * 0.55);
  c = mix(c, uMajor, major * 0.8);
  float d = distance(uEye, vWorld);
  float f = clamp((d - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  frag = vec4(mix(c, uFog, f), 1.0);
}`;

const PT_VS = `#version 300 es
in vec3 aPos; in vec4 aCol; in float aSize;
uniform mat4 uProj, uView; uniform float uScale;
out vec4 vCol;
void main() {
  vec4 v = uView * vec4(aPos, 1.0);
  gl_Position = uProj * v;
  gl_PointSize = clamp(aSize * uScale / max(-v.z, 0.05), 1.5, 220.0);
  vCol = aCol;
}`;
const PT_FS = `#version 300 es
precision highp float;
in vec4 vCol; uniform int uSoft;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = uSoft == 1 ? pow(1.0 - r, 1.6) : (r > 0.72 ? 0.85 : 1.0);
  vec3 c = uSoft == 1 ? vCol.rgb : (r > 0.72 ? vCol.rgb * 0.35 : vCol.rgb);
  frag = vec4(c, vCol.a * a);
}`;

const LINE_VS = `#version 300 es
in vec3 aPos; in vec4 aCol;
uniform mat4 uProj, uView;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 vCol; out vec4 frag;
void main() { frag = vCol; }`;

function hexRGB(h) {
  const n = parseInt(h || "888888", 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* -------------------------------------------------------------- geometry */
const Geo = {
  box(out, M, sx, sy, sz, col) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const faces = [
      [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]],
      [[0, 0, 1], [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]]],
      [[0, 0, -1], [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
    ];
    for (const [n, q] of faces) Geo.quad(out, M, q, n, col);
  },
  wedge(out, M, sx, sy, sz, col) {
    // Roblox WedgePart: full bottom and back (+Z) faces, slope rising towards +Z
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    Geo.quad(out, M, [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]], [0, -1, 0], col);
    Geo.quad(out, M, [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]], [0, 0, 1], col);
    const ny = sz, nz = -sy, l = Math.hypot(ny, nz);
    Geo.quad(out, M, [[-hx, -hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, -hy, -hz]], [0, ny / l, nz / l], col);
    Geo.tri(out, M, [hx, -hy, -hz], [hx, hy, hz], [hx, -hy, hz], [1, 0, 0], col);
    Geo.tri(out, M, [-hx, -hy, hz], [-hx, hy, hz], [-hx, -hy, -hz], [-1, 0, 0], col);
  },
  cylinder(out, M, len, rad1, rad2, axis, col, seg = 14) {
    // axis 0: along X (Part cylinder), 1: along Y (cylinder mesh)
    // axis 2: along Z (used for tube-shaped mesh proxies)
    const P = (a, h) => {
      const c = Math.cos(a), s = Math.sin(a);
      return axis === 0 ? [h, c * rad1, s * rad2] : axis === 1 ? [c * rad1, h, s * rad2] : [c * rad1, s * rad2, h];
    };
    const N = (a) => (axis === 0 ? [0, Math.cos(a), Math.sin(a)] : axis === 1 ? [Math.cos(a), 0, Math.sin(a)] : [Math.cos(a), Math.sin(a), 0]);
    const h = len / 2;
    const cap1 = axis === 0 ? [h, 0, 0] : axis === 1 ? [0, h, 0] : [0, 0, h];
    const cap0 = cap1.map((v) => -v);
    const n1 = axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      Geo.triN(out, M, [P(a0, -h), P(a1, -h), P(a1, h)], [N(a0), N(a1), N(a1)], col);
      Geo.triN(out, M, [P(a0, -h), P(a1, h), P(a0, h)], [N(a0), N(a1), N(a0)], col);
      Geo.tri(out, M, cap1, P(a0, h), P(a1, h), n1, col);
      Geo.tri(out, M, cap0, P(a1, -h), P(a0, -h), n1.map((v) => -v), col);
    }
  },
  sphere(out, M, sx, sy, sz, col, seg = 10) {
    for (let i = 0; i < seg; i++) for (let j = 0; j < seg * 2; j++) {
      const t0 = (i / seg) * Math.PI, t1 = ((i + 1) / seg) * Math.PI;
      const p0 = (j / (seg * 2)) * Math.PI * 2, p1 = ((j + 1) / (seg * 2)) * Math.PI * 2;
      const S = (t, p) => [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
      const pts = [S(t0, p0), S(t1, p0), S(t1, p1), S(t0, p1)];
      const c = S((t0 + t1) / 2, (p0 + p1) / 2);
      Geo.quad(out, M, pts.map((p) => [p[0] * sx / 2, p[1] * sy / 2, p[2] * sz / 2]), c, col);
    }
  },
  mesh(out, M, mesh, sx, sy, sz, col) {
    const v = mesh.v, f = mesh.f, ms = mesh.size;
    const kx = sx / (ms[0] || 1), ky = sy / (ms[1] || 1), kz = sz / (ms[2] || 1);
    for (let i = 0; i < f.length; i += 3) {
      const a = [v[f[i] * 3] * kx, v[f[i] * 3 + 1] * ky, v[f[i] * 3 + 2] * kz];
      const b = [v[f[i + 1] * 3] * kx, v[f[i + 1] * 3 + 1] * ky, v[f[i + 1] * 3 + 2] * kz];
      const c = [v[f[i + 2] * 3] * kx, v[f[i + 2] * 3 + 1] * ky, v[f[i + 2] * 3 + 2] * kz];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(...n) || 1;
      Geo.tri(out, M, a, b, c, n.map((x) => x / l), col);
    }
  },
  roundedBox(out, M, sx, sy, sz, col, e = 0.28, seg = 8) {
    // superellipsoid: a box with softened edges, smooth normals
    const a = [sx / 2, sy / 2, sz / 2];
    const sp = (v, k) => Math.sign(v) * Math.pow(Math.abs(v), k);
    const P = (t, p) => [a[0] * sp(Math.sin(t), e) * sp(Math.cos(p), e), a[1] * sp(Math.cos(t), e), a[2] * sp(Math.sin(t), e) * sp(Math.sin(p), e)];
    const Nn = (t, p) => {
      const n = [sp(Math.sin(t), 2 - e) * sp(Math.cos(p), 2 - e) / a[0], sp(Math.cos(t), 2 - e) / a[1], sp(Math.sin(t), 2 - e) * sp(Math.sin(p), 2 - e) / a[2]];
      const l = Math.hypot(...n) || 1;
      return n.map((v) => v / l);
    };
    const rows = seg, cols = seg * 2;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const t0 = (i / rows) * Math.PI, t1 = ((i + 1) / rows) * Math.PI;
      const p0 = (j / cols) * Math.PI * 2, p1 = ((j + 1) / cols) * Math.PI * 2;
      const q = [[t0, p0], [t1, p0], [t1, p1], [t0, p1]];
      const pts = q.map(([t, p]) => P(t, p)), ns = q.map(([t, p]) => Nn(t, p));
      Geo.triN(out, M, [pts[0], pts[1], pts[2]], [ns[0], ns[1], ns[2]], col);
      Geo.triN(out, M, [pts[0], pts[2], pts[3]], [ns[0], ns[2], ns[3]], col);
    }
  },
  triN(out, M, ps, ns, col) {
    for (let k = 0; k < 3; k++) {
      const n = ns[k], p = ps[k];
      const t = M4.apply(M, p);
      out.push(t[0], t[1], t[2], M[0] * n[0] + M[4] * n[1] + M[8] * n[2], M[1] * n[0] + M[5] * n[1] + M[9] * n[2], M[2] * n[0] + M[6] * n[1] + M[10] * n[2], col[0], col[1], col[2], col[3]);
    }
  },
  quad(out, M, q, n, col) { Geo.tri(out, M, q[0], q[1], q[2], n, col); Geo.tri(out, M, q[0], q[2], q[3], n, col); },
  tri(out, M, a, b, c, n, col) {
    const tn = [M[0] * n[0] + M[4] * n[1] + M[8] * n[2], M[1] * n[0] + M[5] * n[1] + M[9] * n[2], M[2] * n[0] + M[6] * n[1] + M[10] * n[2]];
    for (const p of [a, b, c]) {
      const t = M4.apply(M, p);
      out.push(t[0], t[1], t[2], tn[0], tn[1], tn[2], col[0], col[1], col[2], col[3]);
    }
  },
};

/* Build gun geometry from exported parts (main-part space).
   Roblox only lets Studio read the shape of meshes you own, so most mesh parts
   and unions arrive as bounding boxes. Those are drawn as stand-in shapes:
   tube-like boxes become cylinders, lenses become tinted discs, and the rest
   become slightly shrunk boxes with softened edges. */
function proxyShape(out, M, sx, sy, sz, col) {
  const d = [sx, sy, sz];
  const order = [0, 1, 2].sort((i, j) => d[j] - d[i]);
  const [L, Mi, S] = order.map((i) => d[i]);
  if (L >= 1.5 * Mi && Mi <= 1.35 * S && S > 0.02) {
    // tube along its longest axis (scope bodies, suppressors, barrels, rails)
    const ax = order[0];
    const r = ((Mi + S) / 2) * 0.47;
    if (ax === 0) Geo.cylinder(out, M, L, r, r, 0, col, 18);
    else if (ax === 1) Geo.cylinder(out, M, L, r, r, 1, col, 18);
    else Geo.cylinder(out, M, L, r, r, 2, col, 18);
    return;
  }
  if (S < 0.04 || S < 0.12 * L) { Geo.box(out, M, sx * 0.96, sy * 0.96, sz * 0.96, col); return; }
  Geo.roundedBox(out, M, sx * 0.94, sy * 0.94, sz * 0.94, col, 0.3, 6);
}
function lensDisc(out, M, sx, sy, sz) {
  const d = [sx, sy, sz];
  const thin = d.indexOf(Math.min(...d));
  const rest = d.filter((_, i) => i !== thin);
  const r1 = rest[0] / 2, r2 = rest[1] / 2;
  const col = [0.55, 0.75, 0.95, 0.22];
  if (thin === 0) Geo.cylinder(out, M, d[0], r1, r2, 0, col, 24);
  else if (thin === 1) Geo.cylinder(out, M, d[1], r1, r2, 1, col, 24);
  else Geo.cylinder(out, M, d[2], r1, r2, 2, col, 24);
}

function buildPartGeometry(parts, meshes) {
  const opaque = [], clear = [];
  for (const p of parts) {
    const t = p.t || 0;
    if (t >= 0.99) continue;
    const rgb = hexRGB(p.c);
    let alpha = 1 - t;
    // Roblox glass only looks see-through once the part has some transparency
    if (p.m === "Glass") alpha = t < 0.05 ? 1 : Math.min(alpha, 0.4);
    if (p.m === "ForceField") alpha = Math.min(alpha, 0.2);
    const isLens = /lens|glass/i.test(p.n || "") && (t > 0.3 || p.m === "Glass" || p.m === "Neon");
    const col = p.m === "Neon" && !isLens ? [...rgb, -1.2] : [...rgb, alpha >= 0.99 ? 1 : alpha];
    const out = alpha >= 0.99 && !isLens ? opaque : clear;
    let M = M4.fromCF(p.cf);
    let [sx, sy, sz] = p.s;
    if (isLens) { lensDisc(clear, M, sx, sy, sz); continue; }
    if (p.sm) {
      const o = p.sm.o || [0, 0, 0];
      if (o[0] || o[1] || o[2]) M = M4.mul(M, M4.trans(o[0], o[1], o[2]));
      const sc = p.sm.s || [1, 1, 1];
      if (p.sm.t === "FileMesh") { proxyShape(out, M, sx, sy, sz, col); continue; }
      sx *= sc[0]; sy *= sc[1]; sz *= sc[2];
      if (p.sm.t === "Cylinder") { Geo.cylinder(out, M, sy, sx / 2, sz / 2, 1, col); continue; }
      if (p.sm.t === "Sphere") { Geo.sphere(out, M, sx, sy, sz, col); continue; }
      if (p.sm.t === "Wedge") { Geo.wedge(out, M, sx, sy, sz, col); continue; }
    }
    if (p.bm) {
      const sc = p.bm.s || [1, 1, 1];
      sx *= sc[0]; sy *= sc[1]; sz *= sc[2];
      if (p.bm.t === "CylinderMesh") { Geo.cylinder(out, M, sy, sx / 2, sz / 2, 1, col); continue; }
    }
    if (p.k === "M" && p.mid && meshes && meshes[p.mid]) { Geo.mesh(out, M, meshes[p.mid], sx, sy, sz, col); continue; }
    if (p.k === "M" || p.k === "U") { proxyShape(out, M, sx, sy, sz, col); continue; }
    if (p.k === "W") { Geo.wedge(out, M, sx, sy, sz, col); continue; }
    if (p.k === "P" && p.sh === "Cylinder") { Geo.cylinder(out, M, sx, sy / 2, sz / 2, 0, col); continue; }
    if (p.k === "P" && p.sh === "Ball") { Geo.sphere(out, M, sx, sy, sz, col); continue; }
    Geo.box(out, M, sx, sy, sz, col);
  }
  return { opaque, clear };
}

/* -------------------------------------------------------------- renderer */
class RangeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.lit = this.program(LIT_VS, LIT_FS);
    this.grid = this.program(GRID_VS, GRID_FS);
    this.pt = this.program(PT_VS, PT_FS);
    this.line = this.program(LINE_VS, LINE_FS);
    this.meshes = {};
    this.dyn = gl.createBuffer();
    this.fog = [0.62, 0.7, 0.78];
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // exported parts don't share one winding order
  }

  program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    const a = {};
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
    return { p, u, a };
  }

  upload(name, data) {
    const gl = this.gl;
    let m = this.meshes[name];
    if (!m) { m = { buf: gl.createBuffer(), count: 0 }; this.meshes[name] = m; }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    m.count = data.length / 10;
    return m;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
    return { w, h, dpr };
  }

  begin(cam) {
    // cam: {world (camera-to-world), fovy, near, far}
    const gl = this.gl;
    const { w, h, dpr } = this.resize();
    this.w = w; this.h = h; this.dpr = dpr;
    this.proj = M4.persp(cam.fovy, w / h, cam.near || 0.05, cam.far || 20000);
    this.view = M4.invRigid(cam.world);
    this.eye = [cam.world[12], cam.world[13], cam.world[14]];
    this.camWorld = cam.world;
    gl.clearColor(...this.fog, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  drawPlane(corners, axis, base, line, major, fogRange) {
    const gl = this.gl, g = this.grid;
    gl.useProgram(g.p);
    const data = [];
    for (const i of [0, 1, 2, 0, 2, 3]) data.push(...corners[i]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(g.a.aPos);
    gl.vertexAttribPointer(g.a.aPos, 3, gl.FLOAT, false, 12, 0);
    gl.uniformMatrix4fv(g.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(g.u.uView, false, this.view);
    gl.uniform3fv(g.u.uEye, this.eye);
    gl.uniform3fv(g.u.uFog, this.fog);
    gl.uniform2fv(g.u.uFogRange, fogRange);
    gl.uniform3fv(g.u.uBase, base); gl.uniform3fv(g.u.uLine, line); gl.uniform3fv(g.u.uMajor, major);
    gl.uniform1i(g.u.uAxis, axis);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(g.a.aPos);
  }

  drawMesh(name, model, opts = {}) {
    const m = this.meshes[name];
    if (!m || !m.count) return;
    const gl = this.gl, L = this.lit;
    gl.useProgram(L.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
    const st = 40;
    gl.enableVertexAttribArray(L.a.aPos); gl.vertexAttribPointer(L.a.aPos, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(L.a.aNorm); gl.vertexAttribPointer(L.a.aNorm, 3, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(L.a.aCol); gl.vertexAttribPointer(L.a.aCol, 4, gl.FLOAT, false, st, 24);
    gl.uniformMatrix4fv(L.u.uProj, false, opts.proj || this.proj);
    gl.uniformMatrix4fv(L.u.uView, false, this.view);
    gl.uniformMatrix4fv(L.u.uModel, false, model || M4.ident());
    const ld = [-0.35, 0.85, 0.4], ll = Math.hypot(...ld);
    gl.uniform3fv(L.u.uLight, ld.map((v) => v / ll));
    gl.uniform3fv(L.u.uEye, this.eye);
    gl.uniform3fv(L.u.uFog, this.fog);
    gl.uniform2fv(L.u.uFogRange, opts.fogRange || [400, 6000]);
    const ghost = opts.alpha != null && opts.alpha < 0.999;
    gl.uniform1f(L.u.uAlphaMul, ghost ? opts.alpha : 1);
    if (ghost && !opts.blend) {
      // see-through gun: depth pre-pass so only the front-most surface shows
      gl.colorMask(false, false, false, false);
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
      gl.colorMask(true, true, true, true);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
      gl.disable(gl.BLEND); gl.depthMask(true); gl.depthFunc(gl.LESS);
    } else {
      if (opts.blend) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      }
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
      if (opts.blend) { gl.disable(gl.BLEND); gl.depthMask(true); }
    }
    gl.disableVertexAttribArray(L.a.aPos); gl.disableVertexAttribArray(L.a.aNorm); gl.disableVertexAttribArray(L.a.aCol);
  }

  drawPoints(points, soft, additive) {
    // points: [[x,y,z, r,g,b,a, size], ...]
    if (!points.length) return;
    const gl = this.gl, P = this.pt;
    gl.useProgram(P.p);
    const data = new Float32Array(points.length * 8);
    points.forEach((p, i) => data.set(p, i * 8));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(P.a.aPos); gl.vertexAttribPointer(P.a.aPos, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(P.a.aCol); gl.vertexAttribPointer(P.a.aCol, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(P.a.aSize); gl.vertexAttribPointer(P.a.aSize, 1, gl.FLOAT, false, 32, 28);
    gl.uniformMatrix4fv(P.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(P.u.uView, false, this.view);
    gl.uniform1f(P.u.uScale, this.proj[5] * this.h / 2);
    gl.uniform1i(P.u.uSoft, soft ? 1 : 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.POINTS, 0, points.length);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(P.a.aPos); gl.disableVertexAttribArray(P.a.aCol); gl.disableVertexAttribArray(P.a.aSize);
  }

  drawRibbons(segs) {
    // segs: [[a(xyz), b(xyz), width, r,g,b,a]] drawn as camera-facing quads
    if (!segs.length) return;
    const gl = this.gl, L = this.line;
    const data = [];
    for (const [a, b, wdt, r, g, bl, al] of segs) {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e = [this.eye[0] - a[0], this.eye[1] - a[1], this.eye[2] - a[2]];
      let s = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]];
      const l = Math.hypot(...s) || 1; s = s.map((v) => (v / l) * wdt / 2);
      const p = [[a[0] - s[0], a[1] - s[1], a[2] - s[2]], [a[0] + s[0], a[1] + s[1], a[2] + s[2]], [b[0] + s[0], b[1] + s[1], b[2] + s[2]], [b[0] - s[0], b[1] - s[1], b[2] - s[2]]];
      for (const i of [0, 1, 2, 0, 2, 3]) data.push(...p[i], r, g, bl, i === 0 || i === 1 ? al * 0.15 : al);
    }
    gl.useProgram(L.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(L.a.aPos); gl.vertexAttribPointer(L.a.aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(L.a.aCol); gl.vertexAttribPointer(L.a.aCol, 4, gl.FLOAT, false, 28, 12);
    gl.uniformMatrix4fv(L.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(L.u.uView, false, this.view);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 7);
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(L.a.aPos); gl.disableVertexAttribArray(L.a.aCol);
  }

  clearDepth() { this.gl.clear(this.gl.DEPTH_BUFFER_BIT); }

  // world point -> CSS pixel position (or null when behind the camera)
  project(p) {
    const v = M4.apply(this.view, p);
    if (v[2] > -0.05) return null;
    const x = (this.proj[0] * v[0]) / -v[2], y = (this.proj[5] * v[1]) / -v[2];
    return [((x + 1) / 2) * this.w / this.dpr, ((1 - y) / 2) * this.h / this.dpr];
  }
}

window.M4 = M4;
window.Geo = Geo;
window.RangeRenderer = RangeRenderer;
window.buildPartGeometry = buildPartGeometry;
