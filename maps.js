// === MAPS START ===

function loadMap(type) {
    const frame = document.getElementById('map-frame');
    const img = document.getElementById('map-img');

    if (type === 'mymap') {
        frame.style.display = 'none';
        img.style.display = 'block';
        img.src = 'mymap.jpg';
        return;
    }

    img.style.display = 'none';
    frame.style.display = 'block';

    if (type === 'slopes') {
        frame.src = 'https://raw.githubusercontent.com/ykrauss/Cervinia/main/slopesmap.pdf';
    } else {
        frame.src = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2777.6!2d7.6!3d45.9!';
    }
}

// === MAPS END ===
