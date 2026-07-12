const API = "https://nutrigreenai.onrender.com";

const ACTIVITY_LEVELS = [
  ["sedentary", "Sedentary", "Little movement"],
  ["light", "Light", "Training 1-3 days"],
  ["moderate", "Moderate", "Training 3-5 days"],
  ["active", "Active", "Training most days"],
  ["extreme", "Athlete", "Hard training plus active work"]
];

const GOALS = [
  ["fat_loss", "Fat loss"],
  ["maintain", "Maintain"],
  ["muscle_gain", "Muscle gain"],
  ["lean_bulk", "Lean bulk"]
];

const DIETS = [
  ["veg", "Vegetarian"],
  ["nonveg", "Non-vegetarian"],
  ["vegan", "Vegan"],
  ["south_indian", "South Indian"],
  ["north_indian", "North Indian"],
  ["high_protein", "High protein"],
  ["low_carb", "Low carb"]
];

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
};

let state = {
  page: "dashboard",
  profile: store.get("ng_profile", null),
  health: store.get("ng_health", null),
  foodLog: store.get("ng_food_log", []),
  parsedFoods: [],
  aiConfigured: false,
  toast: ""
};

const app = document.querySelector("#app");

function leafIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.5 4.5c-7.8.2-13.4 3.8-15.9 10.6 4.5 1.3 8.4.4 11.5-2.7-1.8 3.4-4.6 5.7-8.4 6.9" stroke="white" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function money(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

