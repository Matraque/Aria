// Texte step-by-step qui défile pendant qu'on bosse
const LOADING_STEPS = [
    "Création de ta playlist…",
    "Sélection des titres…",
    "Ajout des morceaux dans Spotify…",
    "Presque prêt…"
];

let loadingStepIndex = 0;
const loaderStepEl = document.getElementById('loader-step');
const errorEl = document.getElementById('error-msg');

let stepTimer = setInterval(() => {
    loadingStepIndex = (loadingStepIndex + 1) % LOADING_STEPS.length;
    loaderStepEl.textContent = LOADING_STEPS[loadingStepIndex];
}, 10000);

// Dès que la page se charge, on termine la génération côté serveur
// et quand c'est bon -> on renvoie l'utilisateur sur "/"
async function finishGeneration() {
    try {
        const res = await fetch("/finish_generation", {
            method: "POST",
        });

        if (!res.ok) {
            throw new Error("finish_generation failed");
        }

        const data = await res.json();
        if (data.ok) {
            // Résultat stocké en session => la home pourra l'afficher
            window.location.href = "/";
            return;
        } else {
            throw new Error("server said not ok");
        }
    } catch (err) {
        console.error(err);
        clearInterval(stepTimer);
        loaderStepEl.textContent = "Échec de la génération.";
        errorEl.style.display = "block";
    }
}

// lancer dès que le DOM est prêt
window.addEventListener("DOMContentLoaded", finishGeneration);
