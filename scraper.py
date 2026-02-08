import requests
import json
from datetime import datetime
import pytz

def get_forecast():
    # קואורדינטות של Plateau Rosa (הקישור לזארמט)
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,weathercode&timezone=Europe%2FRome"
    try:
        res = requests.get(url, timeout=10).json()
        forecast = []
        for i in range(4): # 4 ימים קדימה
            date_str = res['daily']['time'][i]
            date_obj = datetime.strptime(date_str, '%Y-%m-%d')
            
            # לוגיקה פשוטה לחיזוי פתיחת קישור (מבוסס רוח)
            wind = res['daily']['windspeed_10m_max'][i]
            prediction = "High" if wind < 30 else "Medium" if wind < 50 else "Low"
            
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
    # ... (כאן נשאר הקוד הקיים של שאיבת הנתונים החיים מהאתר) ...
    
    data = {
        # הנתונים הקיימים (מעליות, טמפרטורה נוכחית וכו')
        "forecast": get_forecast(),
        "last_update": datetime.now(pytz.timezone('Europe/Rome')).strftime("%H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(data, f)

if __name__ == "__main__":
    get_data()
