const LOADING_STEPS = [
    "Création de ta playlist…",
    "Sélection des titres…",
    "Ajout des morceaux dans Spotify…",
    "Presque prêt…"
];

let loadingStepIndex = 0;
let loadingInterval = null;

const DEFAULT_BUTTON_LABEL = "Générer ma playlist";
const CONNECT_BUTTON_LABEL = "Connexion Spotify en cours…";
const GENERATING_BUTTON_LABEL = "Génération en cours…";
const AUTH_PROMPT_MESSAGE = "Connexion à Spotify en cours…";
const AUTH_WAIT_MESSAGE = "Autorise Aria dans la fenêtre Spotify pour continuer…";
const AUTH_CONFIRM_BUTTON_LABEL = "Valide la connexion dans la fenêtre Spotify…";
const FINALISING_MESSAGE = "Aria recherche des pépites…";

const formEl = document.getElementById('generate-form');
const btnEl = document.getElementById('generate-btn');
const overlayEl = document.getElementById('loading-overlay');
const loaderStepEl = document.getElementById('loader-step');

const resultCardEl = document.getElementById('result-card');
const playlistNameEl = document.getElementById('playlist-name');
const playlistUrlBtnEl = document.getElementById('playlist-url-btn');
const resultSummaryEl = document.getElementById('result-summary');

const initialConnection = (() => {
    const val = window.ARIA_SPOTIFY_CONNECTED;
    if (typeof val === "boolean") {
        return val;
    }
    if (typeof val === "string") {
        return val.toLowerCase() === "true";
    }
    return false;
})();

let isSpotifyConnected = initialConnection;

const initialResult = (() => {
    const val = window.ARIA_INITIAL_RESULT;
    if (!val || typeof val !== "object") {
        return null;
    }
    return val;
})();

const initialPendingPrompt = (() => {
    const val = window.ARIA_PENDING_PROMPT;
    if (typeof val === "string") {
        return val.trim();
    }
    return "";
})();

let autoResumeTriggered = false;

function updateResultCard(agentResult) {
    if (!agentResult) {
        return;
    }

    isSpotifyConnected = true;
    window.ARIA_SPOTIFY_CONNECTED = true;

    playlistNameEl.textContent = agentResult.playlist_name || "Ta playlist est prête";

    if (agentResult.playlist_url) {
        playlistUrlBtnEl.href = agentResult.playlist_url;
        playlistUrlBtnEl.style.display = 'inline-block';
    } else {
        playlistUrlBtnEl.style.display = 'none';
    }

    if (agentResult.summary) {
        resultSummaryEl.textContent = agentResult.summary;
        resultSummaryEl.style.display = 'block';
    } else {
        resultSummaryEl.style.display = 'none';
    }

    if (!resultCardEl.classList.contains('show')) {
        resultCardEl.classList.add('show');
    }
}

function stopOverlayCycling() {
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
}

function setOverlayMessage(message) {
    loaderStepEl.textContent = message;
}

function showOverlay(options = {}) {
    const { message = null, cycling = true } = options;

    overlayEl.classList.add('active');
    stopOverlayCycling();

    if (message) {
        loaderStepEl.textContent = message;
    } else {
        loaderStepEl.textContent = LOADING_STEPS[0];
    }

    if (cycling) {
        loadingStepIndex = 0;
        loadingInterval = setInterval(() => {
            loadingStepIndex = (loadingStepIndex + 1) % LOADING_STEPS.length;
            loaderStepEl.textContent = LOADING_STEPS[loadingStepIndex];
        }, 10000);
    }
}

function hideOverlay() {
    overlayEl.classList.remove('active');
    stopOverlayCycling();
}

function lockButton(label = GENERATING_BUTTON_LABEL) {
    btnEl.disabled = true;
    btnEl.style.opacity = '0.7';
    btnEl.style.cursor = 'default';
    btnEl.textContent = label;
}

function unlockButton() {
    btnEl.disabled = false;
    btnEl.style.opacity = '1';
    btnEl.style.cursor = 'pointer';
    btnEl.textContent = DEFAULT_BUTTON_LABEL;
}

