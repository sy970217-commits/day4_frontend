// three.js 3D 지도 + 실시간 날씨 + 미세먼지 (Open-Meteo, API 키 불필요)
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
// REGIONS 는 regions.js(일반 스크립트)에서 전역으로 제공된다.

const WX_URL = "https://api.open-meteo.com/v1/forecast";
const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WX_CURRENT = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m";

const WMO = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  56: ["🌧️", "얼어붙는 이슬비"], 57: ["🌧️", "강한 얼어붙는 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  66: ["🌧️", "얼어붙는 비"], 67: ["🌧️", "강한 얼어붙는 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"], 77: ["❄️", "싸락눈"],
  80: ["🌦️", "약한 소나기"], 81: ["🌧️", "소나기"], 82: ["⛈️", "강한 소나기"],
  85: ["🌨️", "약한 눈 소나기"], 86: ["❄️", "강한 눈 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "우박 동반 뇌우"], 99: ["⛈️", "강한 우박 동반 뇌우"],
};
const wmo = (code) => WMO[code] ?? ["❓", "알 수 없음"];

// 한국 환경부 기준 (㎍/㎥) -> 1 좋음, 2 보통, 3 나쁨, 4 매우나쁨
const GRADE_TEXT = { 0: "정보없음", 1: "좋음", 2: "보통", 3: "나쁨", 4: "매우나쁨" };
const GRADE_COLOR = { 0: 0x9aa7b4, 1: 0x1e88e5, 2: 0x2e9e5b, 3: 0xf59e0b, 4: 0xd32f2f };
function grade(kind, v) {
  if (v == null || Number.isNaN(v)) return 0;
  const cut = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= cut[0] ? 1 : v <= cut[1] ? 2 : v <= cut[2] ? 3 : 4;
}

const $ = (id) => document.getElementById(id);
const num = (v) => (v == null ? null : Math.round(v));

const MAIN_CITIES = ["서울", "인천", "수원", "춘천", "강릉", "청주", "세종", "대전", "전주", "광주", "목포",
  "안동", "대구", "포항", "울산", "부산", "창원", "제주"]
  .map((ko) => REGIONS.find((r) => r[0] === ko))
  .map((r) => ({ ko: r[0], en: r[1], lat: r[2], lon: r[3] }));

let current = { ko: "서울", en: "Seoul", lat: 37.5665, lon: 126.978 };

// ---------- API ----------
// 같은 요청은 10분간 localStorage 캐시를 재사용해 Open-Meteo 호출량(429)을 줄인다.
const CACHE_MS = 10 * 60 * 1000;
async function getJson(url, params) {
  const full = `${url}?${new URLSearchParams(params)}`;
  const key = `om:${full}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  } catch { /* 캐시 사용 불가 시 무시 */ }
  const res = await fetch(full);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = await res.json();
  try {
    // 오래된 캐시 정리 후 저장
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("om:") && k !== key) {
        const o = JSON.parse(localStorage.getItem(k) ?? "null");
        if (!o || Date.now() - o.t > CACHE_MS) localStorage.removeItem(k);
      }
    }
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch { /* 용량 초과 등은 무시 */ }
  return v;
}
const asArray = (x) => (Array.isArray(x) ? x : [x]);

async function fetchAt(points, wxCurrent, aqCurrent) {
  const base = {
    latitude: points.map((p) => p.lat).join(","),
    longitude: points.map((p) => p.lon).join(","),
    timezone: "auto",
  };
  const [wx, aq] = await Promise.allSettled([
    getJson(WX_URL, { ...base, current: wxCurrent }),
    getJson(AQ_URL, { ...base, current: aqCurrent }),
  ]);
  if (wx.status === "rejected") throw wx.reason;
  return { wx: asArray(wx.value), aq: aq.status === "fulfilled" ? asArray(aq.value) : null };
}

// ---------- 좌표 변환 (위경도 <-> 3D 월드) ----------
const LON0 = 127.8, LAT0 = 36.0, S = 10;           // 중심점, 1도 = 10 유닛
const COS = Math.cos((36.5 * Math.PI) / 180);
const toXZ = (lat, lon) => ({ x: (lon - LON0) * COS * S, z: -(lat - LAT0) * S });
const toLatLon = (x, z) => ({ lat: LAT0 - z / S, lon: x / (S * COS) + LON0 });
const DEPTH = 0.5; // 지도 두께

// ---------- three.js 장면 ----------
const container = $("map");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
camera.position.set(0, 58, 56);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.append(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
container.append(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.46;
controls.minDistance = 15;
controls.maxDistance = 130;
controls.target.set(0, 0, 4); // 제주까지 보이도록 약간 남쪽을 중심으로

scene.add(new THREE.AmbientLight(0xffffff, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-25, 50, 30);
scene.add(sun);

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

// 시도 경계 -> 압출된 3D 지형
const provinceMeshes = [];
const PALETTE = [0xdfe8d6, 0xe9e4cf, 0xd6e3e8, 0xe6d9d9];

async function buildProvinces() {
  const geo = await (await fetch("korea.geojson")).json();
  geo.features.forEach((f, idx) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const color = PALETTE[idx % PALETTE.length];
    for (const poly of polys) {
      const pts = (ring) => ring.map(([lon, lat]) => new THREE.Vector2((lon - LON0) * COS * S, (lat - LAT0) * S));
      const shape = new THREE.Shape(pts(poly[0]));
      poly.slice(1).forEach((h) => shape.holes.push(new THREE.Path(pts(h))));
      const g = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false });
      g.rotateX(-Math.PI / 2); // shape의 Y(북) -> -Z, 압출 방향 -> +Y(위)
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData = { name: f.properties.name, base: color };
      scene.add(mesh);
      provinceMeshes.push(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 40),
        new THREE.LineBasicMaterial({ color: 0x6b7c8f }),
      );
      scene.add(edges);
    }
  });
}

// ---------- 도시 막대(PM10 높이) + 날씨 라벨 ----------
const cityGroup = new THREE.Group();
scene.add(cityGroup);
const barMeshes = [];

function pinEl(city, temp, code) {
  const [icon] = wmo(code);
  const el = document.createElement("div");
  el.className = "wx-pin";
  el.textContent = `${icon} ${temp ?? "-"}°`;
  const small = document.createElement("small");
  small.textContent = city.ko;
  el.append(" ", small);
  el.addEventListener("click", () => select(city, { moveMap: false }));
  return el;
}

async function refreshMarkers() {
  try {
    const { wx, aq } = await fetchAt(MAIN_CITIES, WX_CURRENT, "pm10,pm2_5");
    cityGroup.clear();
    barMeshes.length = 0;
    MAIN_CITIES.forEach((city, i) => {
      const c = wx[i].current;
      const a = aq?.[i]?.current;
      const g = a ? Math.max(grade("pm10", a.pm10), grade("pm25", a.pm2_5)) : 0;
      const h = a?.pm10 != null ? Math.min(Math.max(a.pm10 / 10, 0.6), 14) : 0.6; // PM10 10㎍/㎥ = 1유닛
      const { x, z } = toXZ(city.lat, city.lon);

      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, h, 20),
        new THREE.MeshStandardMaterial({ color: GRADE_COLOR[g], roughness: 0.4 }),
      );
      bar.position.set(x, DEPTH + h / 2, z);
      bar.userData.city = city;
      cityGroup.add(bar);
      barMeshes.push(bar);

      const label = new CSS2DObject(pinEl(city, num(c.temperature_2m), c.weather_code));
      label.position.set(x, DEPTH + h + 0.8, z);
      cityGroup.add(label);
    });
  } catch (err) {
    console.warn("마커 갱신 실패:", err);
  }
}

// ---------- 선택 표시(맥박 링) ----------
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(0.9, 0.12, 12, 40),
  new THREE.MeshBasicMaterial({ color: 0x1565c0 }),
);
ring.rotation.x = Math.PI / 2;
ring.visible = false;
scene.add(ring);

// ---------- 카메라 이동 ----------
let tween = null;
function flyTo(x, z) {
  tween = new THREE.Vector3(x, 0, z);
}

// ---------- 상호작용 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev, objects) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(objects, false)[0];
}

let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // 드래그는 클릭이 아님
  down = null;
  const bar = pick(e, barMeshes);
  if (bar) return select(bar.object.userData.city, { moveMap: false });
  const hit = pick(e, provinceMeshes);
  if (!hit) return;
  const { lat, lon } = toLatLon(hit.point.x, hit.point.z);
  const n = nearestRegion({ lat, lon });
  select({
    ko: "선택 지점", en: "", lat, lon,
    sub: `${hit.object.userData.name} · ${lat.toFixed(3)}, ${lon.toFixed(3)} · 가까운 지역: ${n.name} (약 ${Math.round(n.km)}km)`,
  }, { moveMap: false });
});

// 마우스 오버 시 시도 강조
let hovered = null;
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons) return;
  const hit = pick(e, provinceMeshes);
  const next = hit?.object ?? null;
  if (next === hovered) return;
  if (hovered) hovered.material.color.setHex(hovered.userData.base);
  hovered = next;
  if (hovered) hovered.material.color.setHex(0xbfdcff);
  renderer.domElement.style.cursor = hovered ? "pointer" : "grab";
});

const rad = (d) => (d * Math.PI) / 180;
function distKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function nearestRegion(p) {
  let best = null, bd = Infinity;
  for (const r of REGIONS) {
    const d = distKm(p, { lat: r[2], lon: r[3] });
    if (d < bd) { bd = d; best = r; }
  }
  return { name: best[0], km: bd };
}

// ---------- 상세 패널 ----------
function setDust(kind, v) {
  const g = grade(kind, v);
  const id = kind === "pm10" ? "pm10" : "pm25";
  $(id).textContent = v == null ? "--" : `${Math.round(v)}`;
  $(`${id}-grade`).textContent = GRADE_TEXT[g];
  $(`${id}-box`).className = `dust-item g${g}`;
}

async function loadDetail() {
  const status = $("status");
  status.textContent = "불러오는 중...";
  status.className = "status";
  try {
    const { wx, aq } = await fetchAt([current], WX_CURRENT, "pm10,pm2_5");
    const c = wx[0].current, u = wx[0].current_units;
    const [icon, desc] = wmo(c.weather_code);

    $("place").textContent = current.en ? `${current.ko} (${current.en})` : current.ko;
    $("sub").textContent = current.sub ?? "";
    $("icon").textContent = icon;
    $("desc").textContent = desc;
    $("temp").textContent = Math.round(c.temperature_2m);
    $("feels").textContent = `${c.apparent_temperature}${u.apparent_temperature}`;
    $("humidity").textContent = `${c.relative_humidity_2m}${u.relative_humidity_2m}`;
    $("wind").textContent = `${c.wind_speed_10m} ${u.wind_speed_10m}`;
    $("precip").textContent = `${c.precipitation} ${u.precipitation}`;
    $("updated").textContent = `기준 시각 ${c.time.replace("T", " ")}`;

    const a = aq?.[0]?.current;
    setDust("pm10", a?.pm10 ?? null);
    setDust("pm25", a?.pm2_5 ?? null);

    status.textContent = aq ? "" : "미세먼지 정보를 가져오지 못했습니다.";
    $("weather").hidden = false;
  } catch (err) {
    status.textContent = `날씨 정보를 가져오지 못했습니다: ${err.message}`;
    status.className = "status error";
  }
}

function select(place, { moveMap = true } = {}) {
  current = place;
  const { x, z } = toXZ(place.lat, place.lon);
  ring.position.set(x, DEPTH + 0.15, z);
  ring.visible = true;
  if (moveMap) flyTo(x, z);
  loadDetail();
}

// ---------- 검색 자동완성 ----------
const input = $("search");
const list = $("suggestions");
let items = [], active = -1, searchSeq = 0;

function searchLocal(q) {
  const kq = q.trim();
  const eq = kq.toLowerCase();
  if (!kq) return [];
  const score = (r) => {
    if (r[0].startsWith(kq)) return 0;
    if (r[1].toLowerCase().startsWith(eq)) return 1;
    if (r[0].includes(kq)) return 2;
    if (r[1].toLowerCase().includes(eq)) return 3;
    return -1;
  };
  return REGIONS
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, 8)
    .map(({ r }) => ({ ko: r[0], en: r[1], lat: r[2], lon: r[3] }));
}

async function geocode(name) {
  const data = await getJson("https://geocoding-api.open-meteo.com/v1/search",
    { name, count: 8, language: "ko", countryCode: "KR" });
  return (data.results ?? []).map((r) => ({
    ko: r.name, en: "", sub: [r.admin1, r.admin2].filter(Boolean).join(" "),
    lat: r.latitude, lon: r.longitude,
  }));
}
async function searchRemote(q, local) {
  if (q.trim().length < 2) return [];
  let found = await geocode(q.trim());
  if (!found.length && /[가-힣]/.test(q) && local.length) found = await geocode(local[0].en);
  return found;
}

async function onInput() {
  const q = input.value;
  const seq = ++searchSeq;
  if (!q.trim()) return hideList();
  const local = searchLocal(q);
  render(local);
  try {
    const remote = await searchRemote(q, local);
    if (seq !== searchSeq) return;
    const key = (x) => `${x.lat.toFixed(1)},${x.lon.toFixed(1)}`;
    const seen = new Set(local.map(key));
    render([...local, ...remote.filter((x) => !seen.has(key(x)))].slice(0, 10));
  } catch { /* 네트워크 실패 시 로컬 결과 유지 */ }
}

function render(next) {
  items = next;
  active = items.length ? 0 : -1;
  list.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "검색 결과가 없습니다";
    list.append(li);
  }
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.i = i;
    const b = document.createElement("b"); b.textContent = it.ko;
    const s = document.createElement("small"); s.textContent = it.en || it.sub || "";
    li.append(b, s);
    list.append(li);
  });
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  highlight();
}
function highlight() {
  [...list.querySelectorAll("li[role=option]")].forEach((li, i) => li.classList.toggle("active", i === active));
}
function hideList() {
  list.hidden = true; items = []; active = -1;
  input.setAttribute("aria-expanded", "false");
}
function choose(i) {
  const it = items[i];
  if (!it) return;
  input.value = it.ko;
  hideList();
  select(it);
}

input.addEventListener("input", onInput);
input.addEventListener("focus", () => { input.select(); if (input.value) onInput(); });
input.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    highlight();
  } else if (e.key === "Enter") { e.preventDefault(); choose(active); }
  else if (e.key === "Escape") hideList();
});
list.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[role=option]");
  if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideList(); });

// ---------- 렌더 루프 ----------
renderer.setAnimationLoop((t) => {
  if (tween) {
    const d = tween.clone().sub(controls.target).multiplyScalar(0.1);
    controls.target.add(d);
    camera.position.add(d);
    if (d.length() < 0.01) tween = null;
  }
  if (ring.visible) ring.scale.setScalar(1 + 0.25 * Math.sin(t / 250));
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// ---------- 시작 ----------
buildProvinces().catch((e) => console.error("지도 경계 로드 실패:", e));
refreshMarkers();
select(current, { moveMap: false });
setInterval(() => { refreshMarkers(); loadDetail(); }, 10 * 60 * 1000);
