const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--proxy-server=http://31.59.20.176:6754"
      ]
    });

    const page = await browser.newPage();

    await page.authenticate({
      username: "cbndvfbb",
      password: "mkflaz4onwbq"
    });

    console.log("Proxy connected. Loading homepage...");
    await page.goto("https://www.cervinia.it/en", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // בדיקה אם Cloudflare חסם
    if (await page.$("title") === null) {
      console.log("Blocked by Cloudflare on homepage, retrying...");
      await new Promise(r => setTimeout(r, 3000));
      await page.reload({ waitUntil: "domcontentloaded" });
    }

    // מחכים לאלמנט הראשי
    await page.waitForSelector(".home-highlights", { timeout: 60000 });

    const data = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".home-highlights .item")];
      return items.map(item => ({
        title: item.querySelector("h3")?.innerText || null,
        value: item.querySelector(".value")?.innerText || null
      }));
    });
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
