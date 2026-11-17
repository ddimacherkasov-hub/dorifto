import * as THREE from 'three';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const store = {
  get(k, d) { try { const v = localStorage.getItem('dorifto_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dorifto_' + k, JSON.stringify(v)); } catch {} },
};
function fmtTime(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xf2b27a);
scene.background = SKY;
scene.fog = new THREE.Fog(0xe9b48a, 120, 520);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1500);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.HemisphereLight(0xffe2c4, 0x4a5a3a, 1.1));
const sun = new THREE.DirectionalLight(0xffd2a0, 2.2);
sun.position.set(60, 90, -40);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = -35; sc.right = 35; sc.top = 35; sc.bottom = -35; sc.near = 1; sc.far = 250;
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// sky dome with gradient
{
  const g = new THREE.SphereGeometry(900, 24, 12);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x3d6fb0) }, mid: { value: new THREE.Color(0xf6b07a) }, bot: { value: new THREE.Color(0xe9b48a) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.45, h)) : bot; gl_FragColor = vec4(c, 1.0); }',
  });
  const sky = new THREE.Mesh(g, m);
  sky.renderOrder = -1;
  scene.add(sky);
  scene.userData.sky = sky;
}

// ---------- procedural textures ----------
function noiseTexture(size, base, spread, repeat, extra) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const img = x.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * spread;
    img.data[i * 4] = clamp(base[0] + n, 0, 255);
    img.data[i * 4 + 1] = clamp(base[1] + n, 0, 255);
    img.data[i * 4 + 2] = clamp(base[2] + n, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  if (extra) extra(x, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------- ground ----------
const grassTex = noiseTexture(256, [86, 120, 62], 34, 120, (x, s) => {
  for (let i = 0; i < 60; i++) {
    x.fillStyle = `rgba(${60 + Math.random() * 40},${90 + Math.random() * 40},40,0.25)`;
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, 6 + Math.random() * 20, 0, 7); x.fill();
  }
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ map: grassTex }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- track ----------
const ROAD_W = 16;
const CURB_W = 1.4;
const ctrl = [
  [0, -130], [80, -135], [145, -100], [160, -30], [120, 15], [65, 5], [30, 40], [45, 100],
  [115, 118], [155, 165], [110, 215], [10, 210], [-55, 170], [-65, 100], [-125, 70], [-155, -5],
  [-120, -85], [-65, -120],
].map(([x, z]) => new THREE.Vector3(x, 0, z));
const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
const N = 1200;
const P = curve.getSpacedPoints(N); // P[N] == P[0]
P.pop();
const TAN = [], NOR = [];
for (let i = 0; i < N; i++) {
  const a = P[(i - 1 + N) % N], b = P[(i + 1) % N];
  const t = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
  TAN.push(t);
  NOR.push(new THREE.Vector3(t.z, 0, -t.x)); // left of travel direction
}
const SEG = curve.getLength() / N;

function ribbon(inner, outer, y, colorFn, uvScaleV) {
  const pos = [], col = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const k = i % N, p = P[k], n = NOR[k];
    pos.push(p.x + n.x * inner, y, p.z + n.z * inner, p.x + n.x * outer, y, p.z + n.z * outer);
    const v = (i * SEG) / (uvScaleV || 1);
    uv.push(0, v, 1, v);
    if (colorFn) { const c = colorFn(i); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colorFn) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point up regardless of winding
  const nA = g.attributes.normal;
  for (let i = 0; i < nA.count; i++) nA.setXYZ(i, 0, 1, 0);
  return g;
}

const asphaltTex = noiseTexture(256, [70, 70, 74], 26, 1, (x, s) => {
  for (let i = 0; i < 400; i++) {
    const v = 40 + Math.random() * 60;
    x.fillStyle = `rgba(${v},${v},${v + 4},0.5)`;
    x.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
  // centre dashes
  x.fillStyle = 'rgba(235,235,225,0.85)';
  x.fillRect(s / 2 - 2, 0, 4, s * 0.45);
  // edge lines
  x.fillRect(6, 0, 4, s);
  x.fillRect(s - 10, 0, 4, s);
});
asphaltTex.repeat.set(1, 1);
const road = new THREE.Mesh(
  ribbon(-ROAD_W / 2, ROAD_W / 2, 0.03, null, 10),
  new THREE.MeshLambertMaterial({ map: asphaltTex })
);
road.receiveShadow = true;
scene.add(road);

// curbs (red/white stripes)
const red = new THREE.Color(0xd8302a), white = new THREE.Color(0xf2f2f2);
const stripe = (i) => (Math.floor(i / 2) % 2 ? red : white);
const curbMat = new THREE.MeshLambertMaterial({ vertexColors: true });
for (const s of [1, -1]) {
  const m = new THREE.Mesh(ribbon(s * ROAD_W / 2, s * (ROAD_W / 2 + CURB_W), 0.06, stripe), curbMat);
  m.receiveShadow = true;
  scene.add(m);
}
// dirt run-off strip
const dirtTex = noiseTexture(128, [150, 120, 84], 30, 1);
for (const s of [1, -1]) {
  const m = new THREE.Mesh(
    ribbon(s * (ROAD_W / 2 + CURB_W), s * (ROAD_W / 2 + CURB_W + 4), 0.02, null, 6),
    new THREE.MeshLambertMaterial({ map: dirtTex })
  );
  m.receiveShadow = true;
  scene.add(m);
}

// start/finish line
{
  const c = document.createElement('canvas'); c.width = 128; c.height = 16;
  const x = c.getContext('2d');
  for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * 8, j * 8, 8, 8); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 2), new THREE.MeshLambertMaterial({ map: t }));
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = Math.atan2(TAN[0].x, TAN[0].z);
  line.position.set(P[0].x, 0.05, P[0].z);
  scene.add(line);
  // gantry
  const postMat = new THREE.MeshLambertMaterial({ color: 0x333842 });
  const bannerMat = new THREE.MeshLambertMaterial({ color: 0xff6b3d });
  const gantry = new THREE.Group();
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), postMat);
    post.position.set(s * (ROAD_W / 2 + 2), 3.5, 0); post.castShadow = true; gantry.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W + 4.5, 1.4, 0.3), bannerMat);
  banner.position.y = 6.6; banner.castShadow = true; gantry.add(banner);
  gantry.position.copy(P[0]);
  gantry.rotation.y = Math.atan2(TAN[0].x, TAN[0].z);
  scene.add(gantry);
}

