"use strict";
// 에이전트가 호출하는 두 개의 도구: get_weather, find_spots
// - get_weather: Open-Meteo (날씨 + 대기질), API 키 불필요
// - find_spots : Open-Meteo 지오코딩 + OpenStreetMap Overpass API, API 키 불필요

const REGIONS = require("../../regions.js"); // [한글, 영문, 위도, 경도]
const UA = "day4-weather-agent/1.0";

async function getJson(url, init = {}, timeoutMs = 10000) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ---------- 공통: 지역명 -> 좌표 ----------
async function resolvePlace({ location, latitude, longitude }) {
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { name: location || `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`, lat: latitude, lon: longitude };
  }
  if (!location || typeof location !== "string") return null;
  const text = location.trim();

  // 1) 내장 지역 사전(약 120곳): "서울", "제주"처럼 짧은 한글명은 지오코딩 API가 못 찾기 때문에 먼저 사용
  const local = [...REGIONS]
    .sort((a, b) => b[0].length - a[0].length) // 긴 이름 우선 (예: "서귀포"가 "서"보다 먼저)
    .find((r) => text.includes(r[0]) || text.toLowerCase() === r[1].toLowerCase());
  if (local) return { name: local[0], lat: local[2], lon: local[3] };

  // 2) 사전에 없으면 Open-Meteo 지오코딩 (한국 한정). "~시/~군" 접미사를 붙여 재시도
  for (const name of [text, `${text}시`, `${text}군`]) {
    const q = new URLSearchParams({ name, count: "1", language: "ko", countryCode: "KR" });
    const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
    const r = d.results?.[0];
    if (r) {
      const admin = [r.admin1, r.admin2].filter(Boolean).join(" ");
      return { name: admin ? `${r.name} (${admin})` : r.name, lat: r.latitude, lon: r.longitude };
    }
  }
  return null;
}

// ---------- get_weather ----------
const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "얼어붙는 이슬비", 57: "강한 얼어붙는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "얼어붙는 비", 67: "강한 얼어붙는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "약한 눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 동반 뇌우",
};
const gradeText = (kind, v) => {
  if (v == null) return "정보없음";
  const cut = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= cut[0] ? "좋음" : v <= cut[1] ? "보통" : v <= cut[2] ? "나쁨" : "매우나쁨";
};

async function getWeather(args) {
  const place = await resolvePlace(args);
  if (!place) {
    return { error: `'${args.location ?? ""}' 위치를 찾지 못했습니다. 더 일반적인 지역명(예: 서울, 제주, 강릉)으로 다시 시도하세요.` };
  }
  const base = { latitude: place.lat, longitude: place.lon, timezone: "Asia/Seoul" };
  const [wx, aq] = await Promise.allSettled([
    getJson(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      ...base,
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "3",
    })}`),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({
      ...base, current: "pm10,pm2_5",
    })}`),
  ]);
  if (wx.status === "rejected") {
    return { error: `날씨 조회 실패: ${wx.reason.message}${wx.reason.status === 429 ? " (요청 한도 초과, 잠시 후 재시도)" : ""}` };
  }
  const c = wx.value.current, d = wx.value.daily;
  const result = {
    location: place.name,
    latitude: place.lat,
    longitude: place.lon,
    observed_at: c.time,
    current: {
      condition: WMO[c.weather_code] ?? "알 수 없음",
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      precipitation_mm: c.precipitation,
    },
    forecast: d.time.map((date, i) => ({
      date,
      condition: WMO[d.weather_code[i]] ?? "알 수 없음",
      max_c: d.temperature_2m_max[i],
      min_c: d.temperature_2m_min[i],
      rain_probability_pct: d.precipitation_probability_max[i],
    })),
    air_quality: null,
  };
  if (aq.status === "fulfilled") {
    const a = aq.value.current;
    result.air_quality = {
      pm10: a.pm10, pm10_grade: gradeText("pm10", a.pm10),
      pm25: a.pm2_5, pm25_grade: gradeText("pm25", a.pm2_5),
      note: "CAMS 모델 기반 예측값",
    };
  } else {
    result.air_quality_error = "미세먼지 정보를 가져오지 못했습니다.";
  }
  return result;
}

