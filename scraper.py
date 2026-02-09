import os
import json
import requests
from datetime import datetime
import pytz
import re

def get_weather_and_forecast():
    # נשאר עם המדידה ב-Plateau Rosa (גובה 3480m לערך)
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
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 25 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def get_live_status():
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    # מקור נתונים חלופי - OnTheSnow (אמין מאוד ומתעדכן מהר)
    url = "https://www.onthesnow.it/valle-daosta/breuil-cervinia/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        html = response.text
        
        # חיפוש תבנית של מעליות (למשל "47/47" או "40 su 47")
        # באיטלקית 'su' זה 'מתוך'
        lifts_match = re.search(r'(\d+)\s*(?:su|/|of)\s*47', html)
        if lifts_match:
            results["lifts"] = f"{lifts_match.group(1)}/47"
        
        # חיפוש מסלולים (109)
        slopes_match = re.search(r'(\d+)\s*(?:su|/|of)\s*109', html)
        if slopes_match:
            results["slopes"] = f"{slopes_match.group(1)}/109"

        # בדיקת קישור לזארמט - מחפשים את המילה Zermatt וסטטוס פתוח (aperto)
        if "zermatt" in html.lower() and ("aperto" in html.lower() or "open" in html.lower()):
            results["conn"] = "open"
        else:
            # אם לא מצאנו טקסטואלית, נבדוק אם אחוז המעליות הפתוחות גבוה מאוד
            if lifts_match and int(lifts_match.group(1)) > 40:
                results["conn"] = "open"

    except:
        pass
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather_and_forecast()
    live = get_live_status()
    
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