// tyre walls on outside of sharp corners + trees
function distToTrack(x, z) {
  let best = Infinity;
  for (let i = 0; i < N; i += 3) {
    const dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
{
  const trunkG = new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6);
  const leafG = new THREE.ConeGeometry(2.2, 5.5, 7);
  const trunkM = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
  const leafM = new THREE.MeshLambertMaterial({ color: 0x3f6e3a });
  const COUNT = 320;
  const trunks = new THREE.InstancedMesh(trunkG, trunkM, COUNT);
  const leaves = new THREE.InstancedMesh(leafG, leafM, COUNT);
  trunks.castShadow = leaves.castShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc3 = new THREE.Vector3(), p3 = new THREE.Vector3();
  const col = new THREE.Color();
  let n = 0, tries = 0;
  while (n < COUNT && tries < 6000) {
    tries++;
    const x = (Math.random() - 0.5) * 760, z = 40 + (Math.random() - 0.5) * 760;
    const d = distToTrack(x, z);
    if (d < ROAD_W / 2 + 14) continue;
    const s = 0.7 + Math.random() * 0.8;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28);
    m4.compose(p3.set(x, 1.2 * s, z), q, sc3.set(s, s, s)); trunks.setMatrixAt(n, m4);
    m4.compose(p3.set(x, (2.4 + 2.5) * s, z), q, sc3.set(s, s, s)); leaves.setMatrixAt(n, m4);
    leaves.setColorAt(n, col.setHSL(0.27 + Math.random() * 0.08, 0.38, 0.26 + Math.random() * 0.1));
    n++;
  }
  trunks.count = leaves.count = n;
  scene.add(trunks, leaves);

  // tyre stacks along outside of curves
  const tyreG = new THREE.TorusGeometry(0.45, 0.22, 6, 10);
  tyreG.rotateX(Math.PI / 2);
  const tyreM = new THREE.MeshLambertMaterial({ color: 0x1e1f22 });
  const tyres = [];
  for (let i = 0; i < N; i += 6) {
    const a = TAN[(i - 6 + N) % N], b = TAN[(i + 6) % N];
    const turn = a.x * b.z - a.z * b.x; // sign = direction of turn
    if (Math.abs(turn) < 0.06) continue;
    const side = turn > 0 ? 1 : -1; // outside of the corner
    const off = side * (ROAD_W / 2 + CURB_W + 6);
    tyres.push([P[i].x + NOR[i].x * off, P[i].z + NOR[i].z * off]);
  }
  const tm = new THREE.InstancedMesh(tyreG, tyreM, tyres.length * 3);
  tm.castShadow = true;
  let k = 0;
  for (const [x, z] of tyres) for (let h = 0; h < 3; h++) { m4.makeTranslation(x, 0.22 + h * 0.44, z); tm.setMatrixAt(k++, m4); }
  scene.add(tm);
  scene.userData.tyrePts = tyres;
}

// distant hills
{
  const hm = new THREE.MeshLambertMaterial({ color: 0x8a7a6a });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
    const r = 560 + Math.random() * 120;
    const h = 40 + Math.random() * 80;
    const m = new THREE.Mesh(new THREE.ConeGeometry(70 + Math.random() * 60, h, 6), hm);
    m.position.set(Math.cos(a) * r, h / 2 - 4, 40 + Math.sin(a) * r);
    scene.add(m);
  }
}

