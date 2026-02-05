// סקריפט קטן שמחלץ את הנתונים מה-HTML של צ'רביניה
async function process() {
    const filename = 'status.html';
    const content = await Deno.readTextFile(filename);
    
    // חיפוש נתוני המעליות (מחפש תבנית של מספר/מספר)
    const liftMatch = content.match(/(\d+)\s*\/\s*(\d+)/);
    const lifts = liftMatch ? `${liftMatch[1]}/${liftMatch[2]}` : "N/A";
    
    // חיפוש מצב המעבר לצ'רמט (מחפש את המילה Open/Closed ליד התג של הבינלאומי)
    const isCerviniaZermattOpen = content.toLowerCase().includes('international pass') && 
                                  content.toLowerCase().includes('open');

    const data = {
        lifts: lifts,
        pistes: "Checking...", // נשפר את זה בהמשך אחרי שנראה את המבנה המדויק
        conn: isCerviniaZermattOpen ? "open" : "closed",
        lastUpdate: new Date().toISOString()
    };

    await Deno.writeTextFile('data.json', JSON.stringify(data, null, 2));
    console.log("Data processed successfully!");
}

process();
