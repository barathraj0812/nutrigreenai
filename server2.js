import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { USDAService } from "./USDA.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const usda = new USDAService(process.env.USDA_API_KEY);

// The Gemini client is initialized once and shared by all AI endpoints.
// Keeping this in one place makes future model/provider changes small.
const genai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const indianFoods = [
  { name: "Idli with sambar", region: "South Indian", diet: "vegetarian", cal: 310, protein: 11, carbs: 55, fats: 5, fiber: 8 },
  { name: "Dosa with chutney", region: "South Indian", diet: "vegetarian", cal: 390, protein: 9, carbs: 62, fats: 12, fiber: 5 },
  { name: "Paneer bhurji roti", region: "North Indian", diet: "vegetarian", cal: 520, protein: 28, carbs: 48, fats: 24, fiber: 7 },
  { name: "Rajma chawal", region: "North Indian", diet: "vegetarian", cal: 560, protein: 20, carbs: 92, fats: 12, fiber: 16 },
  { name: "Chicken tikka bowl", region: "North Indian", diet: "non-vegetarian", cal: 610, protein: 46, carbs: 58, fats: 18, fiber: 9 },
  { name: "Egg bhurji with millet roti", region: "Indian", diet: "non-vegetarian", cal: 470, protein: 27, carbs: 42, fats: 21, fiber: 7 },
  { name: "Sprouts chaat", region: "Indian", diet: "vegan", cal: 260, protein: 16, carbs: 38, fats: 6, fiber: 12 },
  { name: "Curd rice with vegetables", region: "South Indian", diet: "vegetarian", cal: 430, protein: 15, carbs: 68, fats: 11, fiber: 6 },
  { name: "Tofu tikka quinoa bowl", region: "Fusion Indian", diet: "vegan", cal: 510, protein: 31, carbs: 58, fats: 17, fiber: 11 },
  { name: "Fish curry with red rice", region: "Coastal Indian", diet: "non-vegetarian", cal: 590, protein: 38, carbs: 64, fats: 19, fiber: 6 },
  { name: "Moong dal chilla", region: "Indian", diet: "vegetarian", cal: 340, protein: 22, carbs: 42, fats: 9, fiber: 10 },
  { name: "Soya chunk pulao", region: "Indian", diet: "vegetarian", cal: 540, protein: 34, carbs: 72, fats: 12, fiber: 9 }
];

const mealPlanSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string" },
      name: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      cal: { type: "number" },
      protein: { type: "number" },
      carbs: { type: "number" },
      fats: { type: "number" },
      fiber: { type: "number" },
      reason: { type: "string" }
    },
    required: ["type", "name", "items", "cal", "protein", "carbs", "fats", "fiber", "reason"]
  }
};

const foodAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    calories: { type: "number" },
    protein: { type: "number" },
    carbs: { type: "number" },
    fats: { type: "number" },
    fiber: { type: "number" },
    vitamins: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    servingSize: { type: "string" },
    benefits: { type: "string" }
  },
  required: ["name", "calories", "protein", "carbs", "fats", "fiber", "vitamins", "confidence", "servingSize", "benefits"]
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function calculateHealth(profile) {
  const height = Number(profile.heightCm);
  const weight = Number(profile.weightKg);
  const age = Number(profile.age);
  if (!height || !weight || !age) throw new Error("Age, height, and weight are required.");
  const bmi = +(weight / (height / 100) ** 2).toFixed(1);
  const bmr = profile.gender === "female"
    ? 10 * weight + 6.25 * height - 5 * age - 161
    : 10 * weight + 6.25 * height - 5 * age + 5;
  const activityFactors = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, extreme: 1.9 };
  const goalMods = { fat_loss: -500, maintain: 0, muscle_gain: 300, lean_bulk: 200 };
  const tdee = Math.round(bmr * (activityFactors[profile.activityLevel] || 1.55));
  const calories = Math.max(1200, tdee + (goalMods[profile.goal] || 0));
  const protein = Math.round(weight * (profile.goal === "muscle_gain" || profile.goal === "lean_bulk" ? 2.2 : 1.8));
  const fats = Math.round((calories * 0.25) / 9);
  const carbs = Math.round((calories - protein * 4 - fats * 9) / 4);
  return {
    bmi,
    bmiCategory: bmi < 18.5 ? "Underweight" : bmi < 25 ? "Normal" : bmi < 30 ? "Overweight" : "Obese",
    bmr: Math.round(bmr),
    tdee,
    calories,
    protein,
    carbs,
    fats,
    fiber: Math.round((calories / 1000) * 14)
  };
}

