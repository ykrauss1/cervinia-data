// === AUTH START ===

// הצגת שם המשתמש או כפתור התחברות
function renderHeader() {
    const area = document.getElementById('auth-area');

    if (user) {
        const isAdmin = (user.email === 'ykrauss1@gmail.com');

        area.innerHTML = `
            <div>
                ${isAdmin ? '<span class="admin-badge">ADMIN</span>' : ''}
                <b>${user.name}</b> |
                <a href="#" onclick="logout()" style="color:#888;">התנתק</a>
            </div>
        `;
    } else {
        area.innerHTML = `
            <button onclick="openM('authModal')" class="service-btn">כניסה</button>
        `;
    }
}

// התחברות / רישום
function handleAuth() {
    const n = document.getElementById('authName').value;
    const e = document.getElementById('authEmail').value;

    if (n && e) {
        user = { name: n, email: e };
        localStorage.setItem('skiUser', JSON.stringify(user));
        location.reload();
    }
}

// התנתקות
function logout() {
    localStorage.removeItem('skiUser');
    location.reload();
}

// === AUTH END ===
