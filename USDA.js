const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------------------
   Utility: empty nutrients
---------------------------- */
function emptyNutrients() {
  return {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sugar: 0,
    sodium: 0
  };
}

/* ---------------------------
   Extract nutrient safely
---------------------------- */
function readNutrient(foodNutrients = [], names = []) {
  const wanted = names.map((n) => n.toLowerCase());

  const nutrient = foodNutrients.find((item) => {
    const name = String(item.nutrientName || item.nutrient?.name || "").toLowerCase();
    return wanted.some((target) => name === target || name.includes(target));
  });

  return Number(nutrient?.value ?? nutrient?.amount ?? 0) || 0;
}

/* ---------------------------
   Cache freshness check
---------------------------- */
function isFresh(entry) {
  return entry && Date.now() - entry.createdAt < DAY_MS;
}

/* ---------------------------
   USDA SERVICE
---------------------------- */
export class USDAService {
  constructor(apiKey = process.env.USDA_API_KEY) {
    this.apiKey = apiKey;

    this.cache = {
      search: new Map(),
      details: new Map()
    };
  }

  /* ---------------------------
     Base request handler
  ---------------------------- */
  async request(url) {
    if (!this.apiKey) {
      throw new Error("USDA_API_KEY missing in environment");
    }

    console.log("[USDA REQUEST]", url.toString());

    const response = await fetch(url);

    console.log("[USDA STATUS]", response.status);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`USDA request failed ${response.status}: ${text}`);
    }

    return response.json();
  }

  /* ---------------------------
     FOOD SEARCH (MAIN FIXED LOGIC)
  ---------------------------- */
  async searchFood(query) {
    const key = String(query || "").trim().toLowerCase();
    if (!key) return [];

    const cached = this.cache.search.get(key);
    if (cached && isFresh(cached)) return cached.value;

    try {
      const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
      url.searchParams.set("query", key);
      url.searchParams.set("pageSize", "10");
      url.searchParams.set("api_key", this.apiKey);

      const data = await this.request(url);

      console.log("[USDA SEARCH]", key);
      console.log("[USDA RESPONSE VALID?]", !!data?.foods);

      if (!data || !Array.isArray(data.foods)) {
        console.error("[USDA INVALID RESPONSE]", data);
        return [];
      }

      const result = data.foods
        .map((food) => ({
          id: String(food.fdcId),
          name: String(food.description || "").toLowerCase(),
          source: "usda"
        }))
        .filter((f) => f.id && f.name);

      this.cache.search.set(key, {
        createdAt: Date.now(),
        value: result
      });

      return result;
    } catch (err) {
      console.error("[USDA searchFood ERROR]", err.message);
      return [];
    }
  }

  /* ---------------------------
     FOOD DETAILS
  ---------------------------- */
  async getFoodDetails(foodId) {
    const key = String(foodId || "").trim();
    if (!key) return null;

    const cached = this.cache.details.get(key);
    if (cached && isFresh(cached)) return cached.value;

    try {
      const url = new URL(`https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(key)}`);
      url.searchParams.set("api_key", this.apiKey);

      const food = await this.request(url);
      if (!food) return null;

      const result = {
        id: String(food.fdcId || key),
        name: String(food.description || "food").toLowerCase(),
        nutrients: {
          ...emptyNutrients(),
          calories: readNutrient(food.foodNutrients, ["energy"]),
          protein: readNutrient(food.foodNutrients, ["protein"]),
          carbs: readNutrient(food.foodNutrients, ["carbohydrate"]),
          fat: readNutrient(food.foodNutrients, ["total lipid", "fat"]),
          fiber: readNutrient(food.foodNutrients, ["fiber"]),
          sugar: readNutrient(food.foodNutrients, ["sugars"]),
          sodium: readNutrient(food.foodNutrients, ["sodium"])
        }
      };

      this.cache.details.set(key, {
        createdAt: Date.now(),
        value: result
      });

      return result;
    } catch (err) {
      console.error("[USDA getFoodDetails ERROR]", err.message);
      return cached ? cached.value : null;
    }
  }
}

export default USDAService;