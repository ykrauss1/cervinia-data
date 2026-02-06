const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    // רשימת כתובות אפשריות (אם אחת מחזירה 404, הוא עובר לבאה)
    const urls = [
        'https://api.skiline.cc/v1/resort/122/status',
        'https://www.cervinia.it/api/lifts-status', // כתובת מקומית אפשרית
        'https://api.skiline.cc/v2/resort/122/status'
    ];

    for (let url of urls) {
        try {
            console.log(`Trying to fetch from: ${url}`);
            const response = await axios.get(url, {
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            const data = response.data;
            
            // עיבוד הנתונים
            const result = {
                lifts: `${data.lifts?.open || data.lifts_open || 0}/${data.lifts?.total || data.lifts_total || 52}`,
                pistes: `${data.pistes?.open_km || data.pistes_open_km || 0}/${data.pistes?.total_km || data.pistes_total_km || 360}`,
                town: data.snow?.base || data.snow_depth_base || "45",
                peak: data.snow?.mountain || data.snow_depth_mountain || "215",
                conn: data.connections?.some(c => c.name?.toLowerCase().includes('zermatt') && c.status === 'open') ? 'open' : 'closed',
                lastUpdate: new Date().toISOString()
            };

            fs.writeFileSync('./data.json', JSON.stringify(result, null, 2));
            console.log('SUCCESS! Data saved:', result);
            return; // עוצר ברגע שהצליח

        } catch (error) {
            console.error(`Failed ${url}: ${error.message}`);
        }
    }

    // אם כל הכתובות נכשלו
    console.error('All URLs failed. Saving emergency fallback data.');
    const fallback = { lifts: "??/52", lastUpdate: new Date().toISOString(), error: "API_DOWN" };
    fs.writeFileSync('./data.json', JSON.stringify(fallback, null, 2));
    process.exit(1);
}

getSkiData();