// ---------- find_spots ----------
const CATEGORY_LABEL = {
  attraction: "관광지", nature: "공원·자연", beach: "해변", museum: "박물관·미술관",
  indoor: "실내 명소", cafe: "카페", restaurant: "식당",
};
// category -> OSM 태그 필터 목록
const CATEGORY_FILTERS = {
  attraction: ['["tourism"~"^(attraction|viewpoint|theme_park|zoo|aquarium)$"]'],
  nature: ['["leisure"~"^(park|nature_reserve|garden)$"]', '["natural"~"^(peak|waterfall)$"]'],
  beach: ['["natural"="beach"]'],
  museum: ['["tourism"~"^(museum|gallery)$"]'],
  indoor: ['["tourism"~"^(museum|gallery|aquarium)$"]', '["amenity"~"^(cinema|arts_centre)$"]'],
  cafe: ['["amenity"="cafe"]'],
  restaurant: ['["amenity"="restaurant"]'],
};
// 공개 Overpass 서버는 종종 과부하 상태라, 여러 미러에 동시에 요청해 가장 먼저 성공한 응답을 쓴다.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// Overpass 실패 시 대체: Photon(OSM 텍스트 검색). category -> osm_tag 목록과 기본 검색어
const PHOTON_TAGS = {
  attraction: ["tourism:attraction", "tourism:viewpoint", "tourism:theme_park", "tourism:zoo", "tourism:museum",
    "natural:beach", "natural:waterfall", "natural:peak", "leisure:park"],
  nature: ["leisure:park", "leisure:nature_reserve", "leisure:garden"],
  beach: ["natural:beach"],
  museum: ["tourism:museum", "tourism:gallery"],
  indoor: ["tourism:museum", "tourism:gallery", "tourism:aquarium", "amenity:cinema"],
  cafe: ["amenity:cafe"],
  restaurant: ["amenity:restaurant"],
};
// Photon은 이름 텍스트 검색이라 카테고리별로 여러 검색어를 병렬로 던져 합친다 ("@region"은 지역명으로 치환)
const PHOTON_QUERY = {
  attraction: ["@region", "전망대", "폭포", "해수욕장", "박물관"],
  nature: ["공원", "폭포", "숲", "오름"],
  beach: ["해수욕장", "해변"],
  museum: ["박물관", "미술관"],
  indoor: ["박물관", "미술관", "아쿠아리움"],
  cafe: ["카페"],
  restaurant: ["식당"],
};

const rad = (d) => (d * Math.PI) / 180;
function distKm(aLat, aLon, bLat, bLon) {
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Overpass가 응답하지 않으면 5분간 건너뛰고(서킷 브레이커) 곧바로 Photon을 쓴다.
// 서버리스 인스턴스가 살아 있는 동안만 유지되며, 매 호출마다 시간 초과를 기다리는 낭비를 막는다.
let overpassDownUntil = 0;
async function overpass(query) {
  if (Date.now() < overpassDownUntil) throw new Error("overpass skipped (recently unavailable)");
  const body = new URLSearchParams({ data: query }).toString();
  try {
    return await Promise.any(OVERPASS.map((url) => getJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, 5000)));
  } catch (e) {
    overpassDownUntil = Date.now() + 5 * 60 * 1000;
    throw e;
  }
}

// Overpass 응답 -> 공통 형식
function fromOverpass(data) {
  return (data.elements ?? []).map((el) => {
    const t = el.tags ?? {};
    return {
      name: t["name:ko"] || t.name,
      lat: el.lat ?? el.center?.lat,
      lon: el.lon ?? el.center?.lon,
      // 위키/웹사이트가 있는 곳을 대표성 높은 장소로 간주해 우선 정렬
      score: (t.wikidata ? 3 : 0) + (t.wikipedia ? 2 : 0) + (t.website || t["contact:website"] ? 1 : 0) + (t["name:en"] ? 1 : 0),
      english_name: t["name:en"],
      opening_hours: t.opening_hours,
      website: t.website || t["contact:website"],
    };
  });
}

