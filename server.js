import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { USDAService } from "./USDA.js";

/* =========================================================
   CONFIG
========================================================= */
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const usda = new USDAService(process.env.USDA_API_KEY);
const APP_VERSION = process.env.APP_VERSION || "2.0.0";
const APP_NAME = "NutriGreen AI";
const START_TIME = Date.now();

const MAX_JSON_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024); // 8MB, allows base64 images
const BODY_READ_TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS || 15000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 90);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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

/* =========================================================
   LOGGING
========================================================= */
const recentLogs = [];
const MAX_RECENT_LOGS = 200;

function logEvent(level, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) recentLogs.shift();
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const logger = {
  info: (message, meta) => logEvent("info", message, meta),
  warn: (message, meta) => logEvent("warn", message, meta),
  error: (message, meta) => logEvent("error", message, meta)
};

/* =========================================================
   METRICS
========================================================= */
class MetricsStore {
  constructor() {
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.endpoints = new Map();
    this.geminiFailures = 0;
    this.usdaFailures = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.rateLimited = 0;
  }

  recordRequest(method, path, status, durationMs) {
    this.totalRequests += 1;
    if (status >= 400) this.totalErrors += 1;
    const key = `${method} ${path}`;
    const stat = this.endpoints.get(key) || { count: 0, errors: 0, totalDurationMs: 0 };
    stat.count += 1;
    if (status >= 400) stat.errors += 1;
    stat.totalDurationMs += durationMs;
    this.endpoints.set(key, stat);
  }

  recordGeminiFailure() {
    this.geminiFailures += 1;
  }

  recordUsdaFailure() {
    this.usdaFailures += 1;
  }

  recordCacheHit() {
    this.cacheHits += 1;
  }

  recordCacheMiss() {
    this.cacheMisses += 1;
  }

  recordRateLimited() {
    this.rateLimited += 1;
  }

  snapshot() {
    const endpoints = {};
    for (const [key, stat] of this.endpoints) {
      endpoints[key] = {
        count: stat.count,
        errors: stat.errors,
        avgDurationMs: stat.count ? Number((stat.totalDurationMs / stat.count).toFixed(2)) : 0
      };
    }
    return {
      uptimeMs: Date.now() - this.startedAt,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      rateLimited: this.rateLimited,
      geminiFailures: this.geminiFailures,
      usdaFailures: this.usdaFailures,
      cache: { hits: this.cacheHits, misses: this.cacheMisses },
      endpoints
    };
  }
}

const metrics = new MetricsStore();

/* =========================================================
   SIMPLE IN-MEMORY TTL CACHE (generic reuse helper)
========================================================= */
class TTLCache {
  constructor(ttlMs = 60000, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
    this.store.set(key, { createdAt: Date.now(), value });
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

const mealPlanCache = new TTLCache(10 * 60 * 1000, 200);
const imageAnalysisCache = new TTLCache(60 * 60 * 1000, 200);
const inFlightGemini = new Map();

function hashPayload(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex");
}

/* =========================================================
   RATE LIMITING
========================================================= */
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: this.max - 1 };
    }
    entry.count += 1;
    if (entry.count > this.max) {
      return { allowed: false, remaining: 0, retryAfterMs: this.windowMs - (now - entry.windowStart) };
    }
    return { allowed: true, remaining: this.max - entry.count };
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart > this.windowMs * 2) this.hits.delete(key);
    }
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);
const rateLimiterSweepTimer = setInterval(() => rateLimiter.sweep(), RATE_LIMIT_WINDOW_MS);
rateLimiterSweepTimer.unref?.();

