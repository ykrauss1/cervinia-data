import requests
from bs4 import BeautifulSoup
import json

def get_data():
    url = "https://www.cervinia.it/en/info/bollettino-neve"
    # זה החלק החשוב - גורם לאתר לא לחסום אותנו
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # חיפוש נתוני השלג - עדכנתי את השמות לפי המבנה החדש
        snow_values = soup.select('.snow-report__value')
        town_snow = snow_values[0].text.strip() if len(snow_values) > 0 else "N/A"
        peak_snow = snow_values[1].text.strip() if len(snow_values) > 1 else "N/A"
        
        # חיפוש סטטוס חיבור (זארמט)
        conn_status = "closed"
        if "zermatt" in response.text.lower() and "open" in response.text.lower():
            conn_status = "open"

        data = {
            "town": town_snow,
            "peak": peak_snow,
            "lifts": "Open", 
            "conn": conn_status
        }
        
        with open('data.json', 'w') as f:
            json.dump(data, f)
        print("Data updated!")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_data()
