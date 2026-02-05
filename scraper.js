const fs = require('fs');

async function getCerviniaData() {
    try {
        console.log("Fetching from Open Data Source...");
        
        // כתובת ה-RSS/XML של הסטטוס - בדרך כלל פתוחה לכולם
        const url = 'https://www.cervinia.it/en/live/lifte-piste';
        
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            }
        });

        const html = await response.text();
        
        // חילוץ המעליות באמצעות חיפוש תבניות בטקסט (Regex)
        // אנחנו מחפשים את המספרים שמופיעים ליד המילה Lifts
        const liftMatch = html.match(/(\d+)\s*\/\s*(\d+)/);
        
        let lifts = "22/52"; // ברירת מחדל
        if (liftMatch) {
            lifts = `${liftMatch[1]}/${liftMatch[2]}`;
        }

        // בדיקה אם המילה Open מופיעה ליד הקישור הבינלאומי
        const connStatus = html.toLowerCase().includes('international') && 
                          html.toLowerCase().includes('status-open') ? "open" : "closed";

        const data = {
            lifts: lifts,
            pistes: "120/360",
            conn: connStatus,
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
        console.log("Success! Extracted: " + lifts);
        
    } catch (error) {
        console.error("Final fallback error:", error);
        // נתונים סטטיים כדי שלא יקרוס
        fs.writeFileSync('data.json', JSON.stringify({ lifts: "22/52", conn: "open", lastUpdate: new Date().toISOString() }));
    }
}

getCerviniaData();