// ---------- car ----------
const CAR_COLORS = [0xff6b3d, 0x3d9bff, 0xffd23f, 0x3ddc97, 0xf2f2f2, 0x222428];
let carColor = store.get('color', 0);
const carPaint = new THREE.MeshStandardMaterial({ color: CAR_COLORS[carColor], roughness: 0.35, metalness: 0.4 });
const car = new THREE.Group();
const body = new THREE.Group();
car.add(body);
{
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.1, metalness: 0.6 });
  const add = (g, m, x, y, z) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; body.add(o); return o; };
  add(new THREE.BoxGeometry(1.86, 0.5, 4.3), carPaint, 0, 0.6, 0);
  add(new THREE.BoxGeometry(1.9, 0.18, 4.36), dark, 0, 0.38, 0);           // skirts
  add(new THREE.BoxGeometry(1.56, 0.48, 2.0), glass, 0, 1.08, -0.25);       // cabin glass
  add(new THREE.BoxGeometry(1.6, 0.08, 1.7), carPaint, 0, 1.34, -0.3);      // roof
  add(new THREE.BoxGeometry(1.8, 0.08, 0.5), dark, 0, 1.15, -2.05);         // spoiler wing
  add(new THREE.BoxGeometry(0.08, 0.3, 0.3), dark, 0.7, 0.98, -2.0);
  add(new THREE.BoxGeometry(0.08, 0.3, 0.3), dark, -0.7, 0.98, -2.0);
  add(new THREE.BoxGeometry(1.0, 0.06, 1.2), dark, 0, 0.86, 1.2);           // bonnet vent
  const hl = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d0, emissiveIntensity: 1.2 });
  const tl = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.6 });
  add(new THREE.BoxGeometry(0.42, 0.14, 0.05), hl, 0.62, 0.68, 2.16);
  add(new THREE.BoxGeometry(0.42, 0.14, 0.05), hl, -0.62, 0.68, 2.16);
  car.userData.tail = [add(new THREE.BoxGeometry(0.5, 0.14, 0.05), tl, 0.6, 0.7, -2.16), add(new THREE.BoxGeometry(0.5, 0.14, 0.05), tl, -0.6, 0.7, -2.16)];
  car.userData.tailMat = tl;
}
const wheels = [];
{
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xc0c4cc, roughness: 0.3, metalness: 0.8 });
  const wg = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 16); wg.rotateZ(Math.PI / 2);
  const rg = new THREE.CylinderGeometry(0.22, 0.22, 0.3, 8); rg.rotateZ(Math.PI / 2);
  for (const [x, z, front] of [[0.86, 1.35, 1], [-0.86, 1.35, 1], [0.86, -1.35, 0], [-0.86, -1.35, 0]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.36, z);
    const spin = new THREE.Group();
    const t = new THREE.Mesh(wg, tyre); t.castShadow = true;
    const r = new THREE.Mesh(rg, rim);
    spin.add(t, r);
    pivot.add(spin);
    car.add(pivot);
    wheels.push({ pivot, spin, front: !!front, x, z });
  }
}
// blob shadow fallback for nicer contact
{
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 4, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.07;
  car.add(blob);
}
scene.add(car);

// ---------- skid marks ----------
const SKID_MAX = 4000;
const skidPos = new Float32Array(SKID_MAX * 6 * 3);
const skidGeo = new THREE.BufferGeometry();
const skidAttr = new THREE.BufferAttribute(skidPos, 3);
skidAttr.setUsage(THREE.DynamicDrawUsage);
skidGeo.setAttribute('position', skidAttr);
const skidMesh = new THREE.Mesh(skidGeo, new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
skidMesh.frustumCulled = false;
scene.add(skidMesh);
let skidHead = 0, skidUsed = 0;
const lastMark = [null, null];
function addSkid(i, x, z, dirX, dirZ) {
  const w = 0.14;
  const px = -dirZ * w, pz = dirX * w;
  const prev = lastMark[i];
  lastMark[i] = { x, z, px, pz };
  if (!prev) return;
  const o = skidHead * 18, y = 0.075;
  const v = [
    prev.x + prev.px, y, prev.z + prev.pz, prev.x - prev.px, y, prev.z - prev.pz, x + px, y, z + pz,
    prev.x - prev.px, y, prev.z - prev.pz, x - px, y, z - pz, x + px, y, z + pz,
  ];
  skidPos.set(v, o);
  skidAttr.addUpdateRange(o, 18);
  skidAttr.needsUpdate = true;
  skidHead = (skidHead + 1) % SKID_MAX;
  skidUsed = Math.min(SKID_MAX, skidUsed + 1);
  skidGeo.setDrawRange(0, skidUsed * 6);
}

// ---------- smoke ----------
const smokeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(235,235,235,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const smoke = [];
for (let i = 0; i < 70; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0, color: 0xdddddd }));
  s.visible = false;
  scene.add(s);
  smoke.push({ s, life: 0, max: 1, vx: 0, vz: 0 });
}
let smokeIdx = 0;
function puff(x, z, vx, vz, amount, dusty) {
  const p = smoke[smokeIdx]; smokeIdx = (smokeIdx + 1) % smoke.length;
  p.life = 0; p.max = 0.9 + Math.random() * 0.8;
  p.vx = vx * 0.25 + (Math.random() - 0.5) * 1.5; p.vz = vz * 0.25 + (Math.random() - 0.5) * 1.5;
  p.s.position.set(x, 0.4, z);
  p.s.material.color.set(dusty ? 0xb89a72 : 0xe6e6e6);
  p.peak = clamp(amount, 0.15, 0.6);
  p.s.visible = true;
}
function updateSmoke(dt) {
  for (const p of smoke) {
    if (!p.s.visible) continue;
    p.life += dt;
    const t = p.life / p.max;
    if (t >= 1) { p.s.visible = false; continue; }
    p.s.position.x += p.vx * dt; p.s.position.z += p.vz * dt; p.s.position.y += 0.9 * dt;
    const sz = 1.2 + t * 4.5;
    p.s.scale.set(sz, sz, sz);
    p.s.material.opacity = p.peak * (1 - t) * Math.min(1, t * 6);
  }
}

