// === WEATHER START ===

// טעינת תחזית מזג אוויר
async function loadW() {
    const r = await fetch('data/data.json?v=' + Date.now());
    const d = await r.json();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // מניחים שפורמט התאריך הוא "DD.MM"
    const future = d.forecast
        .map(f => {
            const parts = f.date.split('.');
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10);
            const dateObj = new Date(today.getFullYear(), month - 1, day);
            dateObj.setHours(0, 0, 0, 0);
            return { ...f, _dateObj: dateObj };
        })
        .filter(f => f._dateObj >= today)
        .sort((a, b) => a._dateObj - b._dateObj)
        .slice(0, 4);

    document.getElementById('w-body').innerHTML = future.map(f => {
        // ⭐ כאן השינוי:
        const wind = parseFloat(f.wind.replace(/[^\d.]/g, ''));

        const prob = wind < 32 
            ? {c:'var(--success)', t:'גבוה'} 
            : (wind > 50 ? {c:'var(--error)', t:'נמוך'} : {c:'var(--warning)', t:'בינוני'});

        return `
            <tr>
                <td style="color:${prob.c}; font-weight:bold;">${prob.t}</td>
                <td>${f.date}</td>
                <td style="direction:ltr;">${f.temp_min}/${f.temp_max}</td>
                <td>${f.wind}</td>
                <td>${f.visibility}</td>
            </tr>
        `;
    }).join('');
}

// === WEATHER END ===
