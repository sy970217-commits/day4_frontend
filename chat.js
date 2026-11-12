// AI 추천 탭: /api/chat (Vercel 서버리스, Gemini function calling) 호출
const tabBtns = { weather: document.getElementById("tabbtn-weather"), chat: document.getElementById("tabbtn-chat") };
const tabPanes = { weather: document.getElementById("tab-weather"), chat: document.getElementById("tab-chat") };

function showTab(name) {
  for (const k of Object.keys(tabPanes)) {
    tabPanes[k].hidden = k !== name;
    tabBtns[k].setAttribute("aria-selected", String(k === name));
  }
}
window.showTab = showTab; // app.js(지도 마커 클릭)에서 사용
tabBtns.weather.addEventListener("click", () => showTab("weather"));
tabBtns.chat.addEventListener("click", () => { showTab("chat"); document.getElementById("chat-input").focus(); });

const logEl = document.getElementById("chat-log");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const sendEl = document.getElementById("chat-send");
const exEl = document.getElementById("chat-examples");

const history = []; // [{role: "user"|"assistant", content}]
let busy = false;

function addMsg(role, text, cls = "") {
  const el = document.createElement("div");
  el.className = `msg ${role} ${cls}`.trim();
  el.textContent = text; // textContent: AI 응답을 HTML로 해석하지 않음
  logEl.append(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

// 에이전트가 어떤 도구를 골랐는지 보여준다 (function calling 결과)
function addToolChips(toolCalls) {
  if (!toolCalls?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "tools";
  for (const t of toolCalls) {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    const args = Object.entries(t.args ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
    chip.textContent = `🔧 ${t.name}(${args})`;
    wrap.append(chip);
  }
  logEl.append(wrap);
}

async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendEl.disabled = true;
  exEl.hidden = true;
  addMsg("user", text);
  history.push({ role: "user", content: text });
  const pending = addMsg("bot", "생각하는 중… (도구를 선택하고 있어요)", "pending");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-10) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    pending.remove();
    addToolChips(data.toolCalls);
    addMsg("bot", data.reply);
    history.push({ role: "assistant", content: data.reply });
    if (data.spots?.length) showSpots(data.spots); // find_spots 결과를 지도에 표시
  } catch (err) {
    pending.remove();
    addMsg("bot", `⚠️ ${err.message}`, "error");
    history.pop(); // 실패한 질문은 이력에서 제거
  } finally {
    busy = false;
    sendEl.disabled = false;
    inputEl.focus();
    logEl.scrollTop = logEl.scrollHeight;
  }
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = inputEl.value;
  inputEl.value = "";
  ask(v);
});
exEl.addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") ask(e.target.textContent);
});
