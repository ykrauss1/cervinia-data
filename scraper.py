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
            # תחזית סיכוי קישור מבוססת רוח ב-Plateau Rosa
            prediction = "High" if wind < 25 else "Medium" if wind < 45 else "Low"
            forecast_list.append({
                "date": date_obj.strftime('%d/%m'),
                "temp_max": f"{res['daily']['temperature_2m_max'][i]}°",
                "temp_min": f"{res['daily']['temperature_2m_min'][i]}°",
                "wind": f"{wind} km/h",
                "link_prob": prediction
            })
        return forecast_list
    except: return []

def get_live_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    live = {"temp": "N/A", "lifts": "N/A", "slopes": "N/A", "conn": "closed"}
    
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')
        text = res.text

        # 1. טמפרטורה - חיפוש בתוך אזור Plateau Rosa ספציפי אם קיים
        temp_match = re.search(r'(-?\d+)\s*°', text)
        if temp_match: live["temp"] = f"{temp_match.group(1)}°C"

        # 2. מעליות - חיפוש אלמנט עם class ספציפי של האתר
        lifts_area = soup.find('div', string=re.compile('Lifts', re.I))
        if lifts_area:
            val = lifts_area.find_next('span')
            if val: live["lifts"] = f"{val.text.strip()}/47"
        
        # ניסיון חילוץ רגולרי אם ה-HTML לא תואם
        if live["lifts"] == "N/A":
            l_match = re.search(r'(\d+)\s*/\s*47', text)
            if l_match: live["lifts"] = f"{l_match.group(1)}/47"

        # 3. מסלולים
        slopes_match = re.search(r'(\d+)\s*/\s*109', text)
        if slopes_match: live["slopes"] = f"{slopes_match.group(1)}/109"

        # 4. סטטוס קישור לזארמט (Zermatt)
        # מחפש את המילה Zermatt ובודק אם מופיעה לידה מילה חיובית
        zermatt_section = re.search(r'Zermatt.*?(Open|Closed|Aperto|Chiuso)', text, re.I | re.S)
        if zermatt_section:
            status = zermatt_section.group(1).lower()
            if status in ['open', 'aperto']:
                live["conn"] = "open"
            
    except Exception as e: 
        print(f"Scrape Error: {e
