<div align="center">

# 🥗 NutriGreen AI

**An AI-powered nutrition and calorie tracking platform for Indian food, built with Node.js and the Google Gemini multimodal API.**

[![Live Demo](https://img.shields.io/badge/Live_Demo-nutrigreenai.pages.dev-16a34a?style=for-the-badge)](https://nutrigreenai.pages.dev/)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini_API-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)

</div>

---

## 📖 Overview

NutriGreen AI started as a simple calorie tracker and grew into a full-stack nutrition platform. Snap or upload a photo of an Indian dish and Gemini's vision model identifies the food, estimates calories and macros, and returns structured nutrition insights. The app also builds personalized meal plans and answers nutrition questions in a chat assistant.

## ✨ Features

| Feature | Description |
|---|---|
| 📷 **AI Food Image Analyzer** | Identifies a dish from a photo and estimates calories, protein, carbs, fats and fiber |
| 📝 **Smart Nutrition Tracking** | Manual food logging with serving-size scaling and daily progress visualization |
| 🧮 **Personalized Health Engine** | Calculates BMI, BMR and TDEE from age, height, weight and activity level, then sets calorie and macro targets |
| 🍛 **AI Meal Planning** | Plans for fat loss, muscle gain, lean bulking or maintenance; vegetarian, vegan, South Indian and North Indian styles |
| 💬 **Nutrition Chatbot** | Gemini-powered assistant for food recommendations, macro explanations and healthier swaps |
| 🎨 **Premium Dashboard UI** | Green glassmorphism design, animated charts, responsive on desktop and mobile |

## 🏗️ Architecture

```text
┌──────────────┐   Base64 image / JSON   ┌──────────────────┐   prompt + image   ┌──────────────┐
│   Frontend   │ ──────────────────────► │  Node.js REST API │ ─────────────────► │  Gemini API  │
│ HTML/CSS/JS  │ ◄────────────────────── │  validation layer │ ◄───────────────── │  (multimodal)│
└──────────────┘   validated JSON        └──────────────────┘   raw model output  └──────────────┘
```

**Frontend:** HTML5, CSS3, JavaScript (ES6+), glassmorphism UI, responsive layouts
**Backend & AI:** Node.js, REST API, Google Gemini API, Base64 image handling, prompt engineering, JSON validation

## 🧩 Engineering Challenges Solved

- Designed the frontend–backend communication layer from scratch
- Parsed and cleaned multimodal Gemini responses into reliable JSON
- Built an image upload → Base64 → API pipeline with async error handling
- Estimated nutrition for a wide range of Indian dishes
- Added structured JSON validation with fallback behavior when the model output is malformed
- Kept the AI integration modular across several endpoints

## 🚀 Getting Started

> Adjust these commands to match your `package.json` scripts.

```bash
# 1. Clone the repository
git clone https://github.com/barathraj0812/nutrigreenai.git
cd nutrigreenai

# 2. Install dependencies
npm install

# 3. Add your Gemini API key (never commit this file)
echo "GEMINI_API_KEY=your_key_here" > .env

# 4. Start the app
npm start
```

⚠️ Keep API keys in environment variables and out of the repository.

## 🗺️ Roadmap

- [ ] Weekly and monthly progress reports
- [ ] Barcode and packaged-food lookup
- [ ] More regional cuisines

## 🙋 Author

**Barath Raj M** · Class XI student developer, Chennai
[Portfolio](https://barath.pages.dev) · [GitHub](https://github.com/barathraj0812)

---

<div align="center">Built independently with ❤️ and Gemini</div>
