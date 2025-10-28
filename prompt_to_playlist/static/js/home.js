const LOADING_STEPS = [
    "Création de ta playlist…",
    "Sélection des titres…",
    "Ajout des morceaux dans Spotify…",
    "Presque prêt…"
];

let loadingStepIndex = 0;
let loadingInterval = null;

const formEl = document.getElementById('generate-form');
const btnEl = document.getElementById('generate-btn');
const overlayEl = document.getElementById('loading-overlay');
const loaderStepEl = document.getElementById('loader-step');

const resultCardEl = document.getElementById('result-card');
const playlistNameEl = document.getElementById('playlist-name');
const playlistUrlBtnEl = document.getElementById('playlist-url-btn');
const resultSummaryEl = document.getElementById('result-summary');

function showOverlay() {
    overlayEl.classList.add('active');
    loadingStepIndex = 0;
    loaderStepEl.textContent = LOADING_STEPS[0];

    loadingInterval = setInterval(() => {
        loadingStepIndex = (loadingStepIndex + 1) % LOADING_STEPS.length;
        loaderStepEl.textContent = LOADING_STEPS[loadingStepIndex];
    }, 10000);
}

function hideOverlay() {
    overlayEl.classList.remove('active');
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
}

function lockButton() {
    btnEl.disabled = true;
    btnEl.style.opacity = '0.7';
    btnEl.style.cursor = 'default';
    btnEl.textContent = 'Génération en cours…';
}

function unlockButton() {
    btnEl.disabled = false;
    btnEl.style.opacity = '1';
    btnEl.style.cursor = 'pointer';
    btnEl.textContent = 'Générer ma playlist';
}

async function handleSubmit(e) {
    e.preventDefault();

    const promptVal = document.getElementById('prompt').value.trim();
    if (!promptVal) {
        return; // pas de prompt => rien
    }

    lockButton();
    showOverlay();

    try {
        const formData = new FormData();
        formData.append('prompt', promptVal);

        const res = await fetch('/generate_async', {
            method: 'POST',
            body: formData,
        });

        // si on doit lier Spotify -> on redirige
        if (res.status === 401) {
            const data = await res.json();
            if (data.need_auth && data.auth_url) {
                window.location.href = data.auth_url;
                return;
            }
        }

        if (!res.ok) {
            throw new Error("Erreur serveur");
        }

        const data = await res.json();
        // data = { summary, playlist_url, playlist_name }

        // On met à jour l'UI :
        playlistNameEl.textContent = data.playlist_name || "Ta playlist est prête";

        if (data.playlist_url) {
            playlistUrlBtnEl.href = data.playlist_url;
            playlistUrlBtnEl.style.display = 'inline-block';
        } else {
            playlistUrlBtnEl.style.display = 'none';
        }

        if (data.summary) {
            resultSummaryEl.textContent = data.summary;
            resultSummaryEl.style.display = 'block';
        } else {
            resultSummaryEl.style.display = 'none';
        }

        // afficher la card résultat si pas déjà visible
        if (!resultCardEl.classList.contains('show')) {
            resultCardEl.classList.add('show');
        }

    } catch (err) {
        console.error(err);
        alert("Désolé, un truc a cassé pendant la génération.");
    } finally {
        hideOverlay();
        unlockButton();
    }
}

formEl.addEventListener('submit', handleSubmit);

// -----------------------------------------------------------------
// ORBE INTERACTIVE (boule qui flotte)
//
// - le wrapper (.sphere-wrapper) se déplace vers le curseur + scale
// - la boule reste parfaitement ronde (pas de rotateX/rotateY pizza)
// - on déplace SEULEMENT un peu la lumière pour simuler le "roll"
//   mais pas assez pour que ça fasse un oeil
// -----------------------------------------------------------------

const sphereWrappers = Array.from(document.querySelectorAll('.sphere-wrapper'));

// on construit un petit state par boule
const spheres = sphereWrappers.map(wrapper => {
    const inner = wrapper.querySelector('.sphere');
    return {
        wrapper,
        inner,
        // état affiché:
        dx: 0,
        dy: 0,
        scale: 1,
        // cible:
        targetDx: 0,
        targetDy: 0,
        targetScale: 1,
        // géométrie:
        cx: 0,
        cy: 0,
        w: 0,
        h: 0,
    };
});

function updateSphereRects() {
    spheres.forEach(s => {
        const rect = s.wrapper.getBoundingClientRect();
        s.w = rect.width;
        s.h = rect.height;
        s.cx = rect.left + rect.width / 2;
        s.cy = rect.top + rect.height / 2;
    });
}

updateSphereRects();
window.addEventListener('resize', updateSphereRects);
window.addEventListener('scroll', updateSphereRects, { passive: true });

window.addEventListener('pointermove', (evt) => {
    const { clientX, clientY } = evt;

    spheres.forEach(s => {
        const dxPx = clientX - s.cx;
        const dyPx = clientY - s.cy;

        // normalisation sur une plage contrôlée
        const RANGE = 120;
        let ndx = dxPx / RANGE;
        let ndy = dyPx / RANGE;
        ndx = Math.max(-1, Math.min(1, ndx));
        ndy = Math.max(-1, Math.min(1, ndy));

        s.targetDx = ndx;
        s.targetDy = ndy;

        // distance curseur -> sphère
        const dist = Math.hypot(dxPx, dyPx);

        // effet magnétique (elle gonfle si tu t'approches)
        if (dist < 80) {
            s.targetScale = 1.12;
        } else if (dist < 140) {
            s.targetScale = 1.06;
        } else {
            s.targetScale = 1.0;
        }
    });
});

function lerp(current, target, smooth) {
    return current + (target - current) * smooth;
}

function animateSpheres() {
    spheres.forEach(s => {
        // easing doux, vivant
        s.dx = lerp(s.dx, s.targetDx, 0.08);
        s.dy = lerp(s.dy, s.targetDy, 0.08);
        s.scale = lerp(s.scale, s.targetScale, 0.08);

        // translation physique de la boule vers le curseur
        const MOVE_PX = 12;
        const tx = s.dx * MOVE_PX;
        const ty = s.dy * MOVE_PX;

        // applique translate+scale au WRAPPER (garde la boule frontale)
        s.wrapper.style.transform =
            `translate3d(${tx}px, ${ty}px, 0) scale(${s.scale})`;

        // on simule un léger "roll" de la sphère en décalant PEU la lumière
        const LIGHT_SHIFT_PCT = 5; // très léger -> pas l'effet oeil
        const lx = 30 + s.dx * LIGHT_SHIFT_PCT;
        const ly = 25 + s.dy * LIGHT_SHIFT_PCT;

        s.inner.style.setProperty('--light-x', lx + '%');
        s.inner.style.setProperty('--light-y', ly + '%');
    });

    requestAnimationFrame(animateSpheres);
}

requestAnimationFrame(animateSpheres);
