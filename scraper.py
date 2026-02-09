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
    url = "https://www.bergfex.com/breuil-cervinia/schneebericht/"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # חיפוש ספציפי בתוך טבלאות הנתונים של Bergfex
        rows = soup.find_all('tr')
        full_text = soup.get_text()

        # תבנית 1: חיפוש בתוך שורות טבלה (לרוב מופיע שם)
        for row in rows:
            row_text = row.get_text().lower()
            if 'lifts open' in row_text or 'impianti' in row_text:
                nums = re.findall(r'(\d+)', row_text)
                if len(nums) >= 2:
                    results["lifts"] = f"{nums[0]}/{nums[1]}"
            if 'slopes open' in row_text or 'piste' in row_text:
                nums = re.findall(r'(\d+)', row_text)
                if len(nums) >= 1:
                    results["slopes"] = f"{nums[0]} km"

        # תבנית 2: אם עדיין N/A, חיפוש חופשי בטקסט
        if results["lifts"] == "N/A":
            match = re.search(r'Lifts\s*open:\s*(\d+)\s*/\s*(\d+)', full_text, re.I)
            if match:
                results["lifts"] = f"{match.group(1)}/{match.group(2)}"

        # בדיקת זארמט - מחפשים "Zermatt" ובוודאות שמופיע "open" באותה שורה או פסקה
        if re.search(r'Zermatt.*?open', full_text, re.I | re.S):
            results["conn"] = "open"
            
    except Exception as e:
        print(f"Error: {e}")
    
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