// Photon 대체 검색 -> 공통 형식 (반경은 bbox로 제한)
async function photonSearch(place, category, kw, radiusKm) {
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(rad(place.lat)));
  const regionName = (REGIONS.find((r) => r[2] === place.lat && r[3] === place.lon) ?? [])[0];
  const region = regionName || place.name.split(" ")[0];
  const queries = kw ? [kw] : PHOTON_QUERY[category].map((q) => (q === "@region" ? region : q));
  const results = await Promise.allSettled(queries.map(async (q) => {
    const p = new URLSearchParams({
      q, lat: String(place.lat), lon: String(place.lon),
      bbox: [place.lon - dLon, place.lat - dLat, place.lon + dLon, place.lat + dLat].join(","),
      limit: "15",
    });
    PHOTON_TAGS[category].forEach((t) => p.append("osm_tag", t));
    return getJson(`https://photon.komoot.io/api/?${p}`, {}, 10000);
  }));
  const ok = results.filter((r) => r.status === "fulfilled");
  if (!ok.length) throw results[0].reason;
  return ok.flatMap((r) => r.value.features ?? []).map((f) => ({
    name: f.properties?.name,
    lon: f.geometry?.coordinates?.[0],
    lat: f.geometry?.coordinates?.[1],
    score: 0,
  }));
}

// ---------- 카카오 로컬 API (1순위) ----------
// category -> 카카오 카테고리 그룹 코드(AT4 관광명소, CT1 문화시설, CE7 카페, FD6 음식점)
// keyword가 없을 때 쓸 기본 검색어는 category 검색으로 처리하고, 공원·해변은 키워드 검색으로 처리한다.
const KAKAO_CODE = { attraction: "AT4", nature: "AT4", beach: "AT4", museum: "CT1", indoor: "CT1", cafe: "CE7", restaurant: "FD6" };
const KAKAO_DEFAULT_QUERY = { nature: "공원", beach: "해수욕장" }; // 이 카테고리는 키워드 검색 사용

async function kakaoSearch(place, category, kw, radiusKm, limit) {
  const key = process.env.KAKAO_REST_API_KEY;
  const query = kw || KAKAO_DEFAULT_QUERY[category];
  const params = new URLSearchParams({
    x: String(place.lon), y: String(place.lat),
    radius: String(Math.round(radiusKm * 1000)),
    category_group_code: KAKAO_CODE[category],
    size: String(Math.min(Math.max(limit * 2, 10), 15)), // 중복/이름 없는 항목을 거르고도 limit을 채우도록 여유분 요청
    sort: query ? "accuracy" : "distance",
  });
  let url;
  if (query) { params.set("query", query); url = "https://dapi.kakao.com/v2/local/search/keyword.json"; }
  else { url = "https://dapi.kakao.com/v2/local/search/category.json"; }

  // 에러 본문(카카오가 준 사유)을 로그에 남기기 위해 getJson 대신 직접 fetch한다
  const res = await fetch(`${url}?${params}`, {
    headers: { Authorization: `KakaoAK ${key}`, "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(`카카오 API 오류 HTTP ${res.status}: ${body.message ?? body.errorType ?? "사유 없음"}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  return (data.documents ?? []).map((d, i) => ({
    name: d.place_name,
    lat: Number(d.y),
    lon: Number(d.x),
    score: 100 - i, // 카카오가 준 순서(정확도/거리)를 그대로 유지
    address: d.road_address_name || d.address_name,
    phone: d.phone || undefined,
    url: d.place_url,
    sub_category: d.category_name?.split(">").pop()?.trim(),
  }));
}

