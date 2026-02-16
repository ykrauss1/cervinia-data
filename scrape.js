const puppeteer = require("puppeteer-core");
const fs = require("fs");

// פונקציה לסגירת Cookiebot (תופסת את כל הכפתורים האפשריים)
async function closeCookieBanner(page) {
  const selectors = [
    '#CybotCookiebotDialogBodyButtonAccept',
    '#CybotCookiebotDialogBodyButtonAcceptAll',
    '#CybotCookiebotDialogBodyButtonAcceptOnlyNecessary',
    'button[aria-label="Allow all"]',
    'button[aria-label="Accept all"]',
    '.CybotCookiebotDialogBodyButtonAccept',
    '.CybotCookiebotDialogBodyButtonAcceptAll'
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      await page.click(sel);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    } catch (e) {
      // ממשיכים לנסות selector אחר
    }
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
