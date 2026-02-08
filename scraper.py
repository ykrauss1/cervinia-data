def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        tz_italy = pytz.timezone('Europe/Rome')
        now = datetime.now(tz_italy)
        # יום פעילות המעליות (08:30 עד 17:00)
        is_ski_time = (now.hour == 8 and now.minute >= 30) or (9 <= now.hour < 17)

        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # --- ניסיון ראשון: טמפרטורה מהאתר הרשמי (תמיד עדיף) ---
        temp = None
        temp_tag = soup.select_one('.weather-info__temp')
        if temp_tag and temp_tag.text.strip():
            temp = temp_tag.text.strip().replace(' ', '')

        # --- ניסיון שני: אם האתר הרשמי ריק, פונים לגיבוי החיצוני ---
        if not temp or "N/A" in temp:
            temp = get_external_temp()

        # שלג
        snow_values = soup.select('.snow-info__value')
        town_snow = snow_values[0].text.strip().replace('cm','') if len(snow_values) > 0 else "0"
        peak_snow = snow_values[1].text.strip().replace('cm','') if len(snow_values) > 1 else "0"

        # מעליות וחיבור - רק בשעות הפעילות
        if is_ski_time:
            lifts_open = soup.select_one('.lifts-info__open')
            lifts_total = soup.select_one('.lifts-info__total')
            lifts = f"{lifts_open.text}/{lifts_total.text}" if lifts_open and lifts_total else "0/0"
            
            conn = "closed"
            # בדיקה חזקה יותר לחיבור זארמט
            if "zermatt" in response.text.lower() and "open" in response.text.lower() and "closed" not in response.text.lower():
                conn = "open"
        else:
            lifts = "0/0"
            conn = "closed"

        data = {
            "town": town_snow,
            "peak": peak_snow,
            "lifts": lifts,
            "conn": conn,
            "temp": temp,
            "last_update": now.strftime("%H:%M")
        }
        
        with open('data.json', 'w') as f:
            json.dump(data, f)
            
    except Exception as e:
        print(f"Error: {e}")
