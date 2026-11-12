"use strict";
// Vercel 서버리스 함수: Gemini function calling 에이전트
// 흐름: 사용자 질문 -> Gemini가 도구 선택(get_weather / find_spots) -> 서버가 실행 -> 결과를 Gemini에 전달 -> 최종 추천 답변
const { declarations, runTool } = require("./_lib/tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_ROUNDS = 5;       // 도구 호출 왕복 최대 횟수
const MAX_MESSAGES = 12;    // 클라이언트가 보낸 대화 이력 최대 개수
const MAX_CHARS = 600;      // 메시지 1개 최대 길이

const SYSTEM = `너는 한국 여행·나들이 추천 어시스턴트다. 두 개의 도구를 사용할 수 있다.
- get_weather: 지역의 실시간 날씨, 오늘~모레 예보, 미세먼지를 조회한다.
- find_spots: 지역 주변의 장소(관광지, 공원·자연, 해변, 박물관, 실내 명소, 카페, 식당)를 검색한다.

규칙:
1. 날씨·옷차림·미세먼지 질문에는 get_weather를 호출한다.
2. 장소·코스·맛집 추천 질문에는 먼저 get_weather로 날씨를 확인하고, 그 조건에 맞는 category로 find_spots를 호출한다.
   (예: 비·눈·미세먼지 나쁨 -> indoor/museum/cafe, 맑고 미세먼지 좋음 -> attraction/nature/beach)
   사용자가 장소 종류를 말하지 않았더라도 되묻지 말고, 날씨에 맞춰 네가 category를 직접 골라 곧바로 find_spots를 호출한다.
   find_spots는 한 번의 답변에서 최대 2번까지만 호출한다(서로 다른 category 2개까지 가능). 되묻기는 지역을 전혀 알 수 없을 때만 한다.
3. 도구가 필요 없는 일반 대화에는 도구를 호출하지 않는다.
4. 장소 이름은 반드시 find_spots 결과에 있는 것만 추천한다. 결과에 없는 장소를 지어내지 않는다.
5. 도구가 error를 반환하면 사실대로 알리고, 가능하면 지역명이나 조건을 바꿔 한 번 더 시도한다.
6. 답변은 한국어로, 간결하게. 추천 이유에 날씨 수치(기온, 강수확률, PM10 등급)를 근거로 든다.
7. 미세먼지는 모델 예측값이라 실측과 다를 수 있음을 필요할 때만 짧게 언급한다.`;

// ---- 간단한 인스턴스 단위 요청 제한 (남용 방지, 서버리스 특성상 완전하지는 않음) ----
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k);
  return arr.length > 20;
}

// Gemini 일시 과부하(503)는 잠깐 뒤 한 번 재시도한다. 429(한도 초과)는 재시도해도 소용없어 그대로 알린다.
async function callGemini(apiKey, contents, allowTools) {
  try {
    return await callGeminiOnce(apiKey, contents, allowTools);
  } catch (e) {
    if (e.status !== 503) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return callGeminiOnce(apiKey, contents, allowTools);
  }
}

async function callGeminiOnce(apiKey, contents, allowTools) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: allowTools ? "AUTO" : "NONE" } },
      generationConfig: { temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(40000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return data;
}

function friendlyError(e) {
  if (e.name === "TimeoutError") return "응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  if (e.status === 429) return "Gemini API 요청 한도를 초과했습니다(무료 키는 분당 요청 수가 적습니다). 1분 정도 뒤에 다시 시도해 주세요.";
  if (e.status === 503) return "Gemini 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.";
  if (e.status === 400 && /API key/i.test(e.message)) return "Gemini API 키가 올바르지 않습니다. Vercel 환경변수 GEMINI_API_KEY를 확인하세요.";
  if (e.status === 404) return `Gemini 모델(${MODEL})을 찾을 수 없습니다. 환경변수 GEMINI_MODEL을 확인하세요.`;
  return `AI 호출 중 오류가 발생했습니다: ${e.message}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST 요청만 지원합니다." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });

  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });

  // ---- 입력 검증 ----
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  const clean = msgs
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content.slice(0, MAX_CHARS) }] }));
  while (clean.length && clean[0].role !== "user") clean.shift(); // 첫 메시지는 user여야 함
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return res.status(400).json({ error: "messages의 마지막 항목은 user 메시지여야 합니다." });
  }

  const contents = clean;
  const toolCalls = [];
  let spots = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1; // 마지막 라운드는 도구 호출 금지 -> 반드시 텍스트 답변
      const data = await callGemini(apiKey, contents, !last);
      const content = data.candidates?.[0]?.content;
      const parts = content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall).slice(0, 4);

      if (!calls.length) {
        const reply = parts.map((p) => p.text).filter(Boolean).join("").trim();
        return res.status(200).json({
          reply: reply || "죄송합니다, 답변을 만들지 못했습니다. 질문을 조금 바꿔서 다시 시도해 주세요.",
          toolCalls,
          spots,
        });
      }

      // 모델의 도구 호출 턴을 그대로 이력에 추가 (thought signature 보존을 위해 원본 그대로)
      contents.push({ role: "model", parts: content.parts });

      const results = await Promise.all(calls.map(async (p) => {
        const { name, args } = p.functionCall;
        toolCalls.push({ name, args: args ?? {} });
        const result = await runTool(name, args);
        // 여러 번 호출한 find_spots 결과를 누적(이름 중복 제거, 최대 12곳)해 지도에 모두 표시
        if (name === "find_spots" && Array.isArray(result.spots)) {
          const names = new Set(spots.map((s) => s.name));
          spots = [...spots, ...result.spots.filter((s) => !names.has(s.name))].slice(0, 12);
        }
        return { functionResponse: { name, response: { result } } };
      }));
      contents.push({ role: "user", parts: results });
    }
    return res.status(200).json({ reply: "답변을 완성하지 못했습니다. 다시 시도해 주세요.", toolCalls, spots });
  } catch (e) {
    console.error("chat error:", e.message);
    return res.status(502).json({ error: friendlyError(e) });
  }
};