async function request(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showToast(message) {
  state.toast = message;
  render();
  setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

function totals() {
  return state.foodLog.reduce(
    (acc, item) => {
      acc.cal += Number(item.cal || 0);
      acc.protein += Number(item.protein || 0);
      acc.carbs += Number(item.carbs || 0);
      acc.fats += Number(item.fats || 0);
      acc.fiber += Number(item.fiber || 0);
      return acc;
    },
    { cal: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 }
  );
}

function setPage(page) {
  state.page = page;
  render();
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function addFood(item) {
  const entry = {
    ...item,
    id: crypto.randomUUID(),
    time: item.time || new Date().toISOString()
  };
  state.foodLog = [entry, ...state.foodLog];
  store.set("ng_food_log", state.foodLog);
  showToast(`${entry.displayName || entry.name} added`);
}

function removeFood(id) {
  state.foodLog = state.foodLog.filter((item) => item.id !== id);
  store.set("ng_food_log", state.foodLog);
  render();
}

function shell(content) {
  const nav = [
    ["dashboard", "Dashboard"],
    ["tracker", "Tracker"],
    ["analyzer", "Analyzer"],
    ["planner", "Meal Plan"],
    ["chat", "AI Coach"],
    ["progress", "Progress"]
  ];
  return `
    <div class="app-shell">
      <div class="background-media"></div>
      ${state.toast ? `<div class="toast">${state.toast}</div>` : ""}
      <header class="topbar">
        <div class="brand"><span class="brand-mark">${leafIcon()}</span><span>NutriGreen AI</span></div>
        ${state.profile ? `<nav class="nav-tabs">${nav.map(([id, label]) => `<button class="nav-tab ${state.page === id ? "active" : ""}" data-page="${id}">${label}</button>`).join("")}</nav>` : ""}
        ${state.profile ? `<button class="btn" data-reset>Reset</button>` : `<span class="muted">Premium nutrition intelligence</span>`}
      </header>
      ${content}
    </div>
  `;
}

function onboarding() {
  return shell(`
    <main class="page hero">
      <section class="hero-copy">
        <p class="section-kicker">AI nutrition platform</p>
        <h1>NutriGreen AI</h1>
        <p>Personal calorie targets, Indian food intelligence, AI meal planning, photo analysis, macros, and progress signals in one polished health dashboard.</p>
        <div class="stats-grid" style="margin-top:22px">
          <div class="stat card"><small>Food focus</small><strong>Indian</strong><span class="muted">Regional meals and realistic portions</span></div>
          <div class="stat card"><small>Backend</small><strong>Live</strong><span class="muted">AI calls route through localhost:3000</span></div>
          <div class="stat card"><small>Tracking</small><strong>Daily</strong><span class="muted">Calories, protein, carbs, fats, fiber</span></div>
          <div class="stat card"><small>AI</small><strong>${state.aiConfigured ? "Ready" : "Key"}</strong><span class="muted">${state.aiConfigured ? "Gemini key detected" : "Add GEMINI_API_KEY for vision and chat"}</span></div>
        </div>
      </section>
      <section class="card visual-panel">
        <div class="dish-visual" aria-label="Illustrated premium Indian nutrition bowl"></div>
        <form class="onboarding" id="profileForm">
          <p class="section-kicker">Build your profile</p>
          <div class="form-grid">
            ${field("name", "Name", "text", "Arjun Sharma")}
            ${field("age", "Age", "number", "28")}
            ${field("heightCm", "Height cm", "number", "174")}
            ${field("weightKg", "Weight kg", "number", "72")}
          </div>
          <div class="form-grid">
            <label class="field"><span>Gender</span><select class="select" name="gender"><option value="male">Male</option><option value="female">Female</option></select></label>
            <label class="field"><span>Activity</span><select class="select" name="activityLevel">${ACTIVITY_LEVELS.map(([id, label, desc]) => `<option value="${id}">${label} - ${desc}</option>`).join("")}</select></label>
          </div>
          <div class="field"><label>Goal</label><div class="chips">${GOALS.map(([id, label], i) => `<button type="button" class="chip ${i === 1 ? "selected" : ""}" data-choice="goal" data-value="${id}">${label}</button>`).join("")}</div></div>
          <div class="field"><label>Diet preferences</label><div class="chips">${DIETS.map(([id, label]) => `<button type="button" class="chip" data-choice="diet" data-value="${id}">${label}</button>`).join("")}</div></div>
          <input type="hidden" name="goal" value="maintain" />
          <button class="btn primary" style="width:100%;margin-top:8px">Enter Dashboard</button>
        </form>
      </section>
    </main>
  `);
}

function field(name, label, type, placeholder) {
  return `<label class="field"><span>${label}</span><input class="input" name="${name}" type="${type}" placeholder="${placeholder}" required /></label>`;
}

function dashboard() {
  const total = totals();
  const health = state.health;
  const calPct = health ? Math.round((total.cal / health.calories) * 100) : 0;
  return shell(`
    <main class="page">
      <header style="margin-bottom:20px">
        <p class="section-kicker">Today</p>
        <h1 class="page-title">Good ${new Date().getHours() < 17 ? "day" : "evening"}, ${state.profile.name.split(" ")[0]}</h1>
        <p class="page-sub">Your nutrition cockpit is ready. Log meals, analyze food photos, and generate Indian meal plans.</p>
      </header>
      <section class="dashboard-grid">
        <div class="card section">
          <span class="section-kicker">Calories today</span>
          <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin:8px 0 18px">
            <div><strong style="font-family:Syne,sans-serif;font-size:3.6rem">${money(total.cal)}</strong><span class="muted"> / ${money(health.calories)} kcal</span></div>
            <div style="color:${calPct > 100 ? "var(--rose)" : "var(--mint)"};font-weight:800">${calPct}%</div>
          </div>
          ${macro("Calories", total.cal, health.calories, "var(--green)")}
          ${macro("Protein", total.protein, health.protein, "var(--blue)", "g")}
          ${macro("Carbs", total.carbs, health.carbs, "var(--gold)", "g")}
          ${macro("Fats", total.fats, health.fats, "var(--rose)", "g")}
        </div>
        <div class="card section">
          <span class="section-kicker">Latest food log</span>
          ${state.foodLog.length ? state.foodLog.slice(0, 3).map((item) => `
            <div class="timeline-mini">
              <strong>${formatTime(item.time)}</strong>
              <span>${escapeHtml(item.displayName || item.name)}</span>
              <small>${money(item.cal)} kcal · P ${item.protein || 0}g</small>
            </div>
          `).join("") : `<p class="muted" style="margin-top:10px">No foods logged yet. Add a food to start the timeline.</p>`}
          <button class="btn primary" data-page="tracker" style="margin-top:14px;width:100%">Smart log food</button>
        </div>
      </section>
      <section class="stats-grid" style="margin-top:18px">
        ${stat("BMI", health.bmi, health.bmiCategory)}
        ${stat("BMR", health.bmr, "kcal/day")}
        ${stat("TDEE", health.tdee, "kcal/day")}
        ${stat("Fiber", health.fiber, "g/day")}
      </section>
      <section class="meal-grid" style="margin-top:18px">
        ${["tracker", "analyzer", "planner", "chat"].map((page) => `<button class="card stat" data-page="${page}" style="text-align:left"><small>${page === "tracker" ? "Log meals" : page === "analyzer" ? "Scan food" : page === "planner" ? "Create plan" : "Ask coach"}</small><strong>${page[0].toUpperCase() + page.slice(1)}</strong><span class="muted">Open ${page}</span></button>`).join("")}
      </section>
    </main>
  `);
}

function macro(label, cur, max, color, unit = "") {
  const pct = max ? Math.min((cur / max) * 100, 100) : 0;
  return `<div class="macro-row"><span>${label}</span><div class="bar"><span style="--w:${pct}%;--c:${color}"></span></div><small class="muted">${money(cur)}/${money(max)}${unit}</small></div>`;
}

function stat(label, value, note) {
  return `<div class="stat card"><small>${label}</small><strong>${value}</strong><span class="muted">${note}</span></div>`;
}

function tracker() {
  const total = totals();
  const latest = state.foodLog;
  return shell(`
    <main class="page">
      <h1 class="page-title">Smart Food Timeline</h1>
      <p class="page-sub">${money(total.cal)} kcal consumed today. Enter a full meal line, confirm matches, and NutriGreen calculates nutrition on the backend.</p>
      <section class="card section smart-log-panel" style="margin:18px 0">
        <form id="smartFoodForm" class="smart-food-form">
          <label class="field"><span>Meal text</span><input class="input" name="text" id="foodText" placeholder="2 dosa 250 ml milk 1 banana" autocomplete="off" required /></label>
          <button class="btn primary">Parse Foods</button>
        </form>
        <div id="nutritionPreview" class="nutrition-preview">${parsedFoodsMarkup()}</div>
      </section>
      <section class="card section" style="margin:18px 0">
        ${macro("Calories", total.cal, state.health.calories, "var(--green)")}
        ${macro("Protein", total.protein, state.health.protein, "var(--blue)", "g")}
        ${macro("Carbs", total.carbs, state.health.carbs, "var(--gold)", "g")}
        ${macro("Fats", total.fats, state.health.fats, "var(--rose)", "g")}
      </section>
      <section class="timeline-list">
        ${latest.length ? latest.map((item) => foodTimelineItem(item)).join("") : `<div class="card section"><p class="muted">No timeline entries yet. Try “2 dosa”, “250ml milk”, or “100g paneer”.</p></div>`}
      </section>
    </main>
  `);
}

function parsedFoodsMarkup() {
  if (!state.parsedFoods.length) {
    return `
      <div class="preview-empty">
        <span class="section-kicker">Food confirmation</span>
        <p class="muted">Parse a meal line to confirm USDA food matches before nutrition is calculated.</p>
      </div>
    `;
  }

  const allReady = state.parsedFoods.every((item) => item.selectedUsdaId);
  return `
    <div class="parsed-foods">
      ${state.parsedFoods.map((item, index) => `
        <div class="food-row">
          <div>
            <strong>${escapeHtml(item.quantity)} ${escapeHtml(item.unit)} ${escapeHtml(item.name)}</strong>
            <small class="muted">Confidence ${Math.round(Number(item.confidence || 0) * 100)}%</small>
          </div>
          <select class="select" data-food-candidate="${index}">
            <option value="">Select USDA match</option>
            ${(item.candidates || []).map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${item.selectedUsdaId === candidate.id ? "selected" : ""}>${escapeHtml(candidate.name)}</option>`).join("")}
          </select>
        </div>
      `).join("")}
      <div class="actions">
        <button class="btn primary" data-calc-nutrition ${allReady ? "" : "disabled"}>Calculate & Log</button>
      </div>
    </div>
  `;
}

function foodTimelineItem(item) {
  return `
    <article class="card timeline-item">
      <div class="timeline-time">${formatTime(item.time)}</div>
      <div class="timeline-content">
        <div class="meal-head">
          <div>
            <strong>${escapeHtml(item.displayName || item.name)}</strong>
            <span class="muted"> · ${money(item.cal)} kcal</span>
          </div>
          <button class="icon-button" data-remove-food="${item.id}" title="Remove">x</button>
        </div>
        <div class="chips" style="margin-top:10px">
          <span class="chip selected">P ${item.protein || 0}g</span>
          <span class="chip">C ${item.carbs || 0}g</span>
          <span class="chip">F ${item.fats || 0}g</span>
          <span class="chip">Fiber ${item.fiber || 0}g</span>
        </div>
      </div>
    </article>
  `;
}

function analyzer() {
  return shell(`
    <main class="page">
      <h1 class="page-title">AI Food Analyzer</h1>
      <p class="page-sub">Upload a real food photo. The browser converts it to an image payload and the backend sends it to the AI vision endpoint.</p>
      <section class="card section">
        <div class="upload-zone" id="uploadZone">
          <div>
            <h2 style="font-family:Syne,sans-serif">Drop or choose a food photo</h2>
            <p class="muted">${state.aiConfigured ? "AI vision is configured." : "AI vision needs GEMINI_API_KEY on the backend."}</p>
            <button class="btn primary" id="chooseImage">Choose image</button>
            <input id="imageInput" type="file" accept="image/*" hidden />
          </div>
        </div>
        <div id="analysisResult" style="margin-top:18px"></div>
      </section>
    </main>
  `);
}

function planner() {
  return shell(`
    <main class="page">
      <h1 class="page-title">AI Meal Planner</h1>
      <p class="page-sub">Generate a profile-aware Indian meal plan. Without an API key, the backend uses its local Indian nutrition database instead of fake AI.</p>
      <section class="card section">
        <div class="chips" style="margin-bottom:14px">${["balanced", "high_protein", "south_indian", "budget"].map((mode, i) => `<button class="chip ${i === 0 ? "selected" : ""}" data-plan-mode="${mode}">${mode.replace("_", " ")}</button>`).join("")}</div>
        <button class="btn primary" id="generatePlan">Generate meal plan</button>
        <div id="planResult" class="meal-grid" style="margin-top:18px"></div>
      </section>
    </main>
  `);
}

function chat() {
  const messages = store.get("ng_chat", [{ role: "assistant", content: `Hi ${state.profile.name.split(" ")[0]}. I am your nutrition coach. Ask me about Indian meals, calories, protein, or planning.` }]);
  return shell(`
    <main class="page">
      <h1 class="page-title">AI Nutrition Coach</h1>
      <p class="page-sub">Server-side AI chat with your profile context.</p>
      <section class="card chat">
        <div class="messages" id="messages">${messages.map((m) => `<div class="bubble ${m.role}">${escapeHtml(m.content)}</div>`).join("")}</div>
        <form class="chat-form" id="chatForm">
          <input class="input" name="message" placeholder="Ask for a meal idea, macro tip, or Indian protein source" autocomplete="off" />
          <button class="btn primary">Send</button>
        </form>
      </section>
    </main>
  `);
}

function progress() {
  const total = totals();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const vals = days.map((day, index) => ({ day, val: index === 3 ? total.cal : Math.round(state.health.calories * (0.72 + index * 0.04)) }));
  const max = Math.max(...vals.map((d) => d.val), 1);
  return shell(`
    <main class="page">
      <h1 class="page-title">Progress</h1>
      <p class="page-sub">A calm snapshot of your nutrition consistency.</p>
      <section class="card section">
        <span class="section-kicker">Weekly calories</span>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:end;height:210px;margin-top:22px">
          ${vals.map((d) => `<div><div style="height:${(d.val / max) * 170}px;background:linear-gradient(to top,#22c55e,#86efac);border-radius:8px 8px 0 0"></div><small class="muted">${d.day}</small></div>`).join("")}
        </div>
      </section>
      <section class="stats-grid" style="margin-top:18px">
        ${stat("Calories", total.cal, `Goal ${state.health.calories}`)}
        ${stat("Protein", `${total.protein}g`, `Goal ${state.health.protein}g`)}
        ${stat("Foods", state.foodLog.length, "Logged today")}
        ${stat("Fiber", `${total.fiber}g`, `Goal ${state.health.fiber}g`)}
      </section>
    </main>
  `);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function render() {
  if (!state.profile || !state.health) app.innerHTML = onboarding();
  else if (state.page === "tracker") app.innerHTML = tracker();
  else if (state.page === "analyzer") app.innerHTML = analyzer();
  else if (state.page === "planner") app.innerHTML = planner();
  else if (state.page === "chat") app.innerHTML = chat();
  else if (state.page === "progress") app.innerHTML = progress();
  else app.innerHTML = dashboard();
  bind();
}

function bind() {
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    localStorage.clear();
    state.profile = null;
    state.health = null;
    state.page = "dashboard";
    render();
  });
  document.querySelectorAll("[data-choice='goal']").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-choice='goal']").forEach((b) => b.classList.remove("selected"));
    button.classList.add("selected");
    document.querySelector("input[name='goal']").value = button.dataset.value;
  }));
  document.querySelectorAll("[data-choice='diet']").forEach((button) => button.addEventListener("click", () => button.classList.toggle("selected")));
  document.querySelector("#profileForm")?.addEventListener("submit", saveProfile);
  bindSmartFoodForm();
  document.querySelectorAll("[data-remove-food]").forEach((button) => button.addEventListener("click", () => removeFood(button.dataset.removeFood)));
  bindAnalyzer();
  bindPlanner();
  bindChat();
}

function bindSmartFoodForm() {
  const form = document.querySelector("#smartFoodForm");
  if (!form) return;
  const preview = document.querySelector("#nutritionPreview");
  document.querySelectorAll("[data-food-candidate]").forEach((select) => select.addEventListener("change", () => {
    const index = Number(select.dataset.foodCandidate);
    state.parsedFoods[index].selectedUsdaId = select.value;
    preview.innerHTML = parsedFoodsMarkup();
    bindSmartFoodForm();
  }));
  document.querySelector("[data-calc-nutrition]")?.addEventListener("click", calculateAndLogFoods);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    preview.innerHTML = `<div style="display:grid;place-items:center;padding:22px"><div class="loader"></div><p class="muted">Finding USDA matches...</p></div>`;
    try {
      const parsed = await request("/api/food/parse", { method: "POST", body: JSON.stringify({ text: data.text }) });
      state.parsedFoods = (parsed.items || []).map((item) => ({
        ...item,
        selectedUsdaId: item.usdaId || ((item.candidates || []).length === 1 && item.confidence >= 0.75 ? item.candidates[0].id : "")
      }));
      preview.innerHTML = parsedFoodsMarkup();
      bindSmartFoodForm();
      if (!state.parsedFoods.length) showToast("No foods found");
    } catch (error) {
      preview.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  });
}

async function calculateAndLogFoods() {
  const foods = state.parsedFoods.map((item) => ({
    usdaId: item.selectedUsdaId,
    quantity: item.quantity,
    unit: item.unit
  }));
  if (foods.some((food) => !food.usdaId)) {
    showToast("Select every food match first");
    return;
  }

  try {
    const data = await request("/api/food/nutrition", { method: "POST", body: JSON.stringify({ foods }) });
    (data.breakdown || []).forEach((item) => addFood({
      name: item.name,
      displayName: item.name,
      cal: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fats: item.fat,
      fiber: item.fiber,
      sugar: item.sugar,
      sodium: item.sodium,
      source: "usda"
    }));
    state.parsedFoods = [];
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.dietPref = [...document.querySelectorAll("[data-choice='diet'].selected")].map((b) => b.dataset.value);
  try {
    const health = await request("/api/health-profile", { method: "POST", body: JSON.stringify({ profile: data }) });
    state.profile = data;
    state.health = health;
    store.set("ng_profile", data);
    store.set("ng_health", health);
    showToast("Profile created");
  } catch (error) {
    showToast(error.message);
  }
}

function bindAnalyzer() {
  const input = document.querySelector("#imageInput");
  const choose = document.querySelector("#chooseImage");
  const zone = document.querySelector("#uploadZone");
  if (!input || !choose || !zone) return;
  choose.addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && analyzeFile(input.files[0]));
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.style.background = "rgba(34,197,94,.12)";
  });
  zone.addEventListener("dragleave", () => {
    zone.style.background = "";
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.style.background = "";
    const file = event.dataTransfer.files[0];
    if (file?.type.startsWith("image/")) analyzeFile(file);
  });
}

async function analyzeFile(file) {
  const result = document.querySelector("#analysisResult");
  const dataUrl = await toDataUrl(file);
  result.innerHTML = `<img class="preview" src="${dataUrl}" alt="Uploaded food" /><div style="display:grid;place-items:center;padding:28px"><div class="loader"></div><p class="muted">Analyzing food image...</p></div>`;
  try {
    const imageBase64 = dataUrl.split(",")[1];
    const data = await request("/api/analyze-food-image", { method: "POST", body: JSON.stringify({ imageBase64, mediaType: file.type }) });
    const food = data.result;
    result.innerHTML = `<img class="preview" src="${dataUrl}" alt="Uploaded food" /><div class="card section" style="margin-top:14px;box-shadow:none"><span class="section-kicker">AI result</span><h2 style="font-family:Syne,sans-serif">${food.name}</h2><p class="muted">Confidence ${food.confidence}% - ${food.servingSize}</p><div class="result-grid">${stat("Calories", food.calories, "kcal")}${stat("Protein", `${food.protein}g`, "estimated")}${stat("Carbs", `${food.carbs}g`, "estimated")}${stat("Fats", `${food.fats}g`, "estimated")}</div><p class="muted">${food.benefits || ""}</p><div class="actions"><button class="btn primary" data-log-ai>Log to timeline</button></div></div>`;
    document.querySelector("[data-log-ai]")?.addEventListener("click", () => addFood({ name: food.name, displayName: food.name, cal: food.calories, protein: food.protein, carbs: food.carbs, fats: food.fats, fiber: food.fiber || 0, source: "ai image" }));
  } catch (error) {
    result.innerHTML = `<div class="card section error" style="box-shadow:none">${escapeHtml(error.message)}</div>`;
  }
}

function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bindPlanner() {
  const generate = document.querySelector("#generatePlan");
  if (!generate) return;
  let mode = "balanced";
  document.querySelectorAll("[data-plan-mode]").forEach((button) => button.addEventListener("click", () => {
    mode = button.dataset.planMode;
    document.querySelectorAll("[data-plan-mode]").forEach((b) => b.classList.remove("selected"));
    button.classList.add("selected");
  }));
  generate.addEventListener("click", async () => {
    const output = document.querySelector("#planResult");
    output.innerHTML = `<div class="card section" style="display:grid;place-items:center;min-height:180px;box-shadow:none"><div class="loader"></div></div>`;
    try {
      const data = await request("/api/meal-plan", { method: "POST", body: JSON.stringify({ profile: state.profile, health: state.health, mode }) });
      output.innerHTML = data.plan.map((meal, index) => `<article class="card meal-card"><span class="section-kicker">${meal.type}</span><h3>${meal.name}</h3><p class="muted">${(meal.items || []).join(" - ")}</p><p class="muted">${meal.reason || ""}</p><div class="chips"><span class="chip selected">${meal.cal} kcal</span><span class="chip">${meal.protein}g protein</span><span class="chip">${meal.carbs}g carbs</span><span class="chip">${meal.fats}g fats</span></div><button class="btn primary" data-plan-log="${index}" style="margin-top:12px">Log to timeline</button></article>`).join("");
      document.querySelectorAll("[data-plan-log]").forEach((button) => button.addEventListener("click", () => {
        const meal = data.plan[Number(button.dataset.planLog)];
        addFood({ name: meal.name, displayName: meal.name, cal: meal.cal, protein: meal.protein, carbs: meal.carbs, fats: meal.fats, fiber: meal.fiber || 0, source: "ai meal plan" });
      }));
    } catch (error) {
      output.innerHTML = `<div class="card section error" style="box-shadow:none">${escapeHtml(error.message)}</div>`;
    }
  });
}

function bindChat() {
  const form = document.querySelector("#chatForm");
  if (!form) return;
  const box = document.querySelector("#messages");
  box.scrollTop = box.scrollHeight;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = form.elements.message;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const messages = store.get("ng_chat", []);
    messages.push({ role: "user", content: text });
    store.set("ng_chat", messages);
    box.insertAdjacentHTML("beforeend", `<div class="bubble user">${escapeHtml(text)}</div><div class="bubble assistant" id="thinking">Thinking...</div>`);
    box.scrollTop = box.scrollHeight;
    try {
      const data = await request("/api/chat", { method: "POST", body: JSON.stringify({ messages: messages.slice(-8), context: { profile: state.profile, health: state.health } }) });
      document.querySelector("#thinking")?.remove();
      messages.push({ role: "assistant", content: data.reply });
      store.set("ng_chat", messages);
      box.insertAdjacentHTML("beforeend", `<div class="bubble assistant">${escapeHtml(data.reply)}</div>`);
    } catch (error) {
      document.querySelector("#thinking").textContent = error.message;
    }
  });
}

async function boot() {
  try {
    const status = await request("/api/status");
    state.aiConfigured = status.aiConfigured;
  } catch {
    state.aiConfigured = false;
  }
  render();
}

boot();
