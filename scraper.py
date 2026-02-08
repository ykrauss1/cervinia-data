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

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        tz = pytz.timezone('Europe/Rome')
        now = datetime.now(tz)

        # טמפרטורה - חיפוש לפי המבנה באתר שבתמונה
        temp = "N/A"
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag:
            temp = temp_tag.text.strip().replace(' ', '')
        if temp == "N/A" or not temp:
            temp = get_external_temp()

        # מעליות - מושך את ה-25 שראית בתמונה
        lifts_open = "0"
        lifts_tag = soup.select_one('.lifts-info__open')
        if lifts_tag:
            lifts_open = lifts_tag.text.strip()
        
        data = {
            "cervinia": {"lifts": f"{lifts_open}/25"},
            "valtournenche": {"lifts": "Open"},
            "zermatt": {"lifts": "Open"},
            "conn": "open" if "open" in res.text.lower() else "closed",
            "temp": temp,
            "wind_prediction": "High (Good conditions)",
            "last_update": now.strftime("%H:%M")
        }

        with open('data.json', 'w') as f:
            json.dump(data, f)
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_data()
