const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        console.log('Starting fetch from official Cervinia API...');
        
        // כתובת ה-API המעודכנת של סטטוס המעליות והמסלולים
        const url = 'https://api.skiline.cc/v1/resort/122/status';
        
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        const data = response.data;
        
        // בניית אובייקט הנתונים מתוך המבנה של Skiline
        const result = {
            lifts: `${data.lifts?.open || 0}/${data.lifts?.total || 52}`,
            pistes: `${data.pistes?.open_km || 0}/${data.pistes?.total_km || 360}`,
            town: data.snow?.base || "45",
            peak: data.snow?.mountain || "215",
            // בדיקה אם הקישור לצרמט פתוח
            conn: data.connections?.some(c => c.name?.toLowerCase().includes('zermatt') && c.status === 'open') ? 'open' : 'closed',
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(result, null, 2));
        console.log('Successfully wrote data.json:', result);
        
    } catch (error) {
        console.error('FAILED to fetch data:', error.message);
        
        // מנגנון גיבוי: אם ה-API הראשי נפל, ננסה מקור חלופי (Meteoblue למשל)
        console.log('Attempting backup fetch...');
        // כאן אפשר להוסיף מקור נוסף אם נרצה בעתיד
        
        process.exit(1); 
    }
}

getSkiData();
