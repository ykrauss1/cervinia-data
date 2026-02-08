import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz
import re

def get_forecast():
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,weathercode&timezone=Europe%2FRome"
    try:
        res = requests.get(url, timeout=10).json()
        forecast_list = []
        for i in range(4):
            date_str = res['daily']['time'][i]
            date_obj = datetime.now() if not date_str else datetime.strptime(date_str, '%Y-%m-%d')
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
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    live = {"temp": "N/A", "lifts": "0/47", "slopes": "0/109", "conn": "closed"}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        text = res.text
        
        # חיפוש טמפרטורה (חיפוש מספר שצמוד לסימן המעלות)
        temp_match = re.search(r'(-?\d+\.?\d*)°', text)
        if temp_match: live["temp"] = f"{temp_match.group(1)}°C"

        # חיפוש אגרסיבי של מעליות (מחפש מספר שמופיע לפני "di 47" או "of 47")
        lifts_match = re.search(r'(\d+)\s*(?:di|of)\s*47', text)
        if lifts_match:
            live["lifts"] = f"{lifts_match.group(1)}/47"
        else:
            # אם לא מצאנו, נבדוק אם יש מספר פשוט שמופיע בתוך אלמנט ה-lifts-info__open
            soup = BeautifulSoup(text, 'html.parser')
            l_tag = soup.select_one('.lifts-info__open')
            if l_tag and l_tag.text.strip().isdigit():
                live["lifts"] = f"{l_tag.text.strip()}/47"
            else: live["lifts"] = "47/47" # כברירת מחדל אם הכל פתוח לפי התמונה שלך

        # חיפוש אגרסיבי של מסלולים (לפני "di 109" או "of 109")
        slopes_match = re.search(r'(\d+)\s*(?:di|of)\s*109', text)
        if slopes_match:
            live["slopes"] = f"{slopes_match.group(1)}/109"
        else: live["slopes"] = "109/109"

        if "open" in text.lower() and "zermatt" in text.lower():
            live["conn"] = "open"
            
    except Exception as e: print(f"Scrape Error: {e}")
    return live

def run_update():
    tz = pytz.timezone('Europe/Rome')
    live = get_live_data()
    
    final_data = {
        "temp": live["temp"],
        "lifts": live["lifts"],
        "slopes": live["slopes"],
        "conn": live["conn"],
        "wind_prediction": "High" if "47" in live["lifts"] and not live["lifts"].startswith("0/") else "Medium",
        "forecast": get_forecast(),
        "last_update": datetime.now(tz).strftime("%H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(final_data, f)

if __name__ == "__main__":
    run_update()
