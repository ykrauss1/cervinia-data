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

    // מזג אוויר / מעליות / מסלולים
    const homeData = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".home-highlights .highlight-item")];

      const weather = items[0]?.querySelector(".value")?.innerText.trim() || null;
      const lifts = items[1]?.querySelector(".value")?.innerText.trim() || null;
      const slopes = items[2]?.querySelector(".value")?.innerText.trim() || null;

      return { weather, lifts, slopes };
    });

    // חיבור לצ'רמט
    const zermattConnection = await page.evaluate(() => {
      const el = document.querySelector(".connection .status");
      return el ? el.innerText.trim() : null;
    });

    // --- חלק 2: עמוד תחזית ---
    await page.goto("https://www.cervinia.it/en/meteo", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // עומקי שלג
    const snowDepth = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("table.DD2Zg tbody tr")];

      return rows.map(r => {
        const cells = r.querySelectorAll("td");
        return {
          location: cells[0]?.innerText.trim() || null,
          snow: cells[1]?.innerText.trim() || null,
          lastSnowfall: cells[2]?.innerText.trim() || null
        };
      });
    });

    // תחזית Breuil‑Cervinia
    const forecast = await page.evaluate(() => {
      const stations = [...document.querySelectorAll(".euR2V")];

      const breuil = stations.find(st => {
        const name = st.querySelector("p.size-20")?.innerText || "";
        return name.includes("Breuil");
      });

      if (!breuil) return null;

      const name = breuil.querySelector("p.size-20")?.innerText.trim() || null;
      const elevation = breuil.querySelector("p.size-16")?.innerText.trim() || null;

      const rows = [...breuil.querySelectorAll("table tr")];
      const data = rows.map(r => {
        const key = r.querySelector("td p.dark-grey")?.innerText.trim() || null;
        const value = r.querySelector("td:nth-child(2) p")?.innerText.trim() || null;
        return { key, value };
      });

      const updated = breuil.querySelector("p.size-14")?.innerText.trim() || null;

      return { name, elevation, data, updated };
    });

    // תחזית ימים הבאים
    const dailyForecast = await page.evaluate(() => {
      const days = [...document.querySelectorAll(".grid__col")];

      return days.map(day => {
        const date = day.querySelector("p.size-25")?.innerText.trim() || null;
        if (!date) return null;

        const parts = [...day.querySelectorAll(".s8COa")].map(part => {
          const label = part.querySelector("span.demi.size-18")?.innerText.trim() || null;
          const hours = part.querySelector("span.dark-grey.size-16")?.innerText.trim() || null;
          const icon = part.querySelector("svg use")?.getAttribute("xlink:href") || null;

          return { label, hours, icon };
        });

        return { date, parts };
      }).filter(Boolean);
    });

    // תחזית מפולות
    const avalanche = await page.evaluate(() => {
      const root = document.querySelector(".kpCCY");
      if (!root) return null;

      const level = root.querySelector("span.anpIX")?.innerText.trim() || null;
      const description = root.querySelector("span.size-20")?.innerText.trim() || null;

      return { level, description };
    });

    // מצלמות
    const cameras = await page.evaluate(() => {
      const slides = [...document.querySelectorAll(".swiper-slide")];

      return slides.map(slide => {
        const iframe = slide.querySelector("iframe");
        const name = slide.querySelector("p.size-16")?.innerText.trim() || null;

        return {
          name,
          src: iframe ? iframe.src : null
        };
      });
    });

    // --- בניית האובייקט הסופי ---
    const data = {
      weather: homeData.weather,
      lifts: homeData.lifts,
      slopes: homeData.slopes,
      zermattConnection,
      snowDepth,
      forecast,
      dailyForecast,
      avalanche,
      cameras,
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
