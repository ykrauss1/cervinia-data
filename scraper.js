const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        console.log('Starting fetch...');
        const response = await axios.get('https://api.skiline.cc/v1/resort/122/status', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        const data = response.data;
        
        const result = {
            lifts: `${data.lifts?.open || 0}/${data.lifts?.total || 0}`,
            pistes: `${data.pistes?.open_km || 0}/${data.pistes?.total_km || 0}`,
            town: data.snow?.base || "40",
            peak: data.snow?.mountain || "210",
            conn: data.connections?.find(c => c.name?.toLowerCase().includes('zermatt'))?.status === 'open' ? 'open' : 'closed',
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(result, null, 2));
        console.log('Successfully wrote data.json:', result);
    } catch (error) {
        console.error('FAILED to fetch data:', error.message);
        process.exit(1); // גורם ל-Action להראות אדום אם נכשל
    }
}

getSkiData();
