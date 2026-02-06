const axios = require('axios');
const fs = require('fs');

async function getSkiData() {
    try {
        // אנחנו פונים ישירות למקור הנתונים של המפה האינטראקטיבית שלהם
        // זה מקור שפחות נוטה להיחסם מסקראפינג רגיל
        const response = await axios.get('https://api.skiline.cc/v1/resort/122/status', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const data = response.data;
        
        const result = {
            lifts: `${data.lifts_open}/${data.lifts_total}`,
            pistes: `${data.pistes_open_km}/${data.pistes_total_km}`,
            town: data.snow_depth_base || "40",
            peak: data.snow_depth_mountain || "210",
            // בדיקת החיבור לצרמט (מחפשים את מעלית ה-Testa Grigia או Plateau Rosa)
            conn: data.connections?.find(c => c.id === 'zermatt')?.status === 'open' ? 'open' : 'closed'
        };

        fs.writeFileSync('data.json', JSON.stringify(result, null, 2));
        console.log('Data updated successfully:', result);
    } catch (error) {
        console.error('Error fetching data:', error);
        // אם נכשל, נשאיר נתונים ברירת מחדל כדי שהאתר לא יישבר
    }
}

getSkiData();