function requireGemini() {
  if (!genai) {
    const err = new Error("AI is not configured. Set GEMINI_API_KEY in your .env file before starting the server.");
    err.status = 503;
    throw err;
  }
  return genai;
}

function toGeminiContents(messages = []) {
  const contents = messages.map((message) => ({
    role: message.role === "assistant" || message.role === "model" ? "model" : "user",
    parts: [{ text: String(message.content || "") }]
  })).filter((message) => message.parts[0].text.trim());

  while (contents[0]?.role === "model") contents.shift();
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Give me one practical Indian nutrition tip for today." }] }];
}

function getGeminiText(response) {
  const text = typeof response.text === "function" ? response.text() : response.text;
  if (!text || !String(text).trim()) {
    const err = new Error("Gemini returned an empty response.");
    err.status = 502;
    throw err;
  }
  return String(text).trim();
}

// Reusable Gemini text helper used by chat and meal planning.
async function generateGeminiText({
  contents,
  systemInstruction,
  maxOutputTokens = 1000,
  temperature = 0.35,
  responseMimeType,
  responseJsonSchema
}) {
  const client = requireGemini();
  const response = await client.models.generateContent({
    model: geminiModel,
    contents,
    config: {
      systemInstruction,
      maxOutputTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },
      ...(responseMimeType ? { responseMimeType } : {}),
      ...(responseJsonSchema ? { responseJsonSchema } : {})
    }
  });
  return getGeminiText(response);
}

// Reusable Gemini multimodal helper for base64 image analysis.
async function analyzeImageWithGemini({
  imageBase64,
  mediaType = "image/jpeg",
  prompt,
  systemInstruction,
  maxOutputTokens = 1000,
  responseJsonSchema
}) {
  const contents = [{
    role: "user",
    parts: [
      { inlineData: { mimeType: mediaType, data: imageBase64 } },
      { text: prompt }
    ]
  }];

  return generateGeminiText({
    contents,
    systemInstruction,
    maxOutputTokens,
    temperature: 0.15,
    responseMimeType: "application/json",
    responseJsonSchema
  });
}

function extractBalancedJson(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === "\"") inString = !inString;
    if (inString) continue;
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

function parseAiJson(text, expected = "any") {
  const normalized = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [
    normalized,
    extractBalancedJson(normalized, "{", "}"),
    extractBalancedJson(normalized, "[", "]")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (expected === "array" && !Array.isArray(parsed)) continue;
      if (expected === "object" && (Array.isArray(parsed) || parsed === null || typeof parsed !== "object")) continue;
      return parsed;
    } catch {
      // Try the next cleaned candidate.
    }
  }

  const err = new Error("AI returned invalid JSON. Please try again.");
  err.status = 502;
  throw err;
}

function normalizeMealPlan(plan) {
  if (!Array.isArray(plan)) {
    const err = new Error("Meal plan response was not a JSON array.");
    err.status = 502;
    throw err;
  }

  return plan.slice(0, 4).map((meal, index) => ({
    type: String(meal.type || ["Morning", "Midday", "Evening", "Later"][index] || "Planned food"),
    name: String(meal.name || "Balanced Indian meal"),
    items: Array.isArray(meal.items) ? meal.items.map(String) : [],
    cal: Math.round(Number(meal.cal ?? meal.calories ?? 0)),
    protein: Math.round(Number(meal.protein ?? 0)),
    carbs: Math.round(Number(meal.carbs ?? 0)),
    fats: Math.round(Number(meal.fats ?? 0)),
    fiber: Math.round(Number(meal.fiber ?? 0)),
    reason: String(meal.reason || "Chosen to support the user's calorie, macro, and dietary goals.")
  }));
}

