import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_external_temp():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.63&current_weather=true"
        data = requests.get(url, timeout=10).json()
        return f"{data['current_weather']['temperature']}°C"
    except: return "N/A"

def get_wind_prediction():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&current_weather=true"
        data = requests.get(url, timeout=10).json()
        wind = data['current_weather']['windspeed']
        if wind > 55: return "Low (High Wind)"
        if wind > 35: return "Medium (Windy)"
        return "High (Good conditions)"
    except: return "Unknown"

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0'}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        tz = pytz.timezone('Europe/Rome')
        now = datetime.now(tz)
        is_ski_time = (now.hour == 8 and now.minute >= 30) or (9 <= now.hour < 17)

        # 1. טמפרטורה (ניסיון מהאתר, ואז גיבוי)
        temp = None
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag and temp_tag.text.strip():
            temp = temp_tag.text.strip().replace(' ', '')
        if not temp or "N/A" in temp:
            temp = get_external_temp()

        # 2. מעליות (לוגיקה להפרדה בסיסית)
        lifts_val = "0/0"
        if is_ski_time:
            l_open = soup.select_one('.lifts-info__open').text.strip() if soup.select_one('.lifts-info__open') else "0"
            l_total = soup.select_one('.lifts-info__total').text.strip() if soup.select_one('.lifts-info__total') else "0"
            lifts_val = f"{l_open}/{l_total}"

        # 3. בניית הנתונים (חלוקה לאזורים)
        data = {
            "cervinia": {"lifts": lifts_val},
            "valtournenche": {"lifts": lifts_val if "0/0" not in lifts_val else "0/0"}, 
            "zermatt": {"lifts": "Check Zermatt.ch"},
            "conn": "open" if "zermatt" in res.text.lower() and "open" in res.text.lower() and "closed" not in res.text.lower() else "closed",
            "temp": temp,
            "wind_prediction": get_wind_prediction(),
            "last_update": now.strftime("%H:%M")
        }

        with open('data.json', 'w') as f:
            json.dump(data, f)
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_data()
