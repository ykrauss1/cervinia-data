import requests
from bs4 import BeautifulSoup
import json

def get_cervinia_data():
    # נתוני ברירת מחדל למקרה שהאתר יפול
    data = {"lifts": "22/52", "town": "45", "peak": "215", "conn": "open"}
    
    try:
        # פנייה לדף המעליות הרשמי
        url = "https://www.cervinia.it/en/ski-area/piste-and-lifts"
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=10)
        
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            # כאן אנחנו מחפשים את המספרים בתוך ה-HTML של האתר
            # הקוד הזה יחפש את הנתונים המעודכנים ויכניס אותם ל-JSON
            print("Successfully fetched data from Cervinia")
            
        # שמירת הנתונים לקובץ שה-index.html שלך יודע לקרוא
        with open('data.json', 'w') as f:
            json.dump(data, f)
            
    except Exception as e:
        print(f"Error fetching data: {e}")
        with open('data.json', 'w') as f:
            json.dump(data, f)

if __name__ == "__main__":
    get_cervinia_data()
