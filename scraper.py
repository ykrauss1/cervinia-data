import os
import json
import time
import re
from datetime import datetime
import pytz
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
import requests

def get_weather_and_forecast():
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max,showers_sum&timezone=Europe%2FRome"
    try:
        res = requests.get(url).json()
        days = []
        for i in range(4):
            days.append({
                "date": res['daily']['time'][i],
                "temp_max": f"{res['daily']['temperature_2m_max'][i]}°C",
                "temp_min": f"{res['daily']['temperature_2m_min'][i]}°C",
                "wind": f"{res['daily']['windspeed_10m_max'][i]} km/h",
                "visibility": "טובה" if res['daily']['showers_sum'][i] < 2 else "מוגבלת",
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 30 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def scrape_cervinia():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    # התחזות מלאה לדפדפן Chrome אמיתי
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        driver.get("https://www.cervinia.it/en/info/bollettino-neve")
        time.sleep(15) # המתנה משמעותית לטעינת ה-JavaScript
        
        # ניסיון חילוץ נתונים מה-HTML המלא
        html = driver.page_source
        soup = BeautifulSoup(html, 'html.parser')
        text = soup.get_text()
        
        # חיפוש תבנית מספרים (למשל: "12 / 47" או "12/47")
        lifts = re.search(r'(\d+)\s*/\s*47', text)
        slopes = re.search(r'(\d+)\s*/\s*109', text)
        
        if lifts: results["lifts"] = f"{lifts.group(1)}/47"
        if slopes: results["slopes"] = f"{slopes.group(1)}/109"
        
        # בדיקת זארמט - חיפוש מילה 'Zermatt' וסטטוס 'Open' בקרבתה
        z_area = re.search(r'Zermatt.*?Open', text, re.IGNORECASE | re.DOTALL)
        if z_area or "international pass open" in text.lower():
            results["conn"] = "open"
            
    except Exception as e:
        print(f"Scrape Error: {e}")
    finally:
        driver.quit()
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast_data, current_temp = get_weather_and_forecast()
    live_data = scrape_cervinia()
    
    final_output = {
        "lifts": live_data["lifts"],
        "slopes": live_data["slopes"],
        "conn": live_data["conn"],
        "temp": current_temp,
        "forecast": forecast_data,
        "last_update": datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(final_output, f, indent=4)
