const puppeteer = require("puppeteer-core");
const fs = require("fs");

// =========================
// HOME PAGE
// =========================
async function scrapeHomePage(page) {
  await page.goto("https://www.cervinia.it/en", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  const html = await page.content();
  console.log("HOME HTML:", html);
  fs.writeFileSync("home.html", html);

  return await page.evaluate(() => {
    const textOf = el => (el ? el.textContent.trim() : null);
    const numOf = el =>
      el ? parseFloat(el.textContent.replace(/[^\d.-]/g, "")) : null;

    const topBar = document.querySelector("div._4ruBB") || document.body;
    const spans = Array.from(topBar.querySelectorAll("span"));

    const findBlock = label =>
      spans.find(s => s.textContent.trim().toLowerCase() === label.toLowerCase())
        ?.closest("a,div");

    const liftsGlobalBlock = findBlock("lifts");
    const slopesGlobalBlock = findBlock("slopes");

    const globalLiftsOpen = numOf(
      liftsGlobalBlock?.querySelector(".edagF, .size-25")
    );
    const globalLiftsTotal = numOf(
      liftsGlobalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    const globalSlopesOpen = numOf(
      slopesGlobalBlock?.querySelector(".edagF, .size-25")
    );
    const globalSlopesTotal = numOf(
      slopesGlobalBlock?.querySelector(".size-18.medium.u-ml-10, .size-18.u-ml-10")
    );

    const tempGlobalSpan = spans.find(s =>
      /\-?\d+(\.\d+)?\s*°C?/i.test(s.textContent)
    );
    const globalTemperature = numOf(tempGlobalSpan);

    const zermattLabel = spans.find(s =>
      s.textContent.trim().toLowerCase().includes("zermatt link")
    );
    let zermattLinkStatus = null;
    if (zermattLabel) {
      const container = zermattLabel.closest("div");
      const statusSpan = container?.querySelector(
        "span.U4QfZ, span.demi, span.size-14"
      );
      zermattLinkStatus = textOf(statusSpan)?.toLowerCase() || null;
    }

    const circlesContainer = document;

    const findLocalBlock = label =>
      Array.from(
        circlesContainer.querySelectorAll("div.CyBEa, div.grid__col")
      ).find(block =>
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

// =========================
// METEO PAGE
// =========================
async function scrapeMeteoPage(page) {
  await page.goto("https://www.cervinia.it/en/meteo", {
    waitUntil: "networkidle0",
    timeout: 120000
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  const html = await page.content();
  console.log("METEO HTML:", html);
  fs.writeFileSync("meteo.html", html);

  return await page.evaluate(() => {
    const textOf = el => (el ? el.textContent.trim() : null);
    const numOf = el =>
      el ? parseFloat(el.textContent.replace(/[^\d.-]/g, "")) : null;

    const bodyText = document.body.innerText;

    const snow = {
      baseDepthCm: null,
      freshSnowCm: null,
      quality: null
    };

    const snowDepthMatch = bodyText.match(/Snow depth\s*:?[\s\n]*([\d.,]+)\s*cm/i);
    if (snowDepthMatch)
      snow.baseDepthCm = parseFloat(snowDepthMatch[1].replace(",", "."));

    const freshSnowMatch = bodyText.match(/Fresh snow\s*:?[\s\n]*([\d.,]+)\s*cm/i);
    if (freshSnowMatch)
      snow.freshSnowCm = parseFloat(freshSnowMatch[1].replace(",", "."));

    const qualityMatch = bodyText.match(/Snow quality\s*:?[\s\n]*([A-Za-z ]+)/i);
    if (qualityMatch) snow.quality = qualityMatch[1].trim();

    const weatherNow = {
      windSpeedKmh: null,
      windDirection: null,
      visibilityM: null
    };

    const windMatch = bodyText.match(/Wind\s*:?[\s\n]*([\d.,]+)\s*km\/h/i);
    if (windMatch)
      weatherNow.windSpeedKmh = parseFloat(windMatch[1].replace(",", "."));

    const windDirMatch = bodyText.match(/Wind direction\s*:?[\s\n]*([A-Z]{1,3})/i);
    if (windDirMatch) weatherNow.windDirection = windDirMatch[1];

    const visMatch = bodyText.match(/Visibility\s*:?[\s\n]*([\d.,]+)\s*m/i);
    if (visMatch)
      weatherNow.visibilityM = parseFloat(vis
