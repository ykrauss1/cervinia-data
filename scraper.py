import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_forecast():
    # קואורדינטות של Plateau Rosa (הקישור לזארמט)
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,weathercode&timezone=Europe%2FRome"
    try:
        res = requests.get(url, timeout=10).json()
        forecast_list = []
        for i in range(4):
            date_str = res['daily']['time'][i]
            date_obj = datetime.strptime(date_str, '%Y-%m-%d')
            wind = res['daily']['windspeed_10m_max'][i]
            # לוגיקה לסיכוי קישור מבוססת רוח
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
    live = {"temp": "N/A", "lifts": "0/47", "slopes": "0/109", "conn": "closed"}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # טמפרטורה
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag: live["temp"] = temp_tag.text.strip().replace(' ', '')
        
        # מעליות פתוחות מתוך 47
        lifts_open = soup.select_one('.lifts-info__open')
        if lifts_open: live["lifts"] = f"{lifts_open.text.strip()}/47"
            
        # מסלולים פתוחים מתוך 109
        slopes_open = soup.select_one('.slopes-info__open')
        if slopes_open: live["slopes"] = f"{slopes_open.text.strip()}/109"

        # בדיקת סטטוס קישור
        if "open" in res.text.lower() and "zermatt" in res.text.lower():
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
        "wind_prediction": "High" if "47/47" in live["lifts"] else "Check Wind",
        "forecast": get_forecast(),
        "last_update": datetime.now(tz).strftime("%H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(final_data, f)

if __name__ == "__main__":
    run_update()
