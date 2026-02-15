// === UI START ===

// פתיחת מודל
function openM(id) {
    document.getElementById(id).style.display = 'flex';
}

// סגירת מודל
function closeM(id) {
    document.getElementById(id).style.display = 'none';
}

// ספירת מבוגרים/ילדים/חדרים (אם יש אצלך במודל)
function c(id, v) {
    const el = document.getElementById(id);
    let n = parseInt(el.innerText);

    n += v;
    if (n < 0) n = 0;

    el.innerText = n;
}

// === UI END ===
