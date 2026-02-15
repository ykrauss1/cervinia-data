const fs = require("fs");
const puppeteer = require("puppeteer");

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // --- הגדרות כדי לעקוף חסימות של האתר ---
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    await page.setViewport({ width: 1366, height: 768 });

    // --- חלק 1: עמוד ראשי ---
    await page.goto("https://www.cervinia.it/en", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 60000 });

    // בדיקה אם Cloudflare חסם
    const html1 = await page.content();
    if (html1.includes("cf-browser-verification") || html1.includes("Cloudflare")) {
      console.log("Blocked by Cloudflare on homepage, retrying...");
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForTimeout(3000);
    }

    // המתנה נוספת לטעינת JS
    await page.waitForTimeout(3000);

    // retry אם האלמנט לא נטען
    try {
      await page.waitForSelector(".home-highlights", { timeout: 60000 });
    } catch (e) {
      console.log("Retrying homepage load...");
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForTimeout(3000);
      await page.waitForSelector(".home-highlights", { timeout: 60000 });
    }

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

    //
