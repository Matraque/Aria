const bodyEl = document.body;

const STATUS_SUCCESS = "success";
const STATUS_ERROR = "error";

const LOADING_STEPS = [
    "Création de ta playlist…",
    "Sélection des titres…",
    "Ajout des morceaux dans Spotify…",
    "Presque prêt…"
];

let loadingStepIndex = 0;

const loaderTitleEl = document.getElementById("loader-title");
const loaderStepEl = document.getElementById("loader-step");
const errorEl = document.getElementById("error-msg");
const progressBarEl = document.querySelector(".progress-bar-shell");
const manualCloseEl = document.getElementById("manual-close-msg");

const status = bodyEl.dataset.status || STATUS_SUCCESS;
const statusMessage = bodyEl.dataset.message || "";

let stepTimer = null;

const AUTH_PENDING_STORAGE_KEY = "ariaSpotifyAuthPending";
const AUTH_RESULT_STORAGE_KEY = "ariaSpotifyAuthResult";

function clearPendingMarker() {
    try {
        localStorage.removeItem(AUTH_PENDING_STORAGE_KEY);
    } catch (err) {
        console.error("Impossible de nettoyer le marqueur auth Spotify", err);
    }
}

function broadcastAuthResult(statusValue, extraPayload = {}) {
    try {
        let pendingId = null;
        const raw = localStorage.getItem(AUTH_PENDING_STORAGE_KEY);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                pendingId = parsed && parsed.id ? parsed.id : null;
            } catch (parseErr) {
                console.error("Impossible de parser le marqueur auth Spotify", parseErr);
            }
        }
        const payload = {
            id: pendingId,
            status: statusValue,
            timestamp: Date.now(),
            ...extraPayload,
        };
        localStorage.setItem(AUTH_RESULT_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
        console.error("Impossible de diffuser le statut auth Spotify", err);
    }
}

function startStepCycle() {
    if (stepTimer) {
        clearInterval(stepTimer);
    }
    stepTimer = setInterval(() => {
        loadingStepIndex = (loadingStepIndex + 1) % LOADING_STEPS.length;
        loaderStepEl.textContent = LOADING_STEPS[loadingStepIndex];
    }, 10000);
}

function stopStepCycle() {
    if (stepTimer) {
        clearInterval(stepTimer);
        stepTimer = null;
    }
}

function notifyOpener(payload) {
    if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
    }
}

function handleSuccess() {
    stopStepCycle();

    broadcastAuthResult("success");
    clearPendingMarker();

    if (window.opener && !window.opener.closed) {
        loaderTitleEl.textContent = "Connexion réussie";
        loaderStepEl.textContent = "Retourne sur l’onglet Aria, on termine la playlist pour toi.";
        if (progressBarEl) {
            progressBarEl.style.display = "none";
        }
        if (manualCloseEl) {
            manualCloseEl.style.display = "block";
        }

        notifyOpener({ type: "spotify-auth-success" });

        try {
            window.opener.focus();
        } catch (focusErr) {
            console.error("focus opener failed", focusErr);
        }

        setTimeout(() => {
            window.close();
        }, 1200);
    } else {
        loaderTitleEl.textContent = "Connexion réussie";
        loaderStepEl.textContent = "Retour vers Aria…";
        if (progressBarEl) {
            progressBarEl.style.display = "none";
        }
        if (manualCloseEl) {
            manualCloseEl.style.display = "none";
        }
        notifyOpener({ type: "spotify-auth-success" });
        setTimeout(() => {
            window.location.replace("/");
        }, 900);
    }
}

function handleError() {
    stopStepCycle();
    loaderTitleEl.textContent = "Connexion Spotify interrompue";
    loaderStepEl.textContent = statusMessage || "Réessaie la génération depuis Aria.";
    if (progressBarEl) {
        progressBarEl.style.display = "none";
    }
    errorEl.style.display = "block";
    errorEl.textContent = statusMessage || "Erreur inconnue.";

    broadcastAuthResult("error", {
        error: statusMessage || "unknown_error",
    });
    clearPendingMarker();

    notifyOpener({
        type: "spotify-auth-error",
        error: statusMessage || "unknown_error",
    });
}

window.addEventListener("DOMContentLoaded", () => {
    if (status === STATUS_ERROR) {
        handleError();
    } else {
        handleSuccess();
    }
});
