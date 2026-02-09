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
                "visibility": "טובה",
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 25 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def get_live_data():
    url = "https://www.skiinfo.it/valle-daosta/breuil-cervinia/stazione-sciistica"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    
    # ברירות מחדל למקרה של תקלה, אבל ננסה לעדכן מהאתר
    res = {"lifts": "47/47", "slopes": "109/109", "conn": "open"}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        html = response.text.lower()
        
        # חילוץ מעליות - מחפש את המספר לפני ה-47
        lifts_match = re.search(r'(\d+)\s*/\s*47', html)
        num_lifts = 47 # ברירת מחדל אם לא מצא
        if lifts_match:
            num_lifts = int(lifts_match.group(1))
            res["lifts"] = f"{num_lifts}/47"
        
        # חילוץ מסלולים - לפי יחס קילומטרים ל-156 ק"מ
        slopes_match = re.search(r'(\d+)\s*/\s*156', html)
        if slopes_match:
            current_km = int(slopes_match.group(1))
            res["slopes"] = f"{int((current_km/156)*109)}/109"

        # לוגיקת קישור "ברזל": 
        # אם מעל 30 מעליות פתוחות - הקישור פתוח (סבירות של 99% ביום רגיל)
        # או אם מצאנו את המילה 'aperto' (פתוח באיטלקית) בדף
        if num_lifts > 30 or "aperto" in html or "open" in html:
            res["conn"] = "open"
        else:
            res["conn"] = "closed"

    except Exception as e:
        print(f"Error: {e}")
        
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
