import os
import json
import time
from datetime import datetime
import pytz
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
import requests

def get_forecast():
    # שאיבת תחזית מ-Open-Meteo
    url = "https://api.open-meteo.com/v1/forecast?latitude=45.93&longitude=7.70&daily=temperature_2m_max,temperature_2m_min,windspeed_10m_max&timezone=Europe%2FRome"
    try:
        res = requests.get(url).json()
        return res['daily']['temperature_2m_max'][0] # מחזיר טמפ' נוכחית מקסימלית להיום
    except: return "N/A"

def scrape_cervinia():
    chrome_options = Options()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    
    data = {"lifts": "N/A", "slopes": "N/A", "conn": "closed", "temp": "N/A"}
    
    try:
        driver.get("https://www.cervinia.it/en/info/bollettino-neve")
        time.sleep(5) # מחכה שהאתר יטען
        soup = BeautifulSoup(driver.page_source, 'html.parser')
        text = soup.get_text()

        # חילוץ מעליות (מחפש את המבנה X / 47)
        import re
        lifts = re.search(r'(\d+)\s*/\s*47', text)
        if lifts: data["lifts"] = f"{lifts.group(1)}/47"

        # חילוץ מסלולים (X / 109)
        slopes = re.search(r'(\d+)\s*/\s*109', text)
        if slopes: data["slopes"] = f"{slopes.group(1)}/109"

        # בדיקת קישור לזארמט
        if "zermatt" in text.lower():
            # מחפש מילים ירוקות או סטטוס פתוח ליד המילה Zermatt
            z_section = soup.find(text=re.compile("Zermatt", re.I))
            if z_section and ("open" in z_section.parent.get_text().lower() or "aperto" in z_section.parent.get_text().lower()):
                data["conn"] = "open"

        data["temp"] = f"{get_forecast()}°C"
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        driver.quit()
    
    return data

if __name__ == "__main__":
    tz = pytz.timezone('Europe/Rome')
    live_results = scrape_cervinia()
    live_results["last_update"] = datetime.now(tz).strftime("%d/%m/%Y %H:%M")
    
    with open('data.json', 'w') as f:
        json.dump(live_results, f, indent=4)
