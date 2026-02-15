async function loadCerviniaData() {
  try {
    const res = await fetch("data/data.json");
    const data = await res.json();

    // --- מעליות ---
    if (data.lifts) {
      document.getElementById("lifts").innerText =
        `${data.lifts.open} / ${data.lifts.total}`;
    }

    // --- מסלולים ---
    if (data.slopes) {
      document.getElementById("slopes").innerText =
        `${data.slopes.open} / ${data.slopes.total}`;
    }

    // --- עומקי שלג ---
    if (data.snowDepth) {
      const snowDiv = document.getElementById("snow");
      snowDiv.innerHTML = "";
      data.snowDepth.forEach(row => {
        const p = document.createElement("p");
        p.innerText = row;
        snowDiv.appendChild(p);
      });
    }

    // --- תחזית ---
    if (data.forecast) {
      const forecastDiv = document.getElementById("forecast");
      forecastDiv.innerHTML = "";
      data.forecast.forEach(item => {
        const p = document.createElement("p");
        p.innerText = item;
        forecastDiv.appendChild(p);
      });
    }

    // --- מצלמות ---
    if (data.cameras) {
      const camsDiv = document.getElementById("cams");
      camsDiv.innerHTML = "";
      data.cameras.forEach(url => {
        const iframe = document.createElement("iframe");
        iframe.src = url;
        iframe.width = "400";
        iframe.height = "250";
        iframe.loading = "lazy";
        camsDiv.appendChild(iframe);
      });
    }

    // --- קישור לצ'רמט ---
    if (data.zermattConnection) {
      document.getElementById("zermatt").innerText =
        data.zermattConnection;
    }

    // --- תאריך עדכון ---
    if (data.last_update) {
      document.getElementById("updated").innerText =
        new Date(data.last_update).toLocaleString("he-IL");
    }

  } catch (err) {
    console.error("Failed to load Cervinia data:", err);
  }
}

loadCerviniaData();