// ---------- input ----------
const input = { left: false, right: false, gas: false, brake: false, hand: false };
const keyMap = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake', Space: 'hand' };
window.addEventListener('keydown', (e) => { if (keyMap[e.code]) { input[keyMap[e.code]] = true; e.preventDefault(); } if (e.code === 'KeyR') resetCar(); if (e.code === 'KeyC') switchCam(); if (e.code === 'Escape' || e.code === 'KeyP') togglePause(); });
window.addEventListener('keyup', (e) => { if (keyMap[e.code]) input[keyMap[e.code]] = false; });
function bindBtn(id, key) {
  const el = $(id);
  const on = (e) => { e.preventDefault(); input[key] = true; el.classList.add('on'); try { el.setPointerCapture(e.pointerId); } catch {} if (navigator.vibrate && key === 'hand') navigator.vibrate(12); };
  const off = (e) => { e.preventDefault(); input[key] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('lostpointercapture', off);
}
bindBtn('bL', 'left'); bindBtn('bR', 'right'); bindBtn('bGas', 'gas'); bindBtn('bBrake', 'brake'); bindBtn('bHand', 'hand');
window.addEventListener('contextmenu', (e) => e.preventDefault());

// analog steering: 0 = buttons, 1 = slide pad, 2 = tilt
let steerMode = store.get('steerMode', 1);
input.analog = null;
const MODES = ['Кнопки', 'Свайп', 'Нахил'];
{
  const pad = $('pad'), knob = $('padKnob');
  let pid = null, x0 = 0;
  const RANGE = 95; // px of finger travel for full lock
  const setKnob = (v) => { knob.style.left = (50 + v * 50) + '%'; };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); pid = e.pointerId; x0 = e.clientX; input.analog = 0; setKnob(0);
    try { pad.setPointerCapture(pid); } catch {}
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    let v = clamp((e.clientX - x0) / RANGE, -1, 1);
    // let the anchor follow if the finger goes past full lock, so coming back responds at once
    if (Math.abs(e.clientX - x0) > RANGE) x0 = e.clientX - Math.sign(v) * RANGE;
    input.analog = v; setKnob(v);
  });
  const up = (e) => { if (e.pointerId !== pid) return; pid = null; input.analog = 0; setKnob(0); };
  pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up); pad.addEventListener('lostpointercapture', up);
  input._setKnob = setKnob;
}
window.addEventListener('devicemotion', (e) => {
  if (steerMode !== 2) return;
  const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
  const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
  const right = g.x * Math.cos(ang) - g.y * Math.sin(ang);
  const up = g.x * Math.sin(ang) + g.y * Math.cos(ang);
  let wheel = Math.atan2(-right, Math.abs(up) + 0.5);  // like turning a steering wheel
  const DEAD = 0.04, FULL = 0.42;                     // full lock at ~24° of tilt
  wheel = Math.sign(wheel) * Math.max(0, Math.abs(wheel) - DEAD) / (FULL - DEAD);
  input.analog = clamp(wheel, -1, 1);
  if (input._setKnob) input._setKnob(input.analog);
});
function applySteerMode() {
  const btns = steerMode === 0;
  $('bL').classList.toggle('hidden', !btns);
  $('bR').classList.toggle('hidden', !btns);
  $('pad').classList.toggle('hidden', btns);
  $('pad').style.pointerEvents = steerMode === 1 ? 'auto' : 'none';
  $('padHint').textContent = steerMode === 1 ? 'тягни пальцем вліво / вправо' : 'нахиляй телефон як кермо';
  input.analog = btns ? null : 0;
  if (input._setKnob) input._setKnob(0);
}
applySteerMode();

// ---------- audio ----------
let audio = null;
function initAudio() {
  if (audio) { audio.ctx.resume(); return; }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    // engine
    const eg = ctx.createGain(); eg.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 2;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(eg); eg.connect(master);
    o1.start(); o2.start();
    // screech
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 4;
    const sg = ctx.createGain(); sg.gain.value = 0;
    noise.connect(bp); bp.connect(sg); sg.connect(master); noise.start();
    audio = { ctx, eg, o1, o2, lp, sg, bp, master };
  } catch { audio = null; }
}
function updateAudio(rpm, gas, screech, paused) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  const f = 55 + rpm * 120;
  audio.o1.frequency.setTargetAtTime(f, t, 0.05);
  audio.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
  audio.lp.frequency.setTargetAtTime(500 + rpm * 900 + (gas ? 500 : 0), t, 0.08);
  audio.eg.gain.setTargetAtTime(paused ? 0 : 0.05 + (gas ? 0.07 : 0.02) + rpm * 0.03, t, 0.08);
  audio.sg.gain.setTargetAtTime(paused ? 0 : screech * 0.13, t, 0.06);
  audio.bp.frequency.setTargetAtTime(1500 + screech * 600, t, 0.1);
}