function normalizeFoodAnalysis(result) {
  if (!result || Array.isArray(result) || typeof result !== "object") {
    const err = new Error("Food analysis response was not a JSON object.");
    err.status = 502;
    throw err;
  }

  return {
    name: String(result.name || result.foodName || "Unknown food"),
    calories: Math.round(Number(result.calories ?? result.cal ?? 0)),
    protein: Math.round(Number(result.protein ?? 0)),
    carbs: Math.round(Number(result.carbs ?? 0)),
    fats: Math.round(Number(result.fats ?? 0)),
    fiber: Math.round(Number(result.fiber ?? 0)),
    vitamins: Array.isArray(result.vitamins) ? result.vitamins.map(String) : [],
    confidence: Math.max(0, Math.min(100, Math.round(Number(result.confidence ?? 0)))),
    servingSize: String(result.servingSize || result.serving_size || "1 serving"),
    benefits: String(result.benefits || "Estimated nutrition for a typical serving.")
  };
}

const unitAliases = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  ml: "ml",
  l: "l",
  liter: "l",
  litre: "l",
  piece: "piece",
  pieces: "piece",
  pc: "piece",
  pcs: "piece",
  serving: "serving",
  servings: "serving",
  bowl: "bowl",
  bowls: "bowl",
  plate: "plate",
  plates: "plate",
  cup: "cup",
  cups: "cup",
  glass: "glass",
  glasses: "glass"
};

const knownFoodUnits = new Map([
  ["dosa", "piece"],
  ["idli", "piece"],
  ["banana", "piece"],
  ["egg", "piece"],
  ["chapati", "piece"],
  ["roti", "piece"]
]);

const defaultServingGrams = {
  piece: 100,
  serving: 100,
  bowl: 200,
  plate: 300,
  cup: 240,
  glass: 250,
  dosa: 100,
  idli: 45,
  banana: 118,
  egg: 50,
  chapati: 40,
  roti: 40
};

function normalizeUnit(unit = "") {
  return unitAliases[String(unit).toLowerCase()] || "";
}

