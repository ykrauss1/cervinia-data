const puppeteer = require("puppeteer-core");
const fs = require("fs");

// פונקציה לסגירת Cookiebot לפי טקסט (הכי אמין)
async function closeCookieBanner(page) {
  try {
    // מחכים שהבאנר יופיע
    await new Promise(resolve => setTimeout(resolve, 2000));

    // לוכדים את כל הכפתורים
    const buttons = await page.$$('button, a');

    for (const btn of buttons) {
      const text = await page.evaluate(el => el.innerText?.trim() || "", btn);
      const lower = text.toLowerCase();

      if (
        lower.includes("accept") ||
        lower.includes("allow") ||
        lower.includes("ok") ||
        lower.includes("agree")
      ) {
        await btn.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return;
      }
    }
  } catch (e) {
    // אם לא הצליח — ממשיכים
  }
}

// =========================
// HOME PAGE
// =========================
async function scrapeHomePage(page) {
  await page.goto("https://www.cervinia.it/en", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  await closeCookieBanner(page);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const html = await page.content();
  fs.writeFileSync("home.html", html);

  return {};
}

// =========================
// METEO PAGE
// =========================
async function scrapeMeteoPage(page) {
  await page.goto("https://www.cervinia.it/en/meteo", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  await closeCookieBanner(page);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const html = await page.content();
  fs.writeFileSync("meteo.html", html);

  return {};
}

// =========================
// WEBCAMS PAGE
// =========================
async function scrapeWebcamsPage(page) {
  await page.goto("https://www.cervinia.it/en/webcam", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  await closeCookieBanner(page);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const html = await page.content();
  fs.writeFileSync("webcams.html", html);

  return [];
}

// =========================
// MAIN
// =========================
async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  await scrapeHomePage(page);
  await scrapeMeteoPage(page);
  await scrapeWebcamsPage(page);

  console.log("Scraping completed.");

  await browser.close();
}

main().catch(err => {
  console.error("Scraping failed:", err);
  process.exit(1);
});
