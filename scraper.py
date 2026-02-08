import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_forecast():
    # קואורדינטות של Plateau Rosa
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,weathercode&timezone=Europe%2FRome"
    try:
        res = requests.get(url, timeout=10).json()
        forecast = []
        for i in range(4):
            date_str = res['daily']['time'][i]
            date_obj = datetime.strptime(date_str, '%Y-%m-%d')
            wind = res['daily']['windspeed_10m_max'][i]
            # לוגיקה לסיכוי קישור מבוססת רוח
            prediction = "High" if wind < 25 else "Medium" if wind < 40 else "Low"
            forecast.append({
                "date": date_obj.strftime('%d/%m'),
                "temp_max": f"{res['daily']['temperature_2m_max'][i]}°",
                "temp_min": f"{res['daily']['temperature_2m_min'][i]}°",
                "wind": f"{wind} km/h",
                "link_prob": prediction,
                "status": "Foggy" if res['daily']['weathercode'][i] in [45, 48] else "Clear"
            })
        return forecast
    except: return []

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    tz = pytz.timezone('Europe/Rome')
    now = datetime.now(tz)
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # שאיבת טמפרטורה נוכחית ומעליות מהאתר
        temp = "N/A"
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag: temp = temp_tag.text.strip().replace(' ', '')
        
        lifts_open = "0"
        lifts_tag = soup.select_one('.lifts-info__open')
        if lifts_tag: lifts_open = lifts_tag.text.strip()

        data = {
            "cervinia": {"lifts": f"{lifts_open}/25"},
            "valtournenche": {"lifts": "Open"},
            "zermatt": {"lifts": "Open"},
            "conn": "open" if "open" in res.text.lower() and "zermatt" in res.text.lower() else "closed",
            "temp": temp,
            "wind_prediction": "High" if lifts_open != "0" else "Check Wind", # הערכה נוכחית
            "forecast": get_forecast(),
            "last_update": now.strftime("%H:%M")
        }

        with open('data.json', 'w') as f:
            json.dump(data, f)
        print("Data updated successfully")
            
    except Exception as e:
        print(f"Error updating data: {e}")

if __name__ == "__main__":
    get_data()
