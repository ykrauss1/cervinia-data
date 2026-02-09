import os
import json
import requests
from datetime import datetime
import pytz

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

def get_cervinia_live_data():
    # כתובת ה-API הפנימית של צ'רוויניה
    url = "https://api.cervinia.it/api/v1/bollettino-neve" 
    # הערה: אם ה-URL הזה ישתנה, נחפש את החדש. בינתיים ננסה גישה לנתוני ה-lifts
    headers = {'User-Agent': 'Mozilla/5.0'}
    
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        # ניסיון למשוך את ה-HTML ולחפש את ה-JSON שמוחבא בתוכו (שיטה אמינה יותר)
        res = requests.get("https://www.cervinia.it/en/info/bollettino-neve", headers=headers)
        html = res.text
        
        # חיפוש הנתונים בתוך ה-HTML באמצעות חיפוש תבניות פשוט (Regex)
        import re
        # חיפוש מספר המעליות הפתוחות מתוך הטקסט (למשל: "15/47")
        lifts_match = re.search(r'(\d+)\s*/\s*47', html)
        if lifts_match:
            results["lifts"] = f"{lifts_match.group(1)}/47"
            
        slopes_match = re.search(r'(\d+)\s*/\s*109', html)
        if slopes_match:
            results["slopes"] = f"{slopes_match.group(1)}/109"
            
        # בדיקת זארמט
        if "Zermatt" in html and ("Open" in html or "Aperto" in html):
            results["conn"] = "open"
            
    except: pass
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather_and_forecast()
    live = get_cervinia_live_data()
    
    output = {
        "lifts": live["lifts"],
        "slopes": live["slopes"],
        "conn": live["conn"],
        "temp": current_temp,
        "forecast": forecast,
        "last_update": datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(output, f, indent=4)