function normalizeFoodText(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeUnit(token = "") {
  return Boolean(normalizeUnit(token));
}

function tokenizeFoodText(text = "") {
  return normalizeFoodText(text).split(" ").filter(Boolean);
}

function parseFoodSegments(text = "") {
  const tokens = tokenizeFoodText(text);
  const segments = [];
  let index = 0;

  while (index < tokens.length) {
    const start = index;
    let quantity = 1;
    let unit = "";

    if (/^\d+(?:\.\d+)?$/.test(tokens[index])) {
      quantity = Number(tokens[index]);
      index += 1;
      if (looksLikeUnit(tokens[index])) {
        unit = normalizeUnit(tokens[index]);
        index += 1;
      }
    }

    const foodTokens = [];
    while (index < tokens.length && !/^\d+(?:\.\d+)?$/.test(tokens[index])) {
      foodTokens.push(tokens[index]);
      index += 1;
    }

    if (!foodTokens.length) {
      index += 1;
      continue;
    }

    const food = foodTokens.join(" ");
    const inferredUnit = unit || knownFoodUnits.get(food) || "piece";
    const normalizedQuantity = inferredUnit === "kg" || inferredUnit === "l" ? quantity * 1000 : quantity;
    const normalizedUnit = inferredUnit === "kg" ? "g" : inferredUnit === "l" ? "ml" : inferredUnit;

    segments.push({
      rawText: tokens.slice(start, index).join(" "),
      name: food,
      quantity: normalizedQuantity,
      unit: normalizedUnit
    });
  }

  return segments;
}

function scoreMatch(query, matchName) {
  const queryText = normalizeFoodText(query);
  const matchText = normalizeFoodText(matchName);
  if (!queryText || !matchText) return 0;
  if (queryText === matchText) return 0.98;
  const queryWords = new Set(queryText.split(" "));
  const matchWords = new Set(matchText.split(" "));
  const overlap = [...queryWords].filter((word) => matchWords.has(word)).length;
  if (matchText.includes(queryText) || queryText.includes(matchText)) return 0.82;
  if (overlap) return Math.max(0.5, Math.min(0.8, overlap / queryWords.size));
  return 0.45;
}

async function parseFoods(text = "") {
  const segments = parseFoodSegments(text);
  const items = await Promise.all(segments.map(async (segment) => {
    try {
      const matches = await usda.searchFood(segment.name);
      const scored = matches
        .map((match) => ({ ...match, confidence: scoreMatch(segment.name, match.name) }))
        .sort((a, b) => b.confidence - a.confidence);
      const best = scored[0];
      const confidence = Number((best?.confidence || 0).toFixed(2));
      const ambiguous = !best || confidence < 0.75 || scored.length > 1;
      return {
        rawText: segment.rawText,
        name: segment.name,
        quantity: segment.quantity,
        unit: segment.unit,
        confidence,
        usdaId: ambiguous ? undefined : best.id,
        candidates: ambiguous ? scored.slice(0, 3).map((match) => ({ name: match.name, id: match.id })) : [{ name: best.name, id: best.id }]
      };
    } catch {
      return { ...segment, confidence: 0, candidates: [] };
    }
  }));
  return { items };
}

function servingWeightFor(foodName = "", unit = "piece") {
  const normalized = normalizeFoodText(foodName);
  return defaultServingGrams[normalized] || defaultServingGrams[unit] || 100;
}

function nutrientScale({ quantity = 1, unit = "piece" }, details) {
  const qty = Number(quantity) || 1;
  if (unit === "g") return qty / 100;
  if (unit === "ml") return qty / 100;
  return (qty * servingWeightFor(details?.name, unit)) / 100;
}

function roundNutrient(value) {
  return Number((Number(value || 0)).toFixed(1));
}

async function calculateNutrition(foods = []) {
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  const breakdown = [];

  for (const food of foods) {
    const details = await usda.getFoodDetails(food.usdaId);
    if (!details) continue;
    const scale = nutrientScale(food, details);
    const item = {
      name: details.name,
      calories: roundNutrient(details.nutrients.calories * scale),
      protein: roundNutrient(details.nutrients.protein * scale),
      carbs: roundNutrient(details.nutrients.carbs * scale),
      fat: roundNutrient(details.nutrients.fat * scale),
      fiber: roundNutrient(details.nutrients.fiber * scale),
      sugar: roundNutrient(details.nutrients.sugar * scale),
      sodium: roundNutrient(details.nutrients.sodium * scale)
    };
    Object.keys(total).forEach((key) => {
      total[key] = roundNutrient(total[key] + item[key]);
    });
    breakdown.push(item);
  }

  return { total, breakdown };
}

function localPlan(profile = {}, health = {}, mode = "balanced") {
  const prefs = new Set(profile.dietPref || []);
  let pool = indianFoods.filter((food) => {
    if (prefs.has("vegan")) return food.diet === "vegan";
    if (prefs.has("veg")) return food.diet !== "non-vegetarian";
    if (prefs.has("south_indian")) return food.region.includes("South");
    if (prefs.has("north_indian")) return food.region.includes("North");
    return true;
  });
  if (mode === "high_protein") pool = [...pool].sort((a, b) => b.protein - a.protein);
  if (!pool.length) pool = indianFoods;
  const slots = ["Morning", "Midday", "Evening", "Later"];
  return slots.map((type, index) => {
    const base = pool[(index * 3) % pool.length];
    const snackScale = type === "Later" ? 0.55 : 1;
    return {
      type,
      name: base.name,
      items: [base.name, type === "Later" ? "fruit or chaas" : "salad"],
      cal: Math.round(base.cal * snackScale),
      protein: Math.round(base.protein * snackScale),
      carbs: Math.round(base.carbs * snackScale),
      fats: Math.round(base.fats * snackScale),
      fiber: Math.round(base.fiber * snackScale),
      reason: `Fits a ${mode.replace("_", " ")} Indian plan while keeping protein, fiber, and satiety in view.`
    };
  });
}

async function api(req, res, path) {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (path === "/api/status") return json(res, 200, { ok: true, aiConfigured: Boolean(genai), model: geminiModel });
    if (path === "/api/health-profile" && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, calculateHealth(body.profile || body));
    }
    if (path === "/api/foods" && req.method === "GET") return json(res, 200, { foods: indianFoods });
    if (path === "/api/food/parse" && req.method === "POST") {
      const body = await readJson(req);
      try {
        return json(res, 200, await parseFoods(body.text || ""));
      } catch {
        return json(res, 200, { items: [] });
      }
    }
    if (path === "/api/food/nutrition" && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await calculateNutrition(Array.isArray(body.foods) ? body.foods : []));
    }
    if (path === "/api/image/analyze" && req.method === "POST") {
      return json(res, 200, {
        items: [
          { name: "dosa", confidence: 0.9 },
          { name: "sambar", confidence: 0.88 }
        ]
      });
    }
    if (path === "/api/search-food" && req.method === "POST") {

    const body = await readJson(req);

    const food = (await usda.searchFood(body.food))[0] || null;

    return json(res, 200, food);

    }
    if (path === "/api/meal-plan" && req.method === "POST") {
      const body = await readJson(req);
      const systemInstruction = "You are an expert Indian nutritionist. Return only a valid JSON array of exactly four food plan objects for a full day. Each object must contain type, name, items, cal, protein, carbs, fats, fiber, and reason. Use neutral timeline labels such as Morning, Midday, Evening, and Later. Use numbers for nutrition fields.";
      const prompt = `Create a realistic but concise Indian ${body.mode || "balanced"} meal plan for this profile: ${JSON.stringify(body.profile)} and targets: ${JSON.stringify(body.health)}. Respect dietary preferences and keep estimates credible. Keep item names and reasons short. Return ONLY valid JSON. No markdown. No explanation.`;
      if (!genai) return json(res, 200, { source: "local", plan: localPlan(body.profile, body.health, body.mode) });
      const text = await generateGeminiText({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        responseJsonSchema: mealPlanSchema
      });
      return json(res, 200, { source: "ai", plan: normalizeMealPlan(parseAiJson(text, "array")) });
    }
    if (path === "/api/chat" && req.method === "POST") {
      const body = await readJson(req);
      const systemInstruction = `You are NutriGreen AI, a concise Indian nutrition coach. Be practical, evidence-informed, and avoid medical diagnosis. Keep responses friendly and short. User context: ${JSON.stringify(body.context || {})}`;
      const contents = toGeminiContents(body.messages || []);
      const reply = await generateGeminiText({ contents, systemInstruction, maxOutputTokens: 900, temperature: 0.45 });
      return json(res, 200, { reply });
    }
    if (path === "/api/analyze-food-image" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.imageBase64) return json(res, 400, { error: "imageBase64 is required." });
      const systemInstruction = "You are a nutrition vision analyst specializing in Indian food. Return only one valid JSON object with keys: name, calories, protein, carbs, fats, fiber, vitamins, confidence, servingSize, benefits. Use numbers for nutrition fields.";
      const prompt = `Identify the Indian food in this image.

Estimate:
- food name
- calories
- protein
- carbs
- fats
- fiber
- serving size
- vitamins
- confidence

Return ONLY valid JSON.
No markdown.
No explanation.`;
      const text = await analyzeImageWithGemini({
        imageBase64: body.imageBase64,
        mediaType: body.mediaType || "image/jpeg",
        prompt,
        systemInstruction,
        maxOutputTokens: 1200,
        responseJsonSchema: foodAnalysisSchema
      });
      return json(res, 200, { result: normalizeFoodAnalysis(parseAiJson(text, "object")) });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, error.status || 500, { error: error.message || "Server error" });
  }
}

async function serveStatic(req, res, path) {
  const safePath = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch {
    const file = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"] });
    res.end(file);
  }
}

createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
}).listen(port, () => {
  console.log(`NutriGreen AI running at http://localhost:${port}`);
  console.log(`AI backend: ${genai ? `Gemini configured (${geminiModel})` : "set GEMINI_API_KEY in .env to enable AI chat and image analysis"}`);
});