// ---------- car state & physics ----------
const S = {
  x: 0, z: 0, yaw: 0, vx: 0, vz: 0, av: 0, steer: 0,
  drifting: false, driftDir: 1, flick: 0, prevVh: 0, slip: 0, speed: 0, offroad: false,
  idx: 0, wheelRot: 0, roll: 0, pitch: 0,
};
function nearestIdx(x, z, around) {
  let best = Infinity, bi = 0;
  const scan = (i) => { const k = (i + N) % N, dx = P[k].x - x, dz = P[k].z - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } };
  if (around == null) for (let i = 0; i < N; i++) scan(i);
  else for (let i = around - 60; i <= around + 60; i++) scan(i);
  return { i: bi, d: Math.sqrt(best) };
}
function placeAt(i) {
  S.x = P[i].x; S.z = P[i].z;
  S.yaw = Math.atan2(TAN[i].x, TAN[i].z);
  S.vx = S.vz = S.av = 0; S.steer = 0; S.drifting = false; S.idx = i; S.prevVh = S.yaw;
  lastMark[0] = lastMark[1] = null;
}
function resetCar() {
  const n = nearestIdx(S.x, S.z);
  placeAt(n.i);
  endCombo(true);
  showMsg('↺', '#fff');
}

const MAX_SPEED = 46;   // m/s ~ 165 km/h
const OFF_MAX = 17;
function physics(dt) {
  const sinY = Math.sin(S.yaw), cosY = Math.cos(S.yaw);
  const fx = sinY, fz = cosY;          // forward
  const lx = cosY, lz = -sinY;         // left
  let vF = S.vx * fx + S.vz * fz;
  let vL = S.vx * lx + S.vz * lz;
  const speed = Math.hypot(vF, vL);

  // steering input smoothing
  if (steerMode === 0 || input.analog == null) {
    const target = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const rate = S.drifting ? 4 : (target === 0 ? 8 : (Math.sign(target) !== Math.sign(S.steer) ? 10 : 6));
    S.steer += clamp(target - S.steer, -rate * dt, rate * dt);
  } else {
    S.steer += (input.analog - S.steer) * Math.min(1, 18 * dt);
  }

  // surface
  const near = nearestIdx(S.x, S.z, S.idx);
  if (S.testFlat) near.d = 0;
  S.idx = near.i;
  const onCurb = near.d > ROAD_W / 2 && near.d <= ROAD_W / 2 + CURB_W;
  S.offroad = near.d > ROAD_W / 2 + CURB_W + 0.6;
  S.onCurb = onCurb;
  const dirt = near.d > ROAD_W / 2 + CURB_W && near.d < ROAD_W / 2 + CURB_W + 4;
  S.dirt = dirt;

  // longitudinal
  if (input.gas) {
    const top = S.offroad && !dirt ? OFF_MAX : MAX_SPEED;
    const acc = vF < 0 ? 22 : 15 * clamp(1 - vF / top, -0.6, 1);
    vF += acc * dt;
  }
  if (input.brake) {
    if (vF > 0.5) vF -= 26 * dt;
    else vF = Math.max(vF - 9 * dt, -11);
  }
  if (input.hand) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 5.5 * dt);
  // drag / rolling
  const drag = 0.012 * vF * Math.abs(vF) + (input.gas ? 0 : 1.6) * Math.sign(vF);
  vF -= clamp(drag * dt, -Math.abs(vF), Math.abs(vF));
  if (S.offroad && !dirt) vF -= vF * 1.1 * dt;
  else if (dirt) vF -= vF * 0.35 * dt;

  // slip angle: positive when the nose points left of the direction of travel
  const slip = speed > 1 ? Math.atan2(-vL, Math.abs(vF) + 0.001) : 0;
  S.slip = slip;

  // drift state machine
  if (Math.abs(S.steer) > 0.7 && input.gas && vF > 13) S.flick += dt; else S.flick = 0;
  if (!S.drifting) {
    let dir = 0;
    if (Math.abs(slip) > 0.08) dir = Math.sign(slip);
    else if (Math.abs(S.steer) > 0.3) dir = -Math.sign(S.steer);
    if (dir && speed > 9 && vF > 0 && ((input.hand) || S.flick > 0.3 || Math.abs(slip) > 0.3)) {
      S.drifting = true; S.driftDir = dir;
    }
  } else {
    if (speed < 5 || vF < 0 || (!input.gas && !input.hand && Math.abs(slip) < 0.12)) S.drifting = false;
    else if (Math.abs(slip) > 0.15 && Math.sign(slip) !== S.driftDir) S.driftDir = Math.sign(slip); // transition (switch-back)
  }

  // lateral grip
  let grip;
  if (input.hand) grip = 1.0;
  else if (S.drifting) grip = input.gas ? 1.5 : 3.2;
  else grip = 10;
  if (S.offroad && !dirt) grip *= 0.6;
  else if (dirt) grip *= 0.75;
  const newVL = vL * Math.exp(-grip * dt);
  const lost = Math.abs(vL - newVL);
  vL = newVL;
  if (S.drifting && vF > 0) vF += lost * (input.gas ? 0.72 : 0.5); // momentum carried through the slide

  // yaw
  const vh = Math.atan2(S.vx, S.vz);
  let dvh = vh - S.prevVh; dvh = Math.atan2(Math.sin(dvh), Math.cos(dvh));
  S.prevVh = vh;
  const velTurn = speed > 1 ? dvh / dt : 0;
  let targetAV, resp;
  if (!S.drifting) {
    const maxSteer = 0.62 / (1 + speed / 16);
    targetAV = -S.steer * maxSteer * vF / 2.6;
    const lim = 12 / Math.max(speed, 1); // ~1.2g of grip
    targetAV = clamp(targetAV, -lim, lim);
    resp = 12;
  } else {
    // Steering rotates the car directly (relative to where it is travelling).
    // Throttle slowly pushes the angle wider, lifting lets it close.
    // So to HOLD an angle you balance gas against counter-steer – like a real drift.
    const D = S.driftDir, a = slip * D;            // current angle on the drift side, rad
    let rel = -S.steer * 2.1;                      // direct steering
    rel += D * (input.gas ? 0.55 : -0.9);          // throttle opens, lift closes
    if (input.hand) rel += D * 1.4;
    if (a > 1.05) rel -= D * (a - 1.05) * 9;       // soft limit ~60°, no full spin
    targetAV = clamp(velTurn, -3, 3) + rel;
    resp = 10;
  }
  S.av += (targetAV - S.av) * Math.min(1, resp * dt);
  if (speed < 0.5 && !input.gas) S.av *= 0.8;
  S.yaw += S.av * dt;

  // recompose
  const s2 = Math.sin(S.yaw), c2 = Math.cos(S.yaw);
  // keep velocity in world space – the car rotated under it
  const wvx = fx * vF + lx * vL, wvz = fz * vF + lz * vL;
  S.vx = wvx; S.vz = wvz;
  S.x += S.vx * dt; S.z += S.vz * dt;

  // tyre walls collision (simple circles)
  if (!S.testFlat) for (const [tx, tz] of scene.userData.tyrePts) {
    const dx = S.x - tx, dz = S.z - tz, d2 = dx * dx + dz * dz;
    if (d2 < 2.2 * 2.2) {
      const d = Math.sqrt(d2) || 0.01, nx = dx / d, nz = dz / d;
      S.x = tx + nx * 2.2; S.z = tz + nz * 2.2;
      const vn = S.vx * nx + S.vz * nz;
      if (vn < 0) { S.vx -= 1.5 * vn * nx; S.vz -= 1.5 * vn * nz; S.vx *= 0.6; S.vz *= 0.6; S.av *= 0.3; if (-vn > 6) hit(); }
    }
  }
  // world bounds
  if (Math.abs(S.x) > 700 || Math.abs(S.z - 40) > 700) resetCar();

  S.speed = Math.hypot(S.vx, S.vz);
  S.vF = S.vx * s2 + S.vz * c2;
  S.wheelRot += S.vF * dt / 0.36;
  // body roll & pitch for feel
  const latAcc = S.av * S.speed;
  S.roll = lerp(S.roll, clamp(-latAcc * 0.006, -0.09, 0.09), Math.min(1, 6 * dt));
  const lonTarget = (input.brake ? 0.04 : 0) - (input.gas ? 0.025 : 0);
  S.pitch = lerp(S.pitch, lonTarget, Math.min(1, 5 * dt));
}
function hit() {
  if (navigator.vibrate) navigator.vibrate(40);
  endCombo(true, 'УДАР!');
}

