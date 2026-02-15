// === MAIN START ===

// טוען משתמש מה-localStorage
let user = JSON.parse(localStorage.getItem('skiUser') || 'null');

// אתחול כללי של האתר
window.onload = () => {
    renderHeader();   // מתוך auth.js
    loadW();          // מתוך weather.js
    loadF();          // מתוך forum.js

    // הפעלת flatpickr
    flatpickr("#dateRange", { 
        mode: "range", 
        minDate: "today" 
    });
};

// === MAIN END ===
