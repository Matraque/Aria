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

async function finishGenerationHere() {
    try {
        const res = await fetch("/finish_generation", {
            method: "POST",
        });

        if (!res.ok) {
            throw new Error("finish_generation failed");
        }

        const data = await res.json();
        if (data.ok) {
            notifyOpener({
                type: "spotify-auth-success",
                result: data.result || null,
            });
            window.location.href = "/";
            return;
        }
        throw new Error("server said not ok");
    } catch (err) {
        console.error(err);
        stopStepCycle();
        loaderTitleEl.textContent = "Échec de la génération.";
        loaderStepEl.textContent = "Recharge Aria et réessaie.";
        errorEl.style.display = "block";
        errorEl.textContent = "Impossible de terminer la génération automatiquement.";
        notifyOpener({
            type: "spotify-auth-error",
            error: err && err.message ? err.message : "unknown_error",
        });
    }
}

function handleSuccess() {
    stopStepCycle();

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
        loaderTitleEl.textContent = "Aria finalise ta playlist…";
        loaderStepEl.textContent = LOADING_STEPS[0];
        startStepCycle();
        finishGenerationHere();
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