function waitForAuthCompletion(authUrl) {
    const authTab = window.open(authUrl, "_blank");
    if (!authTab) {
        window.location.href = authUrl;
        return Promise.reject({
            code: "navigation",
            message: "Redirection vers Spotify.",
        });
    }

    return new Promise((resolve, reject) => {
        const origin = window.location.origin;
        let pollId = null;

        const cleanup = () => {
            window.removeEventListener("message", onMessage);
            if (pollId !== null) {
                clearInterval(pollId);
                pollId = null;
            }
        };

        const closeTab = () => {
            try {
                if (!authTab.closed) {
                    authTab.close();
                }
            } catch (closeErr) {
                console.error("Impossible de fermer l'onglet Spotify", closeErr);
            }
        };

        const onMessage = (event) => {
            if (event.origin !== origin) {
                return;
            }
            const payload = event.data || {};

            if (payload.type === "spotify-auth-success") {
                cleanup();
                closeTab();
                window.focus();
                resolve();
            } else if (payload.type === "spotify-auth-error") {
                cleanup();
                closeTab();
                reject({
                    code: "auth_error",
                    message: payload.error || "Erreur d'authentification Spotify.",
                });
            }
        };

        window.addEventListener("message", onMessage);

        pollId = window.setInterval(() => {
            if (authTab.closed) {
                cleanup();
                reject({
                    code: "popup_closed",
                    message: "Fenêtre d'authentification fermée avant la validation.",
                });
            }
        }, 600);
    });
}

function buildPromptFormData(promptVal) {
    const formData = new FormData();
    formData.append('prompt', promptVal);
    return formData;
}

async function makeGenerateRequest(promptVal) {
    try {
        return await fetch('/generate_async', {
            method: 'POST',
            body: buildPromptFormData(promptVal),
        });
    } catch (networkErr) {
        throw {
            code: 'network',
            message: "Connexion perdue pendant la génération.",
        };
    }
}

async function runAuthFlow(authUrl, promptVal) {
    stopOverlayCycling();
    setOverlayMessage(AUTH_WAIT_MESSAGE);
    btnEl.textContent = AUTH_CONFIRM_BUTTON_LABEL;

    await waitForAuthCompletion(authUrl);

    setOverlayMessage(FINALISING_MESSAGE);
    btnEl.textContent = GENERATING_BUTTON_LABEL;

    const res = await makeGenerateRequest(promptVal);

    if (res.status === 401) {
        throw {
            code: 'auth_error',
            message: "Connexion à Spotify requise.",
        };
    }

    if (!res.ok) {
        throw new Error("Erreur serveur");
    }

    return await res.json();
}

async function handleSubmit(e) {
    e.preventDefault();

    const promptInputEl = document.getElementById('prompt');
    const promptVal = promptInputEl ? promptInputEl.value.trim() : "";
    if (!promptVal) {
        return; // pas de prompt => rien
    }

    autoResumeTriggered = true;

    const wasConnected = isSpotifyConnected;

    lockButton(wasConnected ? GENERATING_BUTTON_LABEL : CONNECT_BUTTON_LABEL);
    showOverlay({
        message: wasConnected ? LOADING_STEPS[0] : AUTH_PROMPT_MESSAGE,
        cycling: wasConnected,
    });

    try {
        const res = await makeGenerateRequest(promptVal);

        if (res.status === 401) {
            let data = null;
            try {
                data = await res.json();
            } catch (jsonErr) {
                data = null;
            }

            if (data && data.need_auth && data.auth_url) {
                const agentResult = await runAuthFlow(data.auth_url, promptVal);
                updateResultCard(agentResult);
                return;
            }
            throw {
                code: 'auth_error',
                message: "Connexion à Spotify requise.",
            };
        }

        if (!res.ok) {
            throw new Error("Erreur serveur");
        }

        const data = await res.json();
        updateResultCard(data);
    } catch (err) {
        console.error(err);
        if (err && err.code === 'popup_closed') {
            alert("Connexion Spotify annulée avant validation.");
        } else if (err && err.code === 'auth_error') {
            alert(err.message || "Impossible de terminer la connexion à Spotify. Réessaie.");
        } else if (err && err.code === 'network') {
            alert(err.message || "Connexion perdue pendant la génération. Vérifie ta connexion puis réessaie.");
        } else if (err && err.code === 'navigation') {
            // l'onglet a été redirigé vers Spotify, rien à faire ici
        } else {
            alert("Désolé, un truc a cassé pendant la génération.");
        }
    } finally {
        hideOverlay();
        unlockButton();
    }
}

formEl.addEventListener('submit', handleSubmit);

window.addEventListener("DOMContentLoaded", () => {
    if (!autoResumeTriggered && initialPendingPrompt && isSpotifyConnected && !initialResult) {
        autoResumeTriggered = true;
        setTimeout(() => {
            formEl.requestSubmit();
        }, 200);
    }
});

if (initialResult) {
    updateResultCard(initialResult);
}

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
