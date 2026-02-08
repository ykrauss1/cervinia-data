import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        tz = pytz.timezone('Europe/Rome')
        now = datetime.now(tz)

        # 1. טמפרטורה - חיפוש לפי הטקסט שליד האייקון בתמונה
        temp = "N/A"
        temp_tag = soup.select_one('.weather-info__temp, .temp')
        if temp_tag:
            temp = temp_tag.text.strip().replace(' ', '')
        
        # 2. מעליות - חיפוש המספר 25 שמופיע בתמונה שלך
        lifts_open = "0"
        lifts_total = "0"
        
        # מחפש את האלמנט שמכיל את מספר המעליות הפתוחות
        open_tag = soup.select_one('.lifts-info__open, .lifts-info__value, .open-lifts')
        total_tag = soup.select_one('.lifts-info__total, .total-lifts')
        
        if open_tag: lifts_open = open_tag.text.strip()
        if total_tag: lifts_total = total_tag.text.strip()
        
        # אם האתר מציג רק מספר אחד (כמו ה-25 בתמונה), נשתמש בו
        lifts_display = f"{lifts_open}/{lifts_total}" if lifts_total != "0" else f"{lifts_open}"

        # 3. בדיקת קשר לזארמט
        conn_status = "closed"
        if "zermatt" in res.text.lower() and "open" in res.text.lower():
            conn_status = "open"

        data = {
            "cervinia": {"lifts": lifts_display},
            "valtournenche": {"lifts": "Check Map"},
            "zermatt": {"lifts": "See Zermatt.ch"},
            "conn": conn_status,
            "temp": temp,
            "wind_prediction": "High (Checking Wind...)", # פונקציה חיצונית
            "last_update": now.strftime("%H:%M")
        }

        with open('data.json', 'w') as f:
            json.dump(data, f)
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_data()