/* =========================================================
   ERRORS & VALIDATION
========================================================= */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function badRequest(message) {
  return new HttpError(400, message);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${field} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function requireNumber(value, field, { min, max } = {}) {
  if (value === undefined || value === null || value === "") {
    throw badRequest(`${field} is required and must be a valid number.`);
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw badRequest(`${field} must be a valid number.`);
  }
  if (min !== undefined && num < min) {
    throw badRequest(`${field} must be at least ${min}.`);
  }
  if (max !== undefined && num > max) {
    throw badRequest(`${field} must be at most ${max}.`);
  }
  return num;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array.`);
  }
  return value;
}

function sanitizeText(value = "") {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 5000);
}

/* =========================================================
   ASYNC HELPERS: timeout + retry
========================================================= */
async function withTimeout(taskFactory, timeoutMs, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([taskFactory(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, { retries = 2, baseDelayMs = 300, isRetryable = () => true, onRetry } = {}) {
  let attempt = 0;
  let lastError;
  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) throw error;
      const delay = baseDelayMs * 2 ** attempt;
      onRetry?.(error, attempt, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
  throw lastError;
}

/* =========================================================
   HTTP RESPONSE HELPERS
========================================================= */
function resolveAllowedOrigin(req) {
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0] || "*";
}

function applyCorsHeaders(res, req) {
  res.setHeader("access-control-allow-origin", resolveAllowedOrigin(req));
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,x-session-id");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "origin");
}

function applySecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("cross-origin-resource-policy", "same-site");
}

function json(res, req, status, body) {
  applyCorsHeaders(res, req);
  applySecurityHeaders(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* =========================================================
   BODY PARSING (size limit + timeout + safe JSON parse)
========================================================= */
async function readJson(req, { maxBytes = MAX_JSON_BODY_BYTES, timeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  return withTimeout(async () => {
    let raw = "";
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        throw new HttpError(413, "Request body exceeds the allowed size.");
      }
      raw += chunk;
    }
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Request body must be valid JSON.");
    }
  }, timeoutMs, "Timed out while reading the request body.");
}

/* =========================================================
   DOMAIN DATA
========================================================= */
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

const KNOWN_ACTIVITY_LEVELS = new Set(["sedentary", "light", "moderate", "active", "extreme"]);
const KNOWN_GOALS = new Set(["fat_loss", "maintain", "muscle_gain", "lean_bulk"]);
const KNOWN_MEAL_MODES = new Set(["balanced", "high_protein", "low_carb", "vegetarian", "vegan"]);

/* =========================================================
   HEALTH / BMI / BMR / TDEE CALCULATIONS
========================================================= */
function calculateHealth(profile = {}) {
  const height = requireNumber(profile.heightCm, "heightCm", { min: 50, max: 260 });
  const weight = requireNumber(profile.weightKg, "weightKg", { min: 20, max: 400 });
  const age = requireNumber(profile.age, "age", { min: 5, max: 120 });

  const activityLevel = KNOWN_ACTIVITY_LEVELS.has(profile.activityLevel) ? profile.activityLevel : "moderate";
  const goal = KNOWN_GOALS.has(profile.goal) ? profile.goal : "maintain";

  const bmi = +(weight / (height / 100) ** 2).toFixed(1);
  const bmr = profile.gender === "female"
    ? 10 * weight + 6.25 * height - 5 * age - 161
    : 10 * weight + 6.25 * height - 5 * age + 5;

  const activityFactors = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, extreme: 1.9 };
  const goalMods = { fat_loss: -500, maintain: 0, muscle_gain: 300, lean_bulk: 200 };

  const tdee = Math.round(bmr * (activityFactors[activityLevel] || 1.55));
  const calories = Math.max(1200, tdee + (goalMods[goal] || 0));
  const protein = Math.round(weight * (goal === "muscle_gain" || goal === "lean_bulk" ? 2.2 : 1.8));
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

/* =========================================================
   GEMINI HELPERS
========================================================= */
function requireGemini() {
  if (!genai) {
    throw new HttpError(503, "AI is not configured. Set GEMINI_API_KEY in your .env file before starting the server.");
  }
  return genai;
}

function toGeminiContents(messages = []) {
  const contents = messages
    .map((message) => ({
      role: message.role === "assistant" || message.role === "model" ? "model" : "user",
      parts: [{ text: sanitizeText(String(message.content || "")) }]
    }))
    .filter((message) => message.parts[0].text.trim());

  while (contents[0]?.role === "model") contents.shift();
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Give me one practical Indian nutrition tip for today." }] }];
}

function getGeminiText(response) {
  const text = typeof response.text === "function" ? response.text() : response.text;
  if (!text || !String(text).trim()) {
    throw new HttpError(502, "Gemini returned an empty response.");
  }
  return String(text).trim();
}

function isRetryableGeminiError(error) {
  if (!(error instanceof HttpError)) return true;
  return error.status >= 500;
}

// Reusable Gemini text helper used by chat and meal planning.
// Supports timeout protection, exponential-backoff retries, request de-duplication,
// and optional TTL caching to avoid duplicate calls for identical prompts.
async function generateGeminiText({
  contents,
  systemInstruction,
  maxOutputTokens = 1000,
  temperature = 0.35,
  responseMimeType,
  responseJsonSchema,
  cacheKey,
  cache
}) {
  requireGemini();

  if (cacheKey && cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      metrics.recordCacheHit();
      return cached;
    }
    metrics.recordCacheMiss();
  }

  const dedupeKey = cacheKey ? `gemini:${cacheKey}` : null;
  if (dedupeKey && inFlightGemini.has(dedupeKey)) {
    return inFlightGemini.get(dedupeKey);
  }

  const run = () => withRetry(
    () => withTimeout(async () => {
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
    }, GEMINI_TIMEOUT_MS, "Gemini request timed out."),
    {
      retries: GEMINI_MAX_RETRIES,
      baseDelayMs: 400,
      isRetryable: isRetryableGeminiError,
      onRetry: (error, attempt, delay) => logger.warn("Gemini retry", { attempt: attempt + 1, delayMs: delay, error: error.message })
    }
  ).catch((error) => {
    metrics.recordGeminiFailure();
    logger.error("Gemini request failed", { error: error.message });
    throw error instanceof HttpError ? error : new HttpError(502, "Gemini request failed.");
  });

  const promise = run();
  if (dedupeKey) {
    inFlightGemini.set(dedupeKey, promise);
    promise.finally(() => inFlightGemini.delete(dedupeKey));
  }

  const result = await promise;
  if (cacheKey && cache) cache.set(cacheKey, result);
  return result;
}

// Reusable Gemini multimodal helper for base64 image analysis.
async function analyzeImageWithGemini({
  imageBase64,
  mediaType = "image/jpeg",
  prompt,
  systemInstruction,
  maxOutputTokens = 1000,
  responseJsonSchema,
  cacheKey,
  cache
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
    responseJsonSchema,
    cacheKey,
    cache
  });
}

/* =========================================================
   AI JSON PARSING / NORMALIZATION
========================================================= */
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

  throw new HttpError(502, "AI returned invalid JSON. Please try again.");
}

function normalizeMealPlan(plan) {
  if (!Array.isArray(plan)) {
    throw new HttpError(502, "Meal plan response was not a JSON array.");
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
    throw new HttpError(502, "Food analysis response was not a JSON object.");
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

/* =========================================================
   FOOD TEXT PARSING (quantities, units, fractions, aliases)
========================================================= */
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

const wordNumbers = {
  half: 0.5,
  quarter: 0.25,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6
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
  return String(value).toLowerCase().replace(/[^a-z0-9\s./]/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeUnit(token = "") {
  return Boolean(normalizeUnit(token));
}

function parseNumericToken(token = "") {
  if (wordNumbers[token] !== undefined) return wordNumbers[token];
  if (/^\d+\/\d+$/.test(token)) {
    const [num, den] = token.split("/").map(Number);
    return den ? num / den : null;
  }
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return null;
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

    const firstNumber = parseNumericToken(tokens[index]);
    if (firstNumber !== null) {
      quantity = firstNumber;
      index += 1;
      // Support mixed fractions like "1 1/2 cups milk".
      const secondNumber = parseNumericToken(tokens[index]);
      if (secondNumber !== null && secondNumber < 1) {
        quantity += secondNumber;
        index += 1;
      }
      if (looksLikeUnit(tokens[index])) {
        unit = normalizeUnit(tokens[index]);
        index += 1;
      }
    }

    const foodTokens = [];
    while (index < tokens.length && parseNumericToken(tokens[index]) === null) {
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
    } catch (error) {
      metrics.recordUsdaFailure();
      logger.warn("USDA lookup failed during food parsing", { food: segment.name, error: error.message });
      return { ...segment, confidence: 0, candidates: [] };
    }
  }));
  return { items };
}

/* =========================================================
   NUTRITION CALCULATIONS
========================================================= */
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
  return Number(Number(value || 0).toFixed(1));
}

async function calculateNutrition(foods = []) {
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  const breakdown = [];

  for (const food of foods) {
    let details;
    try {
      details = await usda.getFoodDetails(food.usdaId);
    } catch (error) {
      metrics.recordUsdaFailure();
      logger.warn("USDA detail lookup failed", { usdaId: food.usdaId, error: error.message });
      continue;
    }
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

/* =========================================================
   CHAT HISTORY (in-memory, per session)
========================================================= */
class ChatHistoryStore {
  constructor(maxSessions = 500, maxMessagesPerSession = 40) {
    this.maxSessions = maxSessions;
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.sessions = new Map();
  }

  append(sessionId, message) {
    if (!sessionId) return;
    if (!this.sessions.has(sessionId)) {
      if (this.sessions.size >= this.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        this.sessions.delete(oldestKey);
      }
      this.sessions.set(sessionId, []);
    }
    const list = this.sessions.get(sessionId);
    list.push({ ...message, timestamp: new Date().toISOString() });
    if (list.length > this.maxMessagesPerSession) list.splice(0, list.length - this.maxMessagesPerSession);
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || [];
  }

  clear(sessionId) {
    return this.sessions.delete(sessionId);
  }
}

const chatHistory = new ChatHistoryStore();

/* =========================================================
   ROUTE HANDLERS
========================================================= */
async function handleStatus(req, res) {
  return json(res, req, 200, { ok: true, aiConfigured: Boolean(genai), model: geminiModel });
}

async function handleHealthProfile(req, res) {
  const body = await readJson(req);
  return json(res, req, 200, calculateHealth(body.profile || body));
}

async function handleFoods(req, res) {
  return json(res, req, 200, { foods: indianFoods });
}

async function handleFoodParse(req, res) {
  const body = await readJson(req);
  const text = requireString(body.text, "text");
  try {
    return json(res, req, 200, await parseFoods(text));
  } catch (error) {
    logger.warn("Food parse fallback to empty result", { error: error.message });
    return json(res, req, 200, { items: [] });
  }
}

async function handleFoodNutrition(req, res) {
  const body = await readJson(req);
  const foods = requireArray(body.foods, "foods");
  if (!foods.length) throw badRequest("At least one food item is required.");
  foods.forEach((food, index) => {
    if (!food || typeof food !== "object") throw badRequest(`foods[${index}] must be an object.`);
    if (!food.usdaId) throw badRequest(`foods[${index}].usdaId is required.`);
  });
  return json(res, req, 200, await calculateNutrition(foods));
}

async function handleImageAnalyzeMock(req, res) {
  return json(res, req, 200, {
    items: [
      { name: "dosa", confidence: 0.9 },
      { name: "sambar", confidence: 0.88 }
    ]
  });
}

async function handleSearchFood(req, res) {
  const body = await readJson(req);
  const foodQuery = requireString(body.food, "food");
  const food = (await usda.searchFood(foodQuery))[0] || null;
  return json(res, req, 200, food);
}

async function handleFoodsSearch(req, res, url) {
  const query = requireString(url.searchParams.get("q") || "", "q");
  const matches = await usda.searchFood(query);
  const scored = matches
    .map((match) => ({ ...match, confidence: scoreMatch(query, match.name) }))
    .sort((a, b) => b.confidence - a.confidence);
  return json(res, req, 200, { query, results: scored });
}

async function handleNutritionEstimate(req, res) {
  const body = await readJson(req);
  const text = requireString(body.text, "text");
  const parsed = await parseFoods(text);
  const resolvable = parsed.items.filter((item) => item.usdaId);
  const nutrition = await calculateNutrition(resolvable);
  return json(res, req, 200, { items: parsed.items, ...nutrition });
}

async function handleMealPlan(req, res) {
  const body = await readJson(req);
  const mode = KNOWN_MEAL_MODES.has(body.mode) ? body.mode : "balanced";
  const profile = body.profile && typeof body.profile === "object" ? body.profile : {};
  const health = body.health && typeof body.health === "object" ? body.health : {};

  const systemInstruction = "You are an expert Indian nutritionist. Return only a valid JSON array of exactly four food plan objects for a full day. Each object must contain type, name, items, cal, protein, carbs, fats, fiber, and reason. Use neutral timeline labels such as Morning, Midday, Evening, and Later. Use numbers for nutrition fields.";
  const prompt = `Create a realistic but concise Indian ${mode} meal plan for this profile: ${JSON.stringify(profile)} and targets: ${JSON.stringify(health)}. Respect dietary preferences and keep estimates credible. Keep item names and reasons short. Return ONLY valid JSON. No markdown. No explanation.`;

  if (!genai) return json(res, req, 200, { source: "local", plan: localPlan(profile, health, mode) });

  const cacheKey = hashPayload({ prompt, mode });
  const text = await generateGeminiText({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction,
    maxOutputTokens: 4096,
    responseMimeType: "application/json",
    responseJsonSchema: mealPlanSchema,
    cacheKey,
    cache: mealPlanCache
  });
  return json(res, req, 200, { source: "ai", plan: normalizeMealPlan(parseAiJson(text, "array")) });
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const messages = body.messages ? requireArray(body.messages, "messages") : [];
  const sessionId = optionalString(req.headers["x-session-id"]) || optionalString(body.sessionId);
  const context = body.context && typeof body.context === "object" ? body.context : {};

  const systemInstruction = `You are NutriGreen AI, a concise Indian nutrition coach. Be practical, evidence-informed, and avoid medical diagnosis. Keep responses friendly and short. User context: ${JSON.stringify(context)}`;
  const contents = toGeminiContents(messages);
  const reply = await generateGeminiText({ contents, systemInstruction, maxOutputTokens: 900, temperature: 0.45 });

  if (sessionId) {
    const lastUserMessage = [...messages].reverse().find((message) => message.role !== "assistant" && message.role !== "model");
    if (lastUserMessage) chatHistory.append(sessionId, { role: "user", content: sanitizeText(String(lastUserMessage.content || "")) });
    chatHistory.append(sessionId, { role: "assistant", content: reply });
  }

  return json(res, req, 200, { reply });
}

async function handleChatHistoryGet(req, res, url) {
  const sessionId = requireString(url.searchParams.get("sessionId") || "", "sessionId");
  return json(res, req, 200, { sessionId, messages: chatHistory.get(sessionId) });
}

async function handleChatHistoryDelete(req, res, url) {
  const sessionId = requireString(url.searchParams.get("sessionId") || "", "sessionId");
  const removed = chatHistory.clear(sessionId);
  return json(res, req, 200, { sessionId, cleared: removed });
}

async function handleAnalyzeFoodImage(req, res) {
  const body = await readJson(req);
  const imageBase64 = requireString(body.imageBase64, "imageBase64");
  const mediaType = optionalString(body.mediaType, "image/jpeg");

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

  const cacheKey = hashPayload(`${mediaType}:${imageBase64.length}:${imageBase64.slice(0, 256)}`);
  const text = await analyzeImageWithGemini({
    imageBase64,
    mediaType,
    prompt,
    systemInstruction,
    maxOutputTokens: 1200,
    responseJsonSchema: foodAnalysisSchema,
    cacheKey,
    cache: imageAnalysisCache
  });
  return json(res, req, 200, { result: normalizeFoodAnalysis(parseAiJson(text, "object")) });
}

async function handleHealthcheck(req, res) {
  return json(res, req, 200, {
    status: "ok",
    uptimeMs: Date.now() - START_TIME,
    geminiConfigured: Boolean(genai),
    usdaConfigured: Boolean(usda.apiKey),
    timestamp: new Date().toISOString()
  });
}

async function handleVersion(req, res) {
  return json(res, req, 200, {
    name: APP_NAME,
    version: APP_VERSION,
    node: process.version,
    geminiModel
  });
}

async function handleMetrics(req, res) {
  return json(res, req, 200, metrics.snapshot());
}

async function handleCacheGet(req, res) {
  return json(res, req, 200, {
    mealPlanCache: mealPlanCache.size,
    imageAnalysisCache: imageAnalysisCache.size,
    usda: typeof usda.getStats === "function" ? usda.getStats() : undefined
  });
}

async function handleCacheDelete(req, res) {
  mealPlanCache.clear();
  imageAnalysisCache.clear();
  if (typeof usda.clearCache === "function") usda.clearCache();
  return json(res, req, 200, { cleared: true });
}

async function handleLogs(req, res, url) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
  return json(res, req, 200, { logs: recentLogs.slice(-limit) });
}

async function handleSystem(req, res) {
  return json(res, req, 200, {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memoryUsage: process.memoryUsage()
  });
}

/* =========================================================
   ROUTER
========================================================= */
const routes = [
  { method: "GET", path: "/api/status", handler: handleStatus },
  { method: "POST", path: "/api/health-profile", handler: handleHealthProfile },
  { method: "GET", path: "/api/foods", handler: handleFoods },
  { method: "POST", path: "/api/food/parse", handler: handleFoodParse },
  { method: "POST", path: "/api/food/nutrition", handler: handleFoodNutrition },
  { method: "POST", path: "/api/image/analyze", handler: handleImageAnalyzeMock },
  { method: "POST", path: "/api/search-food", handler: handleSearchFood },
  { method: "GET", path: "/api/foods/search", handler: handleFoodsSearch },
  { method: "POST", path: "/api/nutrition/estimate", handler: handleNutritionEstimate },
  { method: "POST", path: "/api/meal-plan", handler: handleMealPlan },
  { method: "POST", path: "/api/chat", handler: handleChat },
  { method: "GET", path: "/api/chat/history", handler: handleChatHistoryGet },
  { method: "DELETE", path: "/api/chat/history", handler: handleChatHistoryDelete },
  { method: "POST", path: "/api/analyze-food-image", handler: handleAnalyzeFoodImage },
  { method: "GET", path: "/api/healthcheck", handler: handleHealthcheck },
  { method: "GET", path: "/api/version", handler: handleVersion },
  { method: "GET", path: "/api/metrics", handler: handleMetrics },
  { method: "GET", path: "/api/cache", handler: handleCacheGet },
  { method: "DELETE", path: "/api/cache", handler: handleCacheDelete },
  { method: "GET", path: "/api/logs", handler: handleLogs },
  { method: "GET", path: "/api/system", handler: handleSystem }
];

const routeIndex = new Map(routes.map((route) => [`${route.method} ${route.path}`, route.handler]));

async function api(req, res, url) {
  try {
    if (req.method === "OPTIONS") return json(res, req, 204, {});

    const handler = routeIndex.get(`${req.method} ${url.pathname}`);
    if (!handler) return json(res, req, 404, { error: "Not found" });

    return await handler(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      logger.error("Unhandled API error", { path: url.pathname, method: req.method, error: error.message });
    }
    return json(res, req, status, { error: error.message || "Server error" });
  }
}

/* =========================================================
   STATIC FILE SERVING (with path traversal protection)
========================================================= */
async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname).replace(/\0/g, "");
  const safePath = normalize(decoded === "/" ? "/index.html" : decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    applyCorsHeaders(res, req);
    applySecurityHeaders(res);
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  applySecurityHeaders(res);
  const ext = extname(filePath);

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mime[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    res.end(file);
  } catch {
    const file = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-cache" });
    res.end(file);
  }
}

/* =========================================================
   SERVER BOOTSTRAP
========================================================= */
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

createServer((req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const clientIp = getClientIp(req);

  res.setHeader("x-request-id", requestId);

  const finish = (status) => {
    const durationMs = Date.now() - startedAt;
    metrics.recordRequest(req.method, url.pathname, status, durationMs);
    logger.info("request completed", {
      requestId,
      method: req.method,
      path: url.pathname,
      status,
      durationMs,
      ip: clientIp
    });
  };

  res.on("finish", () => finish(res.statusCode));

  const isApiRequest = url.pathname.startsWith("/api/");

  if (isApiRequest && req.method !== "OPTIONS") {
    const rate = rateLimiter.check(clientIp);
    if (!rate.allowed) {
      metrics.recordRateLimited();
      res.setHeader("retry-after", Math.ceil(rate.retryAfterMs / 1000));
      json(res, req, 429, { error: "Too many requests. Please slow down and try again shortly." });
      return;
    }
    res.setHeader("x-ratelimit-remaining", String(rate.remaining));
  }

  const handleRequest = async () => {
    if (isApiRequest) return api(req, res, url);
    return serveStatic(req, res, url.pathname);
  };

  withTimeout(handleRequest, REQUEST_TIMEOUT_MS, "Request timed out.")
    .catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status || 500;
      if (status >= 500) {
        logger.error("Unhandled request error", { path: url.pathname, method: req.method, error: error.message });
      }
      json(res, req, status, { error: error.message || "Server error" });
    });
}).listen(port, () => {
  logger.info("server started", { port, geminiConfigured: Boolean(genai), geminiModel });
  console.log(`${APP_NAME} running at http://localhost:${port}`);
  console.log(`AI backend: ${genai ? `Gemini configured (${geminiModel})` : "set GEMINI_API_KEY in .env to enable AI chat and image analysis"}`);
});