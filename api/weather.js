"use strict";
// Open-Meteo 프록시 (Vercel 서버리스)
// 브라우저가 직접 Open-Meteo를 부르면 사용자 IP별(공용 IP는 여러 명이 합산) 한도에 걸리므로,
// 서버가 대신 호출하고 응답을 Vercel CDN에 10분간 캐시해 모든 사용자가 같은 결과를 공유한다.

const TARGETS = {
  forecast: "https://api.open-meteo.com/v1/forecast",
  air: "https://air-quality-api.open-meteo.com/v1/air-quality",
};
const COORDS = /^-?\d{1,3}(\.\d+)?(,-?\d{1,3}(\.\d+)?)*$/; // "37.5,35.1"
const FIELDS = /^[a-z0-9_,]+$/;                            // "temperature_2m,pm10"
const ZONE = /^[A-Za-z_]+(\/[A-Za-z_]+)?$/;                // "auto" 또는 "Asia/Seoul"
const MAX_POINTS = 25;

// 좌표를 소수 둘째 자리(약 1km)로 맞춰 캐시 적중률을 높인다. Open-Meteo 격자(약 11km)보다 훨씬 촘촘해 결과는 같다.
const round2 = (list) => list.split(",").map((v) => (+v).toFixed(2)).join(",");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "GET 요청만 지원합니다." });

  const { src, latitude, longitude, current, timezone = "auto" } = req.query;
  const target = TARGETS[src];
  if (!target) return res.status(400).json({ error: "src는 forecast 또는 air 여야 합니다." });
  if (typeof latitude !== "string" || typeof longitude !== "string" || !COORDS.test(latitude) || !COORDS.test(longitude)) {
    return res.status(400).json({ error: "latitude/longitude 형식이 올바르지 않습니다." });
  }
  const n = latitude.split(",").length;
  if (n > MAX_POINTS || n !== longitude.split(",").length) {
    return res.status(400).json({ error: `좌표는 같은 개수로 최대 ${MAX_POINTS}개까지 지원합니다.` });
  }
  if (typeof current !== "string" || !FIELDS.test(current) || typeof timezone !== "string" || !ZONE.test(timezone)) {
    return res.status(400).json({ error: "current 또는 timezone 형식이 올바르지 않습니다." });
  }

  const q = new URLSearchParams({ latitude: round2(latitude), longitude: round2(longitude), current, timezone });
  try {
    const up = await fetch(`${target}?${q}`, {
      headers: { "User-Agent": "day4-weather-agent/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await up.json().catch(() => ({}));
    if (!up.ok) {
      // 실패 응답은 캐시하지 않는다 (한도 초과가 풀리면 바로 복구되도록)
      res.setHeader("Cache-Control", "no-store");
      return res.status(up.status).json({ error: data.reason ?? `Open-Meteo HTTP ${up.status}` });
    }
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1800");
    return res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: `Open-Meteo 연결 실패: ${e.message}` });
  }
};
