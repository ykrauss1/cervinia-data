const fs = require('fs');

async function getCerviniaData() {
    try {
        console.log("Fetching live data from API...");
        // זו הכתובת של מערכת המפה והסטטוס הפנימית שלהם
        const apiUrl = 'https://api.skiline.cc/api/v1/resort/cervinia/status';
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        // אם ה-API הספציפי הזה לא עונה, ננסה כתובת חלופית יציבה
        if (!response.ok) {
            console.log("Primary API failed, trying fallback...");
            const fallbackRes = await fetch('https://api.skitude.com/v1/resorts/74/status');
            const fallbackData = await fallbackRes.json();
            
            const data = {
                lifts: `${fallbackData.lifts.open}/${fallbackData.lifts.total}`,
                pistes: `${fallbackData.slopes.open_km}/${fallbackData.slopes.total_km}`,
                conn: fallbackData.snow_park ? "open" : "closed", // הערכה לפי סטטוס אחר
                lastUpdate: new Date().toISOString()
            };
            fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
            return;
        }

        const rawData = await response.json();
        
        // בניית אובייקט הנתונים שלנו מתוך ה-API
        const data = {
            lifts: `${rawData.openLifts || 0}/${rawData.totalLifts || 52}`,
            pistes: `${rawData.openPistesKm || 0}/${rawData.totalPistesKm || 360}`,
            conn: rawData.connectionOpen ? "open" : "closed",
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
        console.log("Success! Data.json updated with live API stats.");
        
    } catch (error) {
        console.error("Critical failure:", error);
        // יצירת קובץ חירום כדי שהאתר לא יישבר
        fs.writeFileSync('data.json', JSON.stringify({ 
            lifts: "Check site", 
            pistes: "Check site", 
            conn: "closed", 
            error: true 
        }));
        process.exit(1);
    }
}

getCerviniaData();
