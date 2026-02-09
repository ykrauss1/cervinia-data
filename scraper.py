import os
import json
import requests
from datetime import datetime
import pytz
import re
from bs4 import BeautifulSoup

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

def get_bergfex_data():
    # דף הנתונים של צ'רוויניה ב-Bergfex
    url = "https://www.bergfex.com/breuil-cervinia/schneebericht/"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        text = soup.get_text()

        # חיפוש מעליות (Lifts) - מחפש תבנית של מספר מתוך 47 או 50
        lifts_match = re.search(r'(\d+)\s*of\s*(\d+)\s*Lifts', text, re.IGNORECASE)
        if lifts_match:
            results["lifts"] = f"{lifts_match.group(1)}/{lifts_match.group(2)}"
        
        # חיפוש מסלולים (Slopes)
        slopes_match = re.search(r'(\d+)\s*of\s*(\d+)\s*km', text, re.IGNORECASE)
        if slopes_match:
            results["slopes"] = f"{slopes_match.group(1)}/{slopes_match.group(2)} km"

        # בדיקת סטטוס קישור (ב-Bergfex זה מופיע בדרך כלל בטבלת המעליות)
        # אם יש אזכור ל-International link או Zermatt כ-Open
        if "Zermatt" in text and "open" in text.lower():
            results["conn"] = "open"
            
    except Exception as e:
        print(f"Bergfex Error: {e}")
    
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather_and_forecast()
    live = get_bergfex_data()
    
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
