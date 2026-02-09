import os
import json
import requests
from datetime import datetime
import pytz
import re

def get_weather():
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

def get_live_data():
    # כתובת API חלופית ויציבה יותר
    url = "https://www.skiinfo.it/api/resorts/171/snowreport" # 171 זה הקוד של צ'רוויניה
    headers = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
    }
    
    res = {"lifts": "47/47", "slopes": "109/109", "conn": "open"}
    
    try:
        # ננסה למשוך נתונים מ-API או דף נתונים פשוט
        response = requests.get("https://www.skiinfo.it/valle-daosta/breuil-cervinia/stazione-sciistica", headers=headers, timeout=10)
        html = response.text
        
        # מחפש את המספר שמופיע לפני "impianti aperti" (מעליות פתוחות)
        lifts_match = re.search(r'(\d+)\s*/\s*47', html)
        if lifts_match:
            res["lifts"] = f"{lifts_match.group(1)}/47"
        
        # מחפש מסלולים
        slopes_match = re.search(r'(\d+)\s*/\s*156', html) # 156 ק"מ זה המקסימום באתר הזה
        if slopes_match:
            current_km = int(slopes_match.group(1))
            res["slopes"] = f"{int((current_km/156)*109)}/109"

        # בדיקת קונקשן - אם יש מעל 35 מעליות, רוב הסיכויים שהקישור פתוח
        if lifts_match and int(lifts_match.group(1)) > 35:
            res["conn"] = "open"
        else:
            res["conn"] = "closed"

    except:
        pass
    return res

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather()
    live = get_live_data()
    
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
