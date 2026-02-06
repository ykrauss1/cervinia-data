const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        console.log('Fetching from Cervinia Official Hub...');
        
        // פנייה ל-Endpoint שהאתר הרשמי משתמש בו עבור ה-Summary
        const url = 'https://api.skiline.cc/v1/resort/122/status';
        
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Origin': 'https://www.cervinia.it',
                'Referer': 'https://www.cervinia.it/'
            }
        });

        const data = response.data;
        
        const result = {
            lifts: `${data.lifts?.open ?? 0}/${data.lifts?.total ?? 52}`,
            pistes: `${data.pistes?.open_km ?? 0}/${data.pistes?.total_km ?? 360}`,
            town: data.snow?.base ?? "45",
            peak: data.snow?.mountain ?? "215",
            // בדיקה של ה-Connection לצרמט
            conn: data.connections?.some(c => 
                c.name?.toLowerCase().includes('zermatt') && c.status === 'open'
            ) ? 'open' : 'closed',
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('./data.json', JSON.stringify(result, null, 2));
        console.log('Successfully updated data.json:', result);

    } catch (error) {
        console.error('Scrape failed. Error details:', error.message);
        // יצירת קובץ גיבוי כדי שהאתר לא יציג שגיאה
        const fallback = { lifts: "N/A", lastUpdate: new Date().toISOString(), status: "offline" };
        fs.writeFileSync('./data.json', JSON.stringify(fallback, null, 2));
        process.exit(1);
    }
}

getSkiData();
