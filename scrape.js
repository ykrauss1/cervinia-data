const fs = require("fs");
const puppeteer = require("puppeteer");

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto("https://www.cervinia.it/en/ski-area", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // מחכים שהעמוד ייטען ושהאלמנטים יהיו זמינים
    await page.waitForSelector(".lifts-status", { timeout: 30000 });
    await page.waitForSelector(".slopes-status", { timeout: 30000 });

    // מעליות
    const lifts = await page.evaluate(() => {
      const root = document.querySelector(".lifts-status");
      if (!root) return null;
      const open = root.querySelector(".open")?.innerText.trim();
      const total = root.querySelector(".total")?.innerText.trim();
      return { open, total };
    });

    // מסלולים
    const slopes = await page.evaluate(() => {
      const root = document.querySelector(".slopes-status");
      if (!root) return null;
      const open = root.querySelector(".open")?.innerText.trim();
      const total = root.querySelector(".total")?.innerText.trim();
      return { open, total };
    });

    // עומקי שלג
    const snowDepth = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".snow-table tr")];
      return rows.map(r => r.innerText.trim());
    });

    // תחזית
    const forecast = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".forecast-item")];
      return items.map(i => i.innerText.trim());
    });

    // מצלמות
    const cameras = await page.evaluate(() => {
      const frames = [...document.querySelectorAll("iframe")];
      return frames.map(f => f.src);
    });

    // קישור לצ'רמט
    const zermattConnection = await page.evaluate(() => {
      const el = document.querySelector(".connection-status");
      return el ? el.innerText.trim() : null;
    });

    const data = {
      lifts,
      slopes,
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
