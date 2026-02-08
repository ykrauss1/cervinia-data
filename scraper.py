import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pytz

def get_wind_prediction():
    try:
        # שואב נתוני רוח מגובה 3500 מטר (Plateau Rosa)
        url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&current_weather=true"
        data = requests.get(url).json()
        wind = data['current_weather']['windspeed']
        if wind > 55: return "סיכוי נמוך (רוחות חזקות)"
        if wind > 35: return "סיכוי בינוני (רוח פעילה)"
        return "סיכוי גבוה (תנאים טובים)"
    except: return "לא ניתן לחיזוי"

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0'}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        tz = pytz.timezone('Europe/Rome')
        now = datetime.now(tz)
        
        # טמפרטורה
        temp = soup.select_one('.weather-info__temp').text.strip() if soup.select_one('.weather-info__temp') else "N/A"

        # כאן אנחנו שואבים נתון כללי ומחלקים אותו לצרכי הדגמה
        # האתר של צ'רביניה נותן לרוב נתון מאוחד, נשכלל את זה כשנראה את המבנה המדויק
        lifts_raw = soup.select_one('.lifts-info__open').text.strip() if soup.select_one('.lifts-info__open') else "0"
        total_raw = soup.select_one('.lifts-info__total').text.strip() if soup.select_one('.lifts-info__total') else "0"

        data = {
            "cervinia": {"lifts": f"{lifts_raw}/{total_raw}"},
            "valtournenche": {"lifts": "0/0"}, # דורש זיהוי סקטור ספציפי
            "zermatt": {"lifts": "0/0"},      # דורש זיהוי סקטור ספציפי
            "conn": "open" if "zermatt" in res.text.lower() and "open" in res.text.lower() else "closed",
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