// ---------- scoring ----------
const G = {
  total: 0, combo: 0, comboTime: 0, idle: 0, mult: 1,
  best: store.get('best', 0), bestCombo: store.get('bestCombo', 0), bestLap: store.get('bestLap', null),
  lap: 1, lapTime: 0, half: false, prevIdx: 0, paused: true, started: false,
};
let msgTimer = 0;
function showMsg(text, color) {
  const m = $('msg'); m.textContent = text; m.style.color = color || '#fff';
  m.classList.add('show'); msgTimer = 1.2;
}
function endCombo(lost, reason) {
  if (G.combo > 0) {
    if (lost) showMsg(reason || 'ЗАЇХАВ НА ТРАВУ', '#ff5a5a');
    else {
      const pts = Math.round(G.combo);
      G.total += pts;
      if (pts > G.bestCombo) { G.bestCombo = pts; store.set('bestCombo', pts); showMsg('НОВИЙ РЕКОРД ДРИФТУ! +' + pts, '#ffd23f'); }
      else showMsg((pts > 5000 ? 'НЕЙМОВІРНО! +' : pts > 2000 ? 'ЧУДОВО! +' : pts > 600 ? 'ДОБРЕ! +' : '+') + pts, pts > 2000 ? '#ffd23f' : '#fff');
      if (G.total > G.best) { G.best = G.total; store.set('best', G.best); }
    }
  }
  G.combo = 0; G.comboTime = 0; G.mult = 1; G.idle = 0;
}
function scoring(dt) {
  const ang = Math.abs(S.slip);
  const scoringDrift = S.drifting && S.speed > 8 && ang > 0.18 && ang < 1.6;
  if (scoringDrift && S.offroad && !S.dirt) { endCombo(true); return; }
  if (scoringDrift) {
    G.idle = 0;
    G.comboTime += dt;
    G.mult = Math.min(5, 1 + Math.floor(G.comboTime / 2.5));
    const deg = ang * 57.3;
    G.combo += (S.speed * 3.6) * deg * 0.012 * G.mult * dt * 10;
  } else if (G.combo > 0) {
    G.idle += dt;
    if (G.idle > 1.1) endCombo(false);
  }
}
function laps(dt) {
  G.lapTime += dt;
  const i = S.idx;
  if (i > N * 0.4 && i < N * 0.6) G.half = true;
  if (G.prevIdx > N * 0.9 && i < N * 0.1 && G.half) {
    if (G.bestLap == null || G.lapTime < G.bestLap) { G.bestLap = G.lapTime; store.set('bestLap', G.bestLap); showMsg('КОЛО ' + fmtTime(G.lapTime) + ' — РЕКОРД!', '#3ddc97'); }
    else showMsg('КОЛО ' + fmtTime(G.lapTime), '#3ddc97');
    G.lap++; G.lapTime = 0; G.half = false;
  }
  G.prevIdx = i;
}

