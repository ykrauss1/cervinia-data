// === FORUM START ===

// טעינת פוסטים מהשרת
async function loadF() {
    const res = await fetch(`${API}/posts?select=*,replies(*)&order=created_at.desc`, HEAD);
    const data = await res.json();

    const isAdmin = user && user.email === 'ykrauss1@gmail.com';

    document.getElementById('f-container').innerHTML = data.map(p => `
        <div class="post">
            ${isAdmin ? `
                <span style="color:red; cursor:pointer; float:left;" onclick="del('posts','${p.id}')">
                    <i class="fa-solid fa-trash-can"></i>
                </span>` : ''}

            <b>${p.user}</b>
            <div style="margin:8px 0;">${p.content}</div>

            <span style="color:var(--accent); cursor:pointer; font-size:0.85rem; font-weight:bold;"
                  onclick="openRBox('${p.id}', '${p.user}', this)">
                השב
            </span>

            <div class="r-target"></div>

            ${(p.replies || []).map(r => `
                <div class="reply-item">
                    <b>${r.user}:</b> ${r.content}
                    <div style="margin-top:5px;">
                        <span style="color:var(--accent); cursor:pointer; font-size:0.75rem;"
                              onclick="openRBox('${p.id}', '${r.user}', this)">
                            השב
                        </span>
                        <div class="r-target"></div>
                    </div>
                </div>
            `).join('')}
        </div>
    `).join('');
}

// פתיחת תיבת תגובה
function openRBox(pId, toUser, el) {
    const target = el.nextElementSibling;

    if (target.innerHTML) {
        target.innerHTML = '';
        return;
    }

    const prefix = `@${toUser}: `;

    target.innerHTML = `
        <div style="margin-top:10px; background:#f9f9f9; padding:10px; border-radius:8px; border:1px solid #ddd;">
            <textarea id="in-${pId}" rows="2">${prefix}</textarea>

            <div class="forum-footer">
                <div class="forum-icons">
                    <span style="cursor:pointer; font-size:0.8rem;"
                          onclick="this.parentElement.parentElement.parentElement.innerHTML=''">
                        בטל
                    </span>
                    <i class="fa-solid fa-paperclip"></i>
                </div>

                <button class="service-btn"
                        style="padding:4px 10px; font-size:0.8rem; background:var(--accent); color:white; border:none;"
                        onclick="sendR('${pId}')">
                    שלח
                </button>
            </div>
        </div>
    `;

    const tx = document.getElementById(`in-${pId}`);
    setTimeout(() => {
        tx.focus();
        tx.setSelectionRange(prefix.length, prefix.length);
    }, 50);
}

// שליחת פוסט חדש
async function sendPost() {
    const v = document.getElementById('f-input').value;

    if (!user) return openM('authModal');

    await fetch(`${API}/posts`, {
        method: 'POST',
        headers: HEAD.headers,
        body: JSON.stringify({
            user: user.name,
            content: v.trim()
        })
    });

    document.getElementById('f-input').value = '';
    loadF();
}

// שליחת תגובה
async function sendR(pId) {
    const v = document.getElementById(`in-${pId}`).value;

    if (!user) return openM('authModal');

    await fetch(`${API}/replies`, {
        method: 'POST',
        headers: HEAD.headers,
        body: JSON.stringify({
            post_id: pId,
            user: user.name,
            content: v.trim()
        })
    });

    loadF();
}

// מחיקת פוסט / תגובה (אדמין בלבד)
async function del(tbl, id) {
    if (confirm('למחוק לצמיתות?')) {
        await fetch(`${API}/${tbl}?id=eq.${id}`, {
            method: 'DELETE',
            headers: HEAD.headers
        });
        loadF();
    }
}

// === FORUM END ===
