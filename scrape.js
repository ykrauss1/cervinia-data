const fs = require("fs");
const puppeteer = require("puppeteer");

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // --- חלק 1: עמוד ראשי ---
    await page.goto("https://www.cervinia.it/en", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await page.waitForSelector(".home-highlights", { timeout: 30000 });

    const homeData = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".home-highlights .highlight-item")];

      const weather = items[0]?.querySelector(".value")?.innerText.trim() || null;
      const lifts = items[1]?.querySelector(".value")?.innerText.trim() || null;
      const slopes = items[2]?.querySelector(".value")?.innerText.trim() || null;

      return { weather, lifts, slopes };
    });

    // --- חלק 2: עמוד תחזית ---
    await page.goto("https://www.cervinia.it/en/meteo", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // עומקי שלג
    const snowDepth = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".snow-report table tr")];
      return rows.map(r => r.innerText.trim());
    });

    // תחזית
    const forecast = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".weather-forecast .forecast-day")];
      return items.map(i => i.innerText.trim());
    });

    // מצלמות
    const cameras = await page.evaluate(() => {
      const frames = [...document.querySelectorAll(".webcam-item iframe")];
      return frames.map(f => f.src);
    });

    // חיבור לצ'רמט
    const zermattConnection = await page.evaluate(() => {
      const el = document.querySelector(".connection .status");
      return el ? el.innerText.trim() : null;
    });

    // --- בניית האובייקט הסופי ---
    const data = {
      weather: homeData.weather,
      lifts: homeData.lifts,
      slopes: homeData.slopes,
      snowDepth,
      forecast,
      cameras,
      zermattConnection,
      last_update: new Date().toISOString()
    };

    // לוודא שהתיקייה קיימת
    if (!fs.existsSync("data")) {
      fs.mkdirSync("data");
    }

    fs.writeFileSync("data/data.json", JSON.stringify(data, null, 2));
    await browser.close();
    console.log("Scraping completed successfully.");

  } catch (err) {
    console.error("Scraping failed:", err);
    process.exit(1);
  }
})();