// ---------- camera ----------
let camMode = 0; // 0 chase, 1 far, 2 hood
const camPos = new THREE.Vector3(0, 5, -10);
const camLook = new THREE.Vector3();
function switchCam() { camMode = (camMode + 1) % 3; }
function updateCamera(dt, snap) {
  const fwd = new THREE.Vector3(Math.sin(S.yaw), 0, Math.cos(S.yaw));
  const vel = new THREE.Vector3(S.vx, 0, S.vz);
  const dir = fwd.clone();
  if (S.speed > 3 && camMode !== 2) dir.lerp(vel.normalize(), 0.55).normalize();
  const dist = camMode === 1 ? 13 : 7.2;
  const h = camMode === 1 ? 6.5 : 2.9;
  if (camMode === 2) {
    camPos.set(S.x + fwd.x * 0.4, 1.35, S.z + fwd.z * 0.4);
    camLook.set(S.x + fwd.x * 20, 1.0, S.z + fwd.z * 20);
    camera.position.copy(camPos);
  } else {
    const tp = new THREE.Vector3(S.x - dir.x * dist, h, S.z - dir.z * dist);
    if (snap) camPos.copy(tp); else camPos.lerp(tp, Math.min(1, 5 * dt));
    camLook.set(S.x + dir.x * 3, 1.0, S.z + dir.z * 3);
    camera.position.copy(camPos);
  }
  camera.lookAt(camLook);
  const fov = 62 + clamp(S.speed / MAX_SPEED, 0, 1) * 12;
  camera.fov = lerp(camera.fov, fov, Math.min(1, 3 * dt));
  camera.updateProjectionMatrix();
  sun.position.set(S.x + 60, 90, S.z - 40);
  sun.target.position.set(S.x, 0, S.z);
  scene.userData.sky.position.set(S.x, 0, S.z);
}

// ---------- visuals per frame ----------
function updateCarVisual(dt) {
  car.position.set(S.x, 0, S.z);
  car.rotation.y = S.yaw;
  body.rotation.z = S.roll;
  body.rotation.x = S.pitch;
  body.position.y = S.onCurb ? Math.sin(performance.now() * 0.06) * 0.03 : 0;
  for (const w of wheels) {
    w.spin.rotation.x = S.wheelRot;
    if (w.front) {
      // visual counter-steer when drifting looks cool
      let a = -S.steer * 0.5;
      if (S.drifting) a = clamp(S.slip * 0.9 - S.steer * 0.25, -0.7, 0.7);
      w.pivot.rotation.y = lerp(w.pivot.rotation.y, a, Math.min(1, 12 * dt));
    }
  }
  car.userData.tailMat.emissiveIntensity = input.brake ? 2.2 : 0.6;

  // skid + smoke from rear wheels
  const sliding = (S.drifting && Math.abs(S.slip) > 0.12 && S.speed > 5) || (input.hand && S.speed > 4) || (input.brake && S.vF > 12);
  const sinY = Math.sin(S.yaw), cosY = Math.cos(S.yaw);
  const surfaceDirt = S.offroad || S.dirt;
  for (let k = 0; k < 2; k++) {
    const w = wheels[2 + k];
    const wx = S.x + cosY * w.x + sinY * w.z, wz = S.z - sinY * w.x + cosY * w.z;
    if (sliding && !surfaceDirt) {
      const sp = S.speed || 1;
      addSkid(k, wx, wz, S.vx / sp, S.vz / sp);
    } else lastMark[k] = null;
    if (sliding && Math.random() < 0.55) puff(wx, wz, S.vx, S.vz, Math.abs(S.slip) * 0.6 + (input.gas ? 0.15 : 0), surfaceDirt);
    else if (surfaceDirt && S.speed > 8 && Math.random() < 0.25) puff(wx, wz, S.vx, S.vz, 0.25, true);
  }
  return sliding && !surfaceDirt;
}

