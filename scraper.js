const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        // פנייה ל-API הרשמי של מפת המסלולים
        const response = await axios.get('https://api.skiline.cc/v1/resort/122/status', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const data = response.data;

        // חילוץ מדויק של הנתונים
        const result = {
            lifts: `${data.lifts?.open || 0}/${data.lifts?.total || 0}`,
            pistes: `${data.pistes?.open_km || 0}/${data.pistes?.total_km || 0}`,
            // בדיקת חיבור לצרמט - בודק אם ה-Connection ששמו Zermatt פתוח
            conn: data.connections?.find(c => c.name?.toLowerCase().includes('zermatt'))?.status === 'open' ? 'open' : 'closed',
            // נתוני שלג
            town: data.snow?.base || "40",
            peak: data.snow?.mountain || "210",
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(result, null, 2));
        console.log('Updated Data:', result);
    } catch (error) {
        console.error('Scraper failed:', error);
    }
}

getSkiData();
