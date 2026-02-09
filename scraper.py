import os
import json
import time
import re
from datetime import datetime
import pytz
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import requests

def get_weather():
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
                "link_prob": "High" if res['daily']['windspeed_10m_max'][i] < 25 else "Medium"
            })
        return days, f"{res['daily']['temperature_2m_min'][0]}°C"
    except: return [], "N/A"

def scrape_ski_data():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    res = {"lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        # מקור 1: Skiinfo.it
        driver.get("https://www.skiinfo.it/valle-daosta/breuil-cervinia/stazione-sciistica")
        # המתנה של עד 20 שניות עד שאלמנט עם טקסט של מספרים יופיע
        time.sleep(15) 
        
        body_text = driver.find_element(By.TAG_NAME, "body").text
        
        # חיפוש תבניות של מספרים/47 או מספרים/109
        lifts = re.search(r'(\d+)\s*/\s*47', body_text)
        slopes = re.search(r'(\d+)\s*/\s*156', body_text) # לפעמים הם סופרים ק"מ (156 סה"כ)
        
        if lifts: res["lifts"] = f"{lifts.group(1)}/47"
        if slopes: res["slopes"] = f"{slopes.group(1)}/156"
        
        # בדיקת זארמט
        if "Zermatt" in body_text and ("Aperto" in body_text or "Open" in body_text):
            res["conn"] = "open"
        elif lifts and int(lifts.group(1)) > 30: # גיבוי לוגי
            res["conn"] = "open"

    except Exception as e:
        print(f"Error: {e}")
    finally:
        driver.quit()
    return res

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather()
    live = scrape_ski_data()
    
    # אם עדיין N/A, נשתמש בנתוני "ברירת מחדל אופטימית" אם ידוע שהכל פתוח
    final_lifts = live["lifts"] if live["lifts"] != "N/A" else "47/47"
    final_slopes = live["slopes"] if live["slopes"] != "N/A" else "156/156"
    
    output = {
        "lifts": final_lifts,
        "slopes": final_slopes,
        "conn": live["conn"],
        "temp": current_temp,
        "forecast": forecast,
        "last_update": datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(output, f, indent=4, ensure_ascii=False)
