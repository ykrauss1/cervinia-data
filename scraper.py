import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_external_temp():
    """גיבוי: טמפרטורה ממקור חיצוני"""
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.63&current_weather=true"
        response = requests.get(url, timeout=10)
        data = response.json()
        return f"{data['current_weather']['temperature']}°C"
    except:
        return "N/A"

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        tz_italy = pytz.timezone('Europe/Rome')
        now = datetime.now(tz_italy)
        # שעות פעילות (08:30 עד 17:00 שעון איטליה)
        is_ski_time = (now.hour == 8 and now.minute >= 30) or (9 <= now.hour < 17)

        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # שלב 1: טמפרטורה (עדיפות לאתר הרשמי)
        temp = None
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag and temp_tag.text.strip():
            temp = temp_tag.text.strip().replace(' ', '')
        
        if not temp or "N/A" in temp:
            temp = get_external_temp()

        # שלב 2: שלג
        snow_values = soup.select('.snow-info__value')
        town_snow = snow_values[0].text.strip().replace('cm','') if len(snow_values) > 0 else "0"
        peak_snow = snow_values[1].text.strip().replace('cm','') if len(snow_values) > 1 else "0"

        # שלב 3: מעליות וחיבור
        if is_ski_time:
            lifts_open = soup.select_one('.lifts-info__open')
            lifts_total = soup.select_one('.lifts-info__total')
            lifts = f"{lifts_open.text}/{lifts_total.text}" if lifts_open and lifts_total else "0/0"
            
            conn = "closed"
            if "zermatt" in response.text.lower() and "open" in response.text.lower() and "closed" not in response.text.lower():
                conn = "open"
        else:
            lifts = "0/0"
            conn = "closed"

        data = {
            "town": town_snow,
            "peak": peak_snow,
            "lifts": lifts,
            "conn": conn,
            "temp": temp,
            "last_update": now.strftime("%H:%M")
        }
        
        with open('data.json', 'w') as f:
            json.dump(data, f)
        print(f"Success! Data: {data}")
            
    except Exception as e:
        print(f"Error occurred: {e}")

if __name__ == "__main__":
    get_data()
