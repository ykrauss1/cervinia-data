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
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    
    # אתחול לערכים ריקים כדי שנדע אם הסריקה הצליחה
    res = {"lifts": "Updating...", "slopes": "Updating...", "conn": "closed"}
    
    try:
        # סריקה של Bergfex
        driver.get("https://www.bergfex.com/breuil-cervinia/schneebericht/")
        time.sleep(12) # הגדלתי את ההמתנה ליתר ביטחון
        body_text = driver.find_element(By.TAG_NAME, "body").text
        
        # חיפוש מעליות - מחפש תבנית כמו "45 of 47"
        lifts_val = re.search(r'(\d+)\s*of\s*47', body_text, re.I)
        if lifts_val:
            res["lifts"] = f"{lifts_val.group(1)}/47"
        
        # חיפוש מסלולים - מחפש כמה ק"מ פתוחים מתוך 109 או סה"כ מסלולים
        slopes_val = re.search(r'(\d+)\s*of\s*(\d+)\s*km', body_text, re.I)
        if slopes_val:
            # המרה של קילומטרים למספר מסלולים יחסי (109 מסלולים שקולים ל-156 ק"מ)
            current_km = int(slopes_val.group(1))
            total_km = int(slopes_val.group(2))
            res["slopes"] = f"{int((current_km / total_km) * 109)}/109"

        # בדיקת קישור זארמט - בדיקה מחמירה
        # מחפש משפטים כמו "International link is open" או "Connection to Zermatt: Open"
        status_keywords = ["Zermatt", "International", "Matterhorn", "Link"]
        is_open = False
        for key in status_keywords:
            if re.search(key + r'.*?open', body_text, re.I | re.S):
                is_open = True
                break
        
        res["conn"] = "open" if is_open else "closed"

    except Exception as e:
        print(f"Scrape error: {e}")
    finally:
        driver.quit()
    return res

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    forecast, current_temp = get_weather()
    live = scrape_ski_data()
    
    output = {
        "lifts": live["lifts"],
        "slopes": live["slopes"],
        "conn": live["conn"],
        "temp": current_temp,
        "forecast": forecast,
        "last_update": datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    }
    
    with open('data.json', 'w') as f:
        json.dump(output, f, indent=4, ensure_ascii=False)
