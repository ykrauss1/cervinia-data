import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_external_temp():
    """שליפת טמפרטורה ממקור מזג אוויר חיצוני (Open-Meteo)"""
    try:
        # קואורדינטות של צ'רביניה
        url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.63&current_weather=true"
        response = requests.get(url)
        data = response.json()
        return f"{data['current_weather']['temperature']}°C"
    except:
        return None

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        # בדיקת זמן באיטליה
        tz_italy = pytz.timezone('Europe/Rome')
        now = datetime.now(tz_italy)
        is_daytime = 8 <= now.hour < 17

        # ניסיון שאיבה מהאתר הרשמי
        response = requests.get(url, headers=headers, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # טמפרטורה - ננסה מהאתר, אם אין (או לילה) ניקח מהמקור החיצוני
        temp_tag = soup.select_one('.weather-info__temp')
        temp = temp_tag.text.strip() if temp_tag else None
        
        if not temp or not is_daytime:
            external_temp = get_external_temp()
            if external_temp:
                temp = external_temp

        # שלג
        snow_values = soup.select('.snow-info__value')
        town_snow = snow_values[0].text.strip().replace('cm','') if len(snow_values) > 0 else "0"
        peak_snow = snow_values[1].text.strip().replace('cm','') if len(snow_values) > 1 else "0"

        # מעליות וחיבור - רק ביום
        if is_daytime:
            lifts_open = soup.select_one('.lifts-info__open')
            lifts_total = soup.select_one('.lifts-info__total')
            lifts = f"{lifts_open.text}/{lifts_total.text}" if lifts_open and lifts_total else "0/0"
            
            conn = "closed"
            if "zermatt" in response.text.lower() and "open" in response.text.lower():
                conn = "open"
        else:
            lifts = "0/0"
            conn = "closed"

        data = {
            "town": town_snow,
            "peak": peak_snow,
            "lifts": lifts,
            "conn": conn,
            "temp": temp if temp else "N/A",
            "last_update": now.strftime("%H:%M")
        }
        
        with open('data.json', 'w') as f:
            json.dump(data, f)
            
    except Exception as e:
        # אם הכל נכשל, ננסה לפחות להציל את הטמפרטורה
        ext_temp = get_external_temp()
        if ext_temp:
            with open('data.json', 'w') as f:
                json.dump({"temp": ext_temp, "status": "offline_mode"}, f)

if __name__ == "__main__":
    get_data()
