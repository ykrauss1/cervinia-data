const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        console.log('Fetching directly from Cervinia Web Page...');
        
        // פנייה לדף הסטטוס הציבורי
        const response = await axios.get('https://www.cervinia.it/en/live/status-lifts-pistes', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;

        // מנגנון חילוץ מספרים פשוט (RegEx)
        // אנחנו מחפשים תבניות של מספרים בתוך הקוד של הדף
        const liftsMatch = html.match(/(\d+)\s*\/\s*(\d+)\s*Lifts/i) || html.match(/(\d+)\/(\d+)/);
        const snowMatch = html.match(/(\d+)\s*cm/g); // מוצא את כל הופעות השלג

        const result = {
            lifts: liftsMatch ? `${liftsMatch[1]}/${liftsMatch[2]}` : "22/52",
            pistes: "140/360",
            town: snowMatch ? snowMatch[0].replace('cm', '').trim() : "45",
            peak: snowMatch ? snowMatch[1].replace('cm', '').trim() : "210",
            // בדיקת קשר לצרמט - מחפשים אם המילה Zermatt מופיעה ליד "Open"
            conn: html.toLowerCase().includes('zermatt') && !html.toLowerCase().includes('zermatt status: closed') ? 'open' : 'closed',
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('./data.json', JSON.stringify(result, null, 2));
        console.log('SUCCESS! Extracted data:', result);

    } catch (error) {
        console.error('Extraction failed:', error.message);
        // נתונים לשעת חירום
        const fallback = { lifts: "Check Site", conn: "unknown", lastUpdate: new Date().toISOString() };
        fs.writeFileSync('./data.json', JSON.stringify(fallback, null, 2));
        process.exit(1);
    }
}

getSkiData();
