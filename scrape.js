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
        "--proxy-server=http://geo.iproyal.com:12321"
      ]
    });

    const page = await browser.newPage();

    await page.authenticate({
      username: "4tf5u0SPrsDfvmCQ",
      password: "wxKRgWoNwUsaGgV0"
    });

    console.log("Proxy connected. Loading homepage...");
    await page.goto("https://www.cervinia.it/en", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    
    console.log(await page.content());

    await new Promise(r => setTimeout(r, 3000));

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
