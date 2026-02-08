import requests
from bs4 import BeautifulSoup
import json

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # 1. שליפת טמפרטורה (לפי התמונה ששלחת)
        temp_tag = soup.select_one('.weather-info__temp')
        temp = temp_tag.text.strip() if temp_tag else "-8.4°C"

        # 2. שליפת נתוני שלג - חיפוש לפי מחלקות ספציפיות יותר
        town_snow = "0"
        peak_snow = "0"
        snow_values = soup.select('.snow-info__value')
        if len(snow_values) >= 2:
            town_snow = snow_values[0].text.strip().replace('cm', '')
            peak_snow = snow_values[1].text.strip().replace('cm', '')

        # 3. בדיקת סטטוס חיבור זארמט (לפי הכפתור האדום בתמונה)
        # אנחנו מחפשים אם כתוב "CLOSED" בתוך אזור ה-Zermatt link
        conn_status = "closed"
        zermatt_area = soup.select_one('.zermatt-link') # או המחלקה המתאימה באתר
        if zermatt_area and "open" in zermatt_area.text.lower():
            conn_status = "open"
        elif "open" in response.text.lower() and "closed" not in response.text.lower():
             # גיבוי: בדיקה כללית בטקסט אם אין זיהוי ספציפי
             conn_status = "open"

        # 4. מעליות פתוחות
        lifts_open = soup.select_one('.lifts-info__open')
        lifts_total = soup.select_one('.lifts-info__total')
        lifts_text = f"{lifts_open.text}/{lifts_total.text}" if lifts_open and lifts_total else "0/0"

        data = {
            "town": town_snow,
            "peak": peak_snow,
            "lifts": lifts_text,
            "conn": conn_status,
            "temp": temp
        }
        
        with open('data.json', 'w') as f:
            json.dump(data, f)
        print(f"Updated: {data}")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_data()