async function findSpots(args) {
  const category = CATEGORY_FILTERS[args.category] ? args.category : "attraction";
  const place = await resolvePlace(args);
  if (!place) {
    return { error: `'${args.location ?? ""}' 위치를 찾지 못했습니다. 더 일반적인 지역명으로 다시 시도하세요.` };
  }
  const radiusKm = Math.min(Math.max(Number(args.radius_km) || 5, 1), 20);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 10);
  // 정규식 주입을 막기 위해 글자·숫자·공백만 허용
  const kw = typeof args.keyword === "string" ? args.keyword.replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 30) : "";
  const nameFilter = kw ? `["name"~"${kw}",i]` : '["name"]';

  const around = `(around:${Math.round(radiusKm * 1000)},${place.lat},${place.lon})`;
  const query = `[out:json][timeout:15];(${CATEGORY_FILTERS[category]
    .map((f) => `nwr${around}${f}${nameFilter};`).join("")});out center tags 80;`;

  // 1순위: 카카오 로컬 API (KAKAO_REST_API_KEY가 있을 때). 실패하면 OpenStreetMap으로 대체
  let raw, source = "Kakao Local API";
  if (process.env.KAKAO_REST_API_KEY) {
    try {
      raw = await kakaoSearch(place, category, kw, radiusKm, limit);
    } catch (e) {
      console.warn("kakao search failed:", e.message);
    }
  }
  if (!raw) {
    source = "OpenStreetMap(Overpass)";
    try {
      raw = fromOverpass(await overpass(query));
    } catch (e1) {
      try {
        raw = await photonSearch(place, category, kw, radiusKm);
        source = "OpenStreetMap(Photon 대체 검색, 결과가 제한적일 수 있음)";
      } catch (e2) {
        return { error: `장소 검색 서버에 연결하지 못했습니다(${e2.message}). 잠시 후 다시 시도해 주세요.` };
      }
    }
  }

  const seen = new Set();
  const spots = [];
  for (const s of raw) {
    const { name, lat, lon } = s;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || seen.has(name)) continue;
    seen.add(name);
    spots.push({
      name,
      category: CATEGORY_LABEL[category],
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      distance_km: +distKm(place.lat, place.lon, lat, lon).toFixed(1),
      type: s.sub_category,
      address: s.address,
      phone: s.phone,
      url: s.url,
      english_name: s.english_name,
      opening_hours: s.opening_hours,
      website: s.website,
      _score: s.score,
    });
  }
  spots.sort((a, b) => b._score - a._score || a.distance_km - b.distance_km);
  const top = spots.slice(0, limit).map(({ _score, ...s }) => {
    Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
    return s;
  });

  const result = {
    searched_location: place.name,
    center: { latitude: place.lat, longitude: place.lon },
    category: CATEGORY_LABEL[category],
    radius_km: radiusKm,
    source,
    count: top.length,
    spots: top,
  };
  if (!top.length) result.hint = "결과가 없습니다. radius_km를 늘리거나 다른 category로 재검색하세요.";
  return result;
}

// ---------- Gemini function declarations ----------
const declarations = [
  {
    name: "get_weather",
    description:
      "한국 지역의 실시간 날씨(현재 기온·체감온도·습도·풍속·강수량)와 오늘~모레 예보, 미세먼지(PM10/PM2.5) 등급을 조회한다. " +
      "날씨·옷차림·우산·야외활동 가능 여부·미세먼지에 대한 질문이거나, 장소를 추천하기 전에 날씨 조건을 확인할 때 사용한다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "지역명(예: 서울, 제주, 강릉, 해운대). 2글자 이상." },
        latitude: { type: "number", description: "위도 (location 대신 사용 가능)" },
        longitude: { type: "number", description: "경도 (location 대신 사용 가능)" },
      },
    },
  },
  {
    name: "find_spots",
    description:
      "특정 지역 주변의 장소를 검색한다. 가볼 만한 곳, 데이트·나들이 코스, 맛집·카페, 비 오는 날 실내 장소 같은 추천 요청에 사용한다. " +
      "결과에는 장소 이름·좌표·거리가 포함된다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "검색 중심 지역명(예: 제주, 강릉, 전주). 2글자 이상." },
        category: {
          type: "string",
          enum: Object.keys(CATEGORY_FILTERS),
          description: "attraction=관광지, nature=공원·자연, beach=해변, museum=박물관·미술관, indoor=실내 명소(비 오는 날), cafe=카페, restaurant=식당",
        },
        keyword: { type: "string", description: "장소 이름에 포함될 키워드(선택). 예: 국수, 해물" },
        radius_km: { type: "number", description: "검색 반경(km), 기본 5, 최대 20" },
        limit: { type: "integer", description: "최대 결과 수, 기본 8, 최대 10" },
      },
      required: ["location", "category"],
    },
  },
];

const handlers = { get_weather: getWeather, find_spots: findSpots };

async function runTool(name, args) {
  const fn = handlers[name];
  if (!fn) return { error: `알 수 없는 도구: ${name}` };
  try {
    return await fn(args ?? {});
  } catch (e) {
    return { error: `${name} 실행 중 오류: ${e.message}` };
  }
}

module.exports = { declarations, runTool, getWeather, findSpots };
