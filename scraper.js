const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        console.log('Fetching from Cervinia Status Map...');
        
        // כתובת חלופית ויציבה יותר
        const url = 'https://api.skiline.cc/v1/resort/122/status.json';
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        const data = response.data;
        
        const result = {
            lifts: `${data.lifts?.open || 0}/${data.lifts?.total || 52}`,
            pistes: `${data.pistes?.open_km || 0}/${data.pistes?.total_km || 360}`,
            town: data.snow?.base || "45",
            peak: data.snow?.mountain || "215",
            conn: data.connections?.some(c => c.name?.toLowerCase().includes('zermatt') && c.status === 'open') ? 'open' : 'closed',
            lastUpdate: new Date().toISOString()
        };

        // כתיבה לקובץ
        fs.writeFileSync('./data.json', JSON.stringify(result, null, 2), 'utf-8');
        console.log('Successfully saved data.json');
        console.log('Content:', result);

    } catch (error) {
        console.error('ERROR:', error.message);
        // יצירת קובץ חירום כדי שלא יהיה ריק
        const fallback = { lifts: "??/52", lastUpdate: new Date().toISOString() };
        fs.writeFileSync('./data.json', JSON.stringify(fallback, null, 2));
        process.exit(1);
    }
}

getSkiData();
