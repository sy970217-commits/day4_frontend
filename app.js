// 지도 + 실시간 날씨 + 미세먼지 (Open-Meteo, API 키 불필요)
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
function grade(kind, v) {
  if (v == null || Number.isNaN(v)) return 0;
  const cut = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= cut[0] ? 1 : v <= cut[1] ? 2 : v <= cut[2] ? 3 : 4;
}
const worst = (a, b) => Math.max(a, b);

const $ = (id) => document.getElementById(id);
const num = (v) => (v == null ? null : Math.round(v));

// 지도에 항상 표시할 대표 도시
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
const asArray = (x) => (Array.isArray(x) ? x : [x]); // 다중 좌표 조회는 배열, 단일은 객체

// 1순위: Vercel 서버 프록시(/api/weather, 10분 공용 캐시) -> 실패 시(로컬 정적 서버 등) Open-Meteo 직접 호출
const DIRECT = { forecast: WX_URL, air: AQ_URL };
async function om(src, params) {
  try {
    return await getJson("/api/weather", { ...params, src });
  } catch {
    return getJson(DIRECT[src], params);
  }
}

async function fetchAt(points, wxCurrent, aqCurrent) {
  // 소수 둘째 자리로 맞춰, 같은 지점은 모든 사용자가 같은 URL(=같은 CDN 캐시)을 쓰게 한다
  const lat = points.map((p) => p.lat.toFixed(2)).join(",");
  const lon = points.map((p) => p.lon.toFixed(2)).join(",");
  const base = { latitude: lat, longitude: lon, timezone: "auto" };
  // 날씨와 대기질은 독립적으로 조회 (한쪽이 실패해도 다른 쪽은 표시)
  const [wx, aq] = await Promise.allSettled([
    om("forecast", { ...base, current: wxCurrent }),
    om("air", { ...base, current: aqCurrent }),
  ]);
  if (wx.status === "rejected") throw wx.reason;
  return {
    wx: asArray(wx.value),
    aq: aq.status === "fulfilled" ? asArray(aq.value) : null,
    aqError: aq.status === "rejected" ? aq.reason.message : null,
  };
}

// ---------- 지도 ----------
const map = L.map("map", { minZoom: 6, maxZoom: 13, zoomControl: true })
  .setView([36.3, 127.8], 7);
map.setMaxBounds([[32.0, 123.5], [39.5, 132.5]]);
// OSM 공용 타일은 Referer 없는 요청(file:// 등)을 차단하고, CARTO는 API 키가 필요해서 Esri 타일을 사용
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles © Esri — Source: Esri, HERE, Garmin, OpenStreetMap contributors",
  maxZoom: 18,
}).addTo(map);

const legend = L.control({ position: "bottomleft" });
legend.onAdd = () => {
  const d = L.DomUtil.create("div", "legend");
  d.innerHTML = "<b>미세먼지 등급</b><br>" +
    [["#1e88e5", "좋음"], ["#2e9e5b", "보통"], ["#f59e0b", "나쁨"], ["#d32f2f", "매우나쁨"]]
      .map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("<br>");
  return d;
};
legend.addTo(map);

const markerLayer = L.layerGroup().addTo(map);
let selectedMarker = null;

function pinIcon(city, temp, code, g) {
  const [icon] = wmo(code);
  const el = document.createElement("div");
  el.className = `wx-pin g${g}`;
  el.textContent = `${icon} ${temp ?? "-"}°`;
  const small = document.createElement("small");
  small.textContent = city.ko;
  el.append(" ", small);
  return L.divIcon({ className: "wx-marker", html: el.outerHTML, iconSize: [0, 0] });
}

async function refreshMarkers() {
  try {
    const { wx, aq } = await fetchAt(MAIN_CITIES, WX_CURRENT, "pm10,pm2_5");
    markerLayer.clearLayers();
    MAIN_CITIES.forEach((city, i) => {
      const c = wx[i].current;
      const a = aq?.[i]?.current;
      const g = a ? worst(grade("pm10", a.pm10), grade("pm25", a.pm2_5)) : 0;
      L.marker([city.lat, city.lon], { icon: pinIcon(city, num(c.temperature_2m), c.weather_code, g), title: city.ko })
        .on("click", () => select(city, { moveMap: false }))
        .addTo(markerLayer);
    });
  } catch (err) {
    console.warn("마커 갱신 실패:", err);
  }
}

// 지도 클릭 -> 가장 가까운 지역 이름 표시
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

map.on("click", (e) => {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  const n = nearestRegion(p);
  select({
    ko: `선택 지점`, en: "", ...p,
    sub: `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} · 가까운 지역: ${n.name} (약 ${Math.round(n.km)}km)`,
  }, { moveMap: false });
});

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
    const { wx, aq, aqError } = await fetchAt([current], WX_CURRENT, "pm10,pm2_5");
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

    status.textContent = aq ? ""
      : aqError?.includes("429")
        ? "미세먼지 API 요청 한도를 초과했습니다. 다음 정시 이후 다시 시도해 주세요."
        : "미세먼지 정보를 가져오지 못했습니다.";
    $("weather").hidden = false;
  } catch (err) {
    status.textContent = `날씨 정보를 가져오지 못했습니다: ${err.message}`;
    status.className = "status error";
  }
}

function select(place, { moveMap = true } = {}) {
  current = place;
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.circleMarker([place.lat, place.lon], {
    radius: 9, color: "#1565c0", weight: 3, fillColor: "#fff", fillOpacity: 0.6,
  }).addTo(map);
  if (moveMap) map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), 9), { duration: 0.8 });
  loadDetail();
}

// ---------- AI 에이전트(find_spots)가 추천한 장소를 지도에 표시 (chat.js에서 호출) ----------
const spotLayer = L.layerGroup().addTo(map);
function showSpots(spots) {
  spotLayer.clearLayers();
  const pts = [];
  (spots ?? []).forEach((s) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
    const el = document.createElement("div");
    el.className = "spot-pin";
    el.textContent = `📍 ${s.name}`;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "wx-marker", html: el.outerHTML, iconSize: [0, 0] }), title: s.name })
      .on("click", () => {
        select({ ko: s.name, en: "", sub: s.category ?? "", lat: s.lat, lon: s.lon }, { moveMap: false });
        window.showTab?.("weather");
      })
      .addTo(spotLayer);
    pts.push([s.lat, s.lon]);
  });
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
}

// ---------- 검색 자동완성 ----------
const input = $("search");
const list = $("suggestions");
let items = [], active = -1, searchSeq = 0;

// 한글 접두사(1글자~) / 영문 접두사 / 한글 포함 순으로 로컬 사전 검색
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

// 사전에 없는 지역: Open-Meteo 지오코딩 (한국 한정). 한글 결과가 없으면 영문명으로 재검색
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
  if (e.isComposing) return; // 한글 조합 중에는 무시
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

// ---------- 시작 ----------
refreshMarkers();
select(current, { moveMap: false });
setInterval(() => { refreshMarkers(); loadDetail(); }, 10 * 60 * 1000); // 10분마다 갱신
