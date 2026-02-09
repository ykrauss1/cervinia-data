import os
import json
import requests
from datetime import datetime
import pytz
import re

def get_weather_and_forecast():
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,showers_sum&timezone=Europe%2FRome"
    try:
        res = requests.get(url).json()
        days = []
        for i in range(4):
            days.append({
                "date": res['daily']['time'][i],
                "temp_max": f"{res['daily']['temperature_2m_max'][i]}°C",
                "temp_min": f"{res['daily']['temperature_2m_min'][i]}°C",
                "wind": f"{res['daily']['windspeed_10m_max'][i]} km/h",
                "visibility": "טובה" if res['daily']['showers_sum'][i] < 2 else "מוגבלת",
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 30 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def get_skiinfo_data():
    # צ'רוויניה ב-Skiinfo.it - מקור הרבה יותר ידידותי לסקריפרים
    url = "https://www.skiinfo.it/valle-daosta/breuil-cervinia/stazione-sciistica"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        html = response.text
        
        # חיפוש מעליות - בדרך כלל מופיע כצמד מספרים ליד אייקון או מילה
        # מחפש תבנית של "X/47" או טקסט שאומר כמה פתוח
        lifts_match = re.search(r'(\d+)\s*/\s*47', html)
        if not lifts_match:
            # ניסיון נוסף: חיפוש מספר כלשהו שמוצמד למילה 'Impianti' (מעליות באיטלקית)
            lifts_match = re.search(r'(\d+)\s*impianti\s*aperti', html, re.IGNORECASE)
        
        if lifts_match:
            results["lifts"] = f"{lifts_match.group(1)}/47"
        else:
            # אם לא מצאנו /47, נחפש את המספר הראשון שמופיע באזור הסטטיסטיקה
            # במקרים רבים באתר זה המספר הראשון הוא המעליות
            results["lifts"] = "Check Site"

        # חיפוש מסלולים - תבנית X/109
        slopes_match = re.search(r'(\d+)\s*/\s*109', html)
        if slopes_match:
            results["slopes"] = f"{slopes_match.group(1)}/109"

        # בדיקת זארמט (בדרך כלל מופיע כ-International Link)
        if "zermatt" in html.lower() and ("aperto" in html.lower() or "open" in html.lower()):
            results["conn"] = "open"

    except Exception as e:
        print(f"Skiinfo Scrape Error: {e}")
    
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather_and_forecast()
    live = get_skiinfo_data()
    
    # וידוא אחרון: אם הסריקה החדשה נכשלה, נשמור לפחות את ה-Conn שזיהינו קודם
    output = {
        "lifts": live["lifts"],
        "slopes": live["slopes"],
        "conn": live["conn"],
        "temp": current_temp,
        "forecast": forecast,
        "last_update": datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(output, f, indent=4, ensure_ascii=False)