function updateHUD() {
  const kmh = Math.round(S.speed * 3.6);
  $('spd').textContent = kmh;
  $('gear').textContent = S.vF < -0.5 ? 'R' : String(Math.min(6, 1 + Math.floor(S.speed / 8.5)));
  $('lapT').textContent = fmtTime(G.lapTime);
  $('lapN').textContent = G.lap;
  $('lapBest').textContent = fmtTime(G.bestLap);
  $('total').textContent = G.total.toLocaleString('uk-UA');
  const c = $('combo');
  if (G.combo > 0) {
    c.style.opacity = 1;
    $('comboPts').textContent = Math.round(G.combo).toLocaleString('uk-UA');
    $('comboMul').textContent = 'x' + G.mult;
    const left = 1 - G.idle / 1.1;
    c.style.filter = `brightness(${0.6 + left * 0.4})`;
  } else c.style.opacity = 0;
  const an = $('angle');
  if (S.drifting && S.speed > 6) { an.style.opacity = 1; an.textContent = 'кут ' + Math.round(Math.abs(S.slip) * 57.3) + '°'; }
  else an.style.opacity = 0;
}

// ---------- menu ----------
function buildMenu() {
  const wrap = $('colors'); wrap.innerHTML = '';
  CAR_COLORS.forEach((col, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === carColor ? ' sel' : '');
    d.style.background = '#' + col.toString(16).padStart(6, '0');
    d.addEventListener('pointerdown', () => { carColor = i; store.set('color', i); carPaint.color.setHex(col); buildMenu(); });
    wrap.appendChild(d);
  });
  const mw = $('modes'); mw.innerHTML = '';
  MODES.forEach((name, i) => {
    const d = document.createElement('div');
    d.className = 'mode' + (i === steerMode ? ' sel' : '');
    d.textContent = name;
    d.addEventListener('pointerdown', () => { steerMode = i; store.set('steerMode', i); applySteerMode(); buildMenu(); });
    mw.appendChild(d);
  });
  $('stats').innerHTML = `Рекорд очок: <b>${G.best.toLocaleString('uk-UA')}</b> · Найкращий дрифт: <b>${G.bestCombo.toLocaleString('uk-UA')}</b> · Найшвидше коло: <b>${fmtTime(G.bestLap)}</b>`;
  $('play').textContent = G.started ? 'ПРОДОВЖИТИ' : 'ГРАТИ';
}
function togglePause() {
  if (!G.started) return;
  G.paused = !G.paused;
  $('menu').classList.toggle('hidden', !G.paused);
  $('controls').classList.toggle('hidden', G.paused);
  if (G.paused) buildMenu();
}
$('play').addEventListener('click', () => {
  initAudio();
  if (!G.started) { G.started = true; placeAt(0); updateCamera(0, true); }
  G.paused = false;
  $('menu').classList.add('hidden');
  $('controls').classList.remove('hidden');
  if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
});
$('bPause').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePause(); });
$('bReset').addEventListener('pointerdown', (e) => { e.preventDefault(); resetCar(); });
$('bCam').addEventListener('pointerdown', (e) => { e.preventDefault(); switchCam(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (G.started && !G.paused) togglePause(); if (audio) audio.ctx.suspend(); }
});
// called by the Android back button: pause if playing, otherwise let the app close
window.dorifto_back = () => { if (G.started && !G.paused) { togglePause(); return true; } return false; };
window.dorifto_suspend = () => { if (G.started && !G.paused) togglePause(); if (audio) audio.ctx.suspend(); };
buildMenu();

// ---------- main loop ----------
placeAt(0);
updateCamera(0, true);
let last = performance.now();
let menuSpin = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  let screech = 0;
  if (!G.paused) {
    // fixed sub-steps for stable physics
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) physics(h);
    scoring(dt);
    laps(dt);
    const sl = updateCarVisual(dt);
    screech = sl ? clamp(Math.abs(S.slip) * 1.4 + (input.hand ? 0.3 : 0), 0, 1) : 0;
    updateCamera(dt);
    updateHUD();
  } else {
    // slow orbit around the car on the menu
    menuSpin += dt * 0.25;
    updateCarVisual(0);
    camera.position.set(S.x + Math.sin(menuSpin) * 9, 3.2, S.z + Math.cos(menuSpin) * 9);
    camera.lookAt(S.x, 0.8, S.z);
  }
  updateSmoke(dt);
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) $('msg').classList.remove('show'); }
  const rpmBand = (S.speed % 8.5) / 8.5;
  updateAudio(G.paused ? 0 : clamp(rpmBand * 0.8 + (S.drifting && input.gas ? 0.3 : 0), 0, 1.1), input.gas, screech, G.paused);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
window.__dorifto = { S, G, input, sim(sec) { const h = 1 / 120; for (let t = 0; t < sec; t += h) { physics(h); scoring(h); laps(h); updateCarVisual(h); } return { kmh: S.speed * 3.6, slip: S.slip * 57.3, drift: S.drifting, combo: G.combo, total: G.total, off: S.offroad, idx: S.idx }; } }; // for testing
