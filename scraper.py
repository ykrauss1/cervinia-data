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
    # שאיבת תחזית מפורטת ל-4 ימים
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
                "visibility": "Good" if res['daily']['showers_sum'][i] < 2 else "Low",
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 30 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def scrape_cervinia():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    results = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        driver.get("https://www.cervinia.it/en/info/bollettino-neve")
        time.sleep(7) # מחכה קצת יותר לטעינה מלאה
        soup = BeautifulSoup(driver.page_source, 'html.parser')
        text = soup.get_text()

        # חיפוש חכם יותר למעליות: מוצא את המספר שמופיע לפני המילה lifts או אחרי סימן הלוכסן
        lifts_match = re.search(r'(\d+)\s*/\s*47', text)
        if lifts_match:
            results["lifts"] = f"{lifts_match.group(1)}/47"
        
        slopes_match = re.search(r'(\d+)\s*/\s*109', text)
        if slopes_match:
            results["slopes"] = f"{slopes_match.group(1)}/109"

        # בדיקת זארמט - מחפש את המילה Zermatt ובודק אם מופיע "Open" באותו אזור
        z_element = soup.find(text=re.compile("International pass", re.I)) or soup.find(text=re.compile("Zermatt", re.I))
        if z_element:
            parent_text = z_element.parent.parent.get_text().lower()
            if "open" in parent_text or "aperto" in parent_text:
                results["conn"] = "open"
                
    except Exception as e:
        print(f"Scrape error: {e}")
    finally:
        driver.quit()
    return results

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    
    # הבאת תחזית
    forecast_data, current_temp = get_weather_and_forecast()
    
    # הבאת נתוני מעליות
    live_data = scrape_cervinia()
    
    # איחוד הנתונים
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
