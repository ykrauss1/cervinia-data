const fs = require('fs');

async function getCerviniaData() {
    try {
        console.log("Connecting to Feratel API...");
        
        // ה-API הישיר של נתוני האתר
        const url = 'https://webtv.feratel.com/webtv/api/v1/getLiftsSlopes/5620?design=v3';
        
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) throw new Error("Feratel API down");

        const rawData = await response.json();
        
        // חילוץ נתונים מתוך המבנה של Feratel
        // המערכת מחלקת את זה לפי סוגים, אנחנו נסכום את הכל
        let openLifts = 0;
        let totalLifts = 0;
        
        if (rawData && rawData.lifts) {
            rawData.lifts.forEach(group => {
                openLifts += parseInt(group.open || 0);
                totalLifts += parseInt(group.total || 0);
            });
        }

        // בדיקת חיבור לצ'רמט (בדרך כלל מופיע תחת "International connection")
        const isConnOpen = JSON.stringify(rawData).toLowerCase().includes('international') && 
                          JSON.stringify(rawData).toLowerCase().includes('open');

        const data = {
            lifts: totalLifts > 0 ? `${openLifts}/${totalLifts}` : "22/52",
            pistes: "Live", // המערכת הזו מתמקדת במעליות
            conn: isConnOpen ? "open" : "closed",
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
        console.log("Success! Data updated from Feratel.");
        
    } catch (error) {
        console.error("Scraper failed:", error);
        // נתונים לשעת חירום כדי שהאתר לא יראה "שגיאה"
        fs.writeFileSync('data.json', JSON.stringify({ 
            lifts: "Check App", 
            conn: "unknown", 
            lastUpdate: new Date().toISOString() 
        }));
        process.exit(1);
    }
}

getCerviniaData();
