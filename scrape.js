const puppeteer = require("puppeteer-core");
const fs = require("fs");

// פונקציה לסגירת Cookiebot
async function closeCookieBanner(page) {
  try {
    await page.waitForSelector('#CybotCookiebotDialogBodyButtonAccept', { timeout: 5000 });
    await page.click('#CybotCookiebotDialogBodyButtonAccept');
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (e) {
    // אם לא הופיע — ממשיכים
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
