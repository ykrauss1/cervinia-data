import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_forecast():
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,weathercode&timezone=Europe%2FRome"
    try:
        res = requests.get(url, timeout=10).json()
        forecast_list = []
        for i in range(4):
            date_str = res['daily']['time'][i]
            date_obj = datetime.strptime(date_str, '%Y-%m-%d')
            wind = res['daily']['windspeed_10m_max'][i]
            prediction = "High" if wind < 25 else "Medium" if wind < 40 else "Low"
            forecast_list.append({
                "date": date_obj.strftime('%d/%m'),
                "temp_max": f"{res['daily']['temperature_2m_max'][i]}°",
                "temp_min": f"{res['daily']['temperature_2m_min'][i]}°",
                "wind": f"{wind} km/h",
                "link_prob": prediction,
                "status": "Foggy" if res['daily']['weathercode'][i] in [45, 48] else "Clear"
            })
        return forecast_list
    except: return []

def get_live_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    live = {"temp": "N/A", "lifts": "--/25", "conn": "closed"}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # חיפוש טמפרטורה
        temp_tag = soup.select_one('.weather-info__temp, .temp, [class*="temp"]')
        if temp_tag: live["temp"] = temp_tag.text.strip().replace(' ', '')
        
        # חיפוש מעליות - נסיון אגרסיבי יותר
        # אנחנו מחפשים כל אלמנט שנושא את המספר של המעליות הפתוחות
        lifts_tag = soup.select_one('.lifts-info__open, .open-lifts, .lifts .value')
        if lifts_tag:
            val = lifts_tag.text.strip()
            if val.isdigit():
                live["lifts"] = f"{val}/25"
            else:
                # אם זה לא רק מספר, ננקה תווים מיותרים
                import re
                numbers = re.findall(r'\d+', val)
                if numbers: live["lifts"] = f"{numbers[0]}/25"

        if "open" in res.text.lower() and "zermatt" in res.text.lower():
            live["conn"] = "open"
            
    except Exception as e: print(f"Scrape Error: {e}")
    return live

def run_update():
    tz = pytz.timezone('Europe/Rome')
    data = {
        **get_live_data(),
        "forecast": get_forecast(),
        "last_update": datetime.now(tz).strftime("%H:%M")
    }
    # תיקון מבנה הנתונים שיתאים ל-HTML
    final_data = {
        "cervinia": {"lifts": data["lifts"]},
        "valtournenche": {"lifts": "Open"},
        "zermatt": {"lifts": "Open"},
        "conn": data["conn"],
        "temp": data["temp"],
        "wind_prediction": "High" if "/25" in data["lifts"] and data["lifts"].split('/')[0] != "0" else "Low/Closed",
        "forecast": data["forecast"],
        "last_update": data["last_update"]
    }
    with open('data.json', 'w') as f:
        json.dump(final_data, f)

if __name__ == "__main__":
    run_update()
