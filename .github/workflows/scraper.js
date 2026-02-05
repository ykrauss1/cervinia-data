const fs = require('fs');

async function getCerviniaData() {
    try {
        console.log("Fetching data...");
        const response = await fetch('https://www.cervinia.it/en/live/lifte-piste', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            }
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const html = await response.text();
        
        // חילוץ מעליות (מחפש מספר/מספר)
        const liftMatch = html.match(/(\d+)\s*\/\s*(\d+)/);
        const lifts = liftMatch ? `${liftMatch[1]}/${liftMatch[2]}` : "22/52"; // ברירת מחדל אם נכשל
        
        // בדיקת צ'רמט
        const isConnOpen = html.toLowerCase().includes('international') && 
                          (html.toLowerCase().includes('open') || html.toLowerCase().includes('aperto'));

        const data = {
            lifts: lifts,
            pistes: "120/360", // נתון סטטי או חילוץ דומה
            conn: isConnOpen ? "open" : "closed",
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
        console.log("Data saved successfully!");
    } catch (error) {
        console.error("Scraper failed:", error);
        process.exit(1);
    }
}

getCerviniaData();
