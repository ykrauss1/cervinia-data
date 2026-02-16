const puppeteer = require("puppeteer-core");

async function scrapeHomePage(page) {
  await page.goto("https://www.cervinia.it/en", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  // נותן ל-Nuxt עוד רגע להיטען
  await page.waitForTimeout(3000);

  return await page.evaluate(() => {
    const textOf = el => (el ? el.textContent.trim() : null);
    const numOf = el => (el ? parseFloat(el.textContent.replace(/[^\d.-]/g, "")) : null);

    // 🔵 פס עליון – נתונים כלליים
    const topBar = document.querySelector("div._4ruBB") || document.body;
    const spans = Array.from(topBar.querySelectorAll("span"));

    const findBlock = label =>
      spans.find(s => s.textContent.trim().toLowerCase() === label.toLowerCase())?.closest("a,div");

    const liftsGlobalBlock = findBlock("lifts");
    const slopesGlobalBlock = findBlock("slopes");

    const globalLiftsOpen = numOf(liftsGlobalBlock?.querySelector(".edagF, .size-25"));
    const globalLiftsTotal = numOf(
      liftsGlobalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    const globalSlopesOpen = numOf(slopesGlobalBlock?.querySelector(".edagF, .size-25"));
    const globalSlopesTotal = numOf(
      slopesGlobalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    const tempGlobalSpan = spans.find(s =>
      /\-?\d+(\.\d+)?\s*°C?/i.test(s.textContent)
    );
    const globalTemperature = numOf(tempGlobalSpan);

    // Zermatt link
    const zermattLabel = spans.find(s =>
      s.textContent.trim().toLowerCase().includes("zermatt link")
    );
    let zermattLinkStatus = null;
    if (zermattLabel) {
      const container = zermattLabel.closest("div");
      const statusSpan = container?.querySelector("span.U4QfZ, span.demi, span.size-14");
      zermattLinkStatus = textOf(statusSpan)?.toLowerCase() || null;
    }

    // 🟢 עיגולים – נתונים מקומיים (Cervinia)
    const circlesContainer = Array.from(document.querySelectorAll("div.SBMhl, div.CyBEa")).length
      ? document
      : document;

    const findLocalBlock = label =>
      Array.from(circlesContainer.querySelectorAll("div.CyBEa, div.grid__col")).find(block =>
        Array.from(block.querySelectorAll("span")).some(
          s => s.textContent.trim().toLowerCase() === label.toLowerCase()
        )
      );

    const liftsLocalBlock = findLocalBlock("Open ski lifts");
    const slopesLocalBlock = findLocalBlock("Open slopes");

    const localLiftsOpen = numOf(
      liftsLocalBlock?.querySelector(".size-25.secondary, .size-25")
    );
    const localLiftsTotal = numOf(
      liftsLocalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    const localSlopesOpen = numOf(
      slopesLocalBlock?.querySelector(".size-25.secondary, .size-25")
    );
    const localSlopesTotal = numOf(
      slopesLocalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    // טמפרטורה מקומית – נשתמש באותה טמפרטורה אם אין אחרת
    const localTemperature = globalTemperature;

    return {
      global: {
        lifts: { open: globalLiftsOpen, total: globalLiftsTotal },
        slopes: { open: globalSlopesOpen, total: globalSlopesTotal },
        temperature: globalTemperature,
        zermattLink:
          zermattLinkStatus === "closed"
            ? "closed"
            : zermattLinkStatus === "open"
            ? "open"
            : zermattLinkStatus
      },
      cervinia: {
        lifts: { open: localLiftsOpen, total: localLiftsTotal },
        slopes: { open: localSlopesOpen, total: localSlopesTotal },
        temperature: localTemperature
      }
    };
  });
}

async function scrapeMeteoPage(page) {
  await page.goto("https://www.cervinia.it/en/meteo", {
    waitUntil: "networkidle0",
    timeout: 120000
  });
  await page.waitForTimeout(3000);

  return await page.evaluate(() => {
    const textOf = el => (el ? el.textContent.trim() : null);
    const numOf = el => (el ? parseFloat(el.textContent.replace(/[^\d.-]/g, "")) : null);

    const bodyText = document.body.innerText;

    // דוגמה כללית – תתאים לפי מה שאתה רואה ב-HTML של /meteo
    const snow = {
      baseDepthCm: null,
      freshSnowCm: null,
      quality: null
    };

    const snowDepthMatch = bodyText.match(/Snow depth\s*:?[\s\n]*([\d.,]+)\s*cm/i);
    if (snowDepthMatch) snow.baseDepthCm = parseFloat(snowDepthMatch[1].replace(",", "."));

    const freshSnowMatch = bodyText.match(/Fresh snow\s*:?[\s\n]*([\d.,]+)\s*cm/i);
    if (freshSnowMatch) snow.freshSnowCm = parseFloat(freshSnowMatch[1].replace(",", "."));

    const qualityMatch = bodyText.match(/Snow quality\s*:?[\s\n]*([A-Za-z ]+)/i);
    if (qualityMatch) snow.quality = qualityMatch[1].trim();

    const weatherNow = {
      windSpeedKmh: null,
      windDirection: null,
      visibilityM: null
    };

    const windMatch = bodyText.match(/Wind\s*:?[\s\n]*([\d.,]+)\s*km\/h/i);
    if (windMatch) weatherNow.windSpeedKmh = parseFloat(windMatch[1].replace(",", "."));

    const windDirMatch = bodyText.match(/Wind direction\s*:?[\s\n]*([A-Z]{1,3})/i);
    if (windDirMatch) weatherNow.windDirection = windDirMatch[1];

    const visMatch = bodyText.match(/Visibility\s*:?[\s\n]*([\d.,]+)\s*m/i);
    if (visMatch) weatherNow.visibilityM = parseFloat(visMatch[1].replace(",", "."));

    // תחזית – נתחיל פשוט: נשלוף בלוקים עם תאריכים וטמפ'
    const forecast = [];
    const forecastBlocks = Array.from(
      document.querySelectorAll("div.forecast, li.forecast, .meteo-forecast")
    );
    for (const block of forecastBlocks) {
      const t = block.innerText;
      const dateMatch = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      const minMatch = t.match(/min\s*:?[\s\n]*(-?\d+)/i);
      const maxMatch = t.match(/max\s*:?[\s\n]*(-?\d+)/i);
      if (!dateMatch) continue;
      forecast.push({
        raw: t.trim(),
        date: dateMatch[1],
        min: minMatch ? parseInt(minMatch[1], 10) : null,
        max: maxMatch ? parseInt(maxMatch[1], 10) : null
      });
    }

    return {
      snow,
      weather: {
        now: weatherNow,
        forecast
      }
    };
  });
}

async function scrapeWebcamsPage(page) {
  await page.goto("https://www.cervinia.it/en/webcam", {
    waitUntil: "networkidle0",
    timeout: 120000
  });
  await page.waitForTimeout(3000);

  return await page.evaluate(() => {
    const webcams = [];
    const cards = document.querySelectorAll("a, article, .webcam, .webcam-card");

    for (const el of cards) {
      const img = el.querySelector("img");
      const titleEl =
        el.querySelector("h2, h3, .title, .webcam-name") ||
        (img && img.getAttribute("alt") ? { textContent: img.getAttribute("alt") } : null);

      if (!img || !titleEl) continue;

      webcams.push({
        name: titleEl.textContent.trim(),
        image: img.src,
        url: el.href || null
      });
    }

    return webcams;
  });
}

async function main() {
  const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--proxy-server=http://geo.iproyal.com:12321"
  ],
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome"
});

const page = await browser.newPage();

await page.authenticate({
  username: "4tf5u0SPrsDfvmCQ",
  password: "wxKRgWoNwUsaGgV0"
});

  */

  const home = await scrapeHomePage(page);
  const meteo = await scrapeMeteoPage(page);
  const webcams = await scrapeWebcamsPage(page);

  const result = {
    updatedAt: new Date().toISOString(),
    global: home.global,
    cervinia: home.cervinia,
    snow: meteo.snow,
    weather: meteo.weather,
    webcams
  };

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error("Scraping failed:", err);
  process.exit(1);
});
