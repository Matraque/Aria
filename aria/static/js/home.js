const LOADING_STEPS = [
    "Building your playlist...",
    "Picking the tracks...",
    "Adding songs to Spotify...",
    "Almost ready..."
];

let loadingStepIndex = 0;
let loadingInterval = null;

const DEFAULT_BUTTON_LABEL = "Generate my playlist";
const CONNECT_BUTTON_LABEL = "Connecting to Spotify...";
const GENERATING_BUTTON_LABEL = "Generating...";
const AUTH_PROMPT_MESSAGE = "Connecting to Spotify...";
const AUTH_WAIT_MESSAGE = "Authorize Aria in the Spotify window to continue...";
const AUTH_CONFIRM_BUTTON_LABEL = "Approve the connection in the Spotify window...";
const FINALISING_MESSAGE = "Aria is digging for gems...";
const AUTH_PENDING_STORAGE_KEY = "ariaSpotifyAuthPending";
const AUTH_RESULT_STORAGE_KEY = "ariaSpotifyAuthResult";

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

function generateAuthSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
    }
    return `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function markAuthPending(sessionId) {
    try {
        localStorage.setItem(
            AUTH_PENDING_STORAGE_KEY,
            JSON.stringify({ id: sessionId, ts: Date.now() }),
        );
    } catch (err) {
        console.warn("Failed to save Spotify auth state", err);
    }
}

function clearAuthPending(sessionId) {
    try {
        if (!sessionId) {
            localStorage.removeItem(AUTH_PENDING_STORAGE_KEY);
            return;
        }
        const raw = localStorage.getItem(AUTH_PENDING_STORAGE_KEY);
        if (!raw) {
            return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.id === sessionId) {
            localStorage.removeItem(AUTH_PENDING_STORAGE_KEY);
        }
    } catch (err) {
        console.warn("Failed to clear Spotify auth state", err);
    }
}

function clearAuthResult(sessionId) {
    try {
        if (!sessionId) {
            localStorage.removeItem(AUTH_RESULT_STORAGE_KEY);
            return;
        }
        const raw = localStorage.getItem(AUTH_RESULT_STORAGE_KEY);
        if (!raw) {
            return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.id === sessionId) {
            localStorage.removeItem(AUTH_RESULT_STORAGE_KEY);
        }
    } catch (err) {
        console.warn("Failed to clear Spotify auth result", err);
    }
}

function updateResultCard(agentResult) {
    if (!agentResult) {
        return;
    }

    window.ARIA_INITIAL_RESULT = agentResult;

    isSpotifyConnected = true;
    window.ARIA_SPOTIFY_CONNECTED = true;

    playlistNameEl.textContent = agentResult.playlist_name || "Your playlist is ready";

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
    const authSessionId = generateAuthSessionId();
    clearAuthResult();
    markAuthPending(authSessionId);

    const authTab = window.open(authUrl, "_blank");
    if (!authTab) {
        clearAuthPending(authSessionId);
        clearAuthResult(authSessionId);
        window.location.href = authUrl;
        return Promise.reject({
            code: "navigation",
            message: "Redirecting to Spotify.",
        });
    }

    return new Promise((resolve, reject) => {
        const origin = window.location.origin;
        let pollId = null;
        let settled = false;

        const cleanup = (shouldClose = false) => {
            window.removeEventListener("message", onMessage);
            window.removeEventListener("storage", onStorageMessage);
            if (pollId !== null) {
                clearInterval(pollId);
                pollId = null;
            }
            if (shouldClose) {
                try {
                    if (!authTab.closed) {
                        authTab.close();
                    }
                } catch (closeErr) {
                    console.error("Failed to close the Spotify tab", closeErr);
                }
            }
            clearAuthPending(authSessionId);
            clearAuthResult(authSessionId);
        };

        const onMessage = (event) => {
            if (event.origin !== origin) {
                return;
            }
            const payload = event.data || {};

            if (payload.type === "spotify-auth-success") {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup(true);
                window.focus();
                resolve();
            } else if (payload.type === "spotify-auth-error") {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup(true);
                reject({
                    code: "auth_error",
                    message: payload.error || "Spotify authentication error.",
                });
            }
        };

        const onStorageMessage = (event) => {
            if (event.key !== AUTH_RESULT_STORAGE_KEY || !event.newValue) {
                return;
            }
            let payload;
            try {
                payload = JSON.parse(event.newValue);
            } catch (storageErr) {
                console.warn("Failed to read the Spotify auth result", storageErr);
                return;
            }
            if (payload && payload.id && payload.id !== authSessionId) {
                return;
            }
            if (!payload || settled) {
                return;
            }

            if (payload.status === "success") {
                settled = true;
                cleanup(true);
                window.focus();
                resolve();
            } else if (payload.status === "error") {
                settled = true;
                cleanup(true);
                reject({
                    code: "auth_error",
                    message: payload.error || "Spotify authentication error.",
                });
            }
        };

        window.addEventListener("message", onMessage);
        window.addEventListener("storage", onStorageMessage);

        pollId = window.setInterval(() => {
            if (settled) {
                return;
            }
            if (authTab.closed) {
                settled = true;
                cleanup();
                reject({
                    code: "popup_closed",
                    message: "Authentication window closed before approval.",
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
            message: "Connection lost during generation.",
        };
    }
}

async function fetchLatestResult() {
    try {
        const res = await fetch('/latest_result', {
            headers: {
                'Accept': 'application/json',
            },
        });

        if (res.status === 204) {
            return null;
        }

        if (!res.ok) {
            return null;
        }

        return await res.json();
    } catch (fallbackErr) {
        console.error("latest_result fetch failed", fallbackErr);
        return null;
    }
}

async function finishPendingGeneration() {
    lockButton(GENERATING_BUTTON_LABEL);
    showOverlay({ message: FINALISING_MESSAGE, cycling: true });

    try {
        const res = await fetch('/finish_generation', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (res.status === 400) {
            window.ARIA_PENDING_PROMPT = "";
            const promptEl = document.getElementById('prompt');
            if (promptEl) {
                promptEl.value = "";
            }
            return null;
        }

        if (res.status === 401) {
            throw {
                code: 'auth_error',
                message: "Spotify connection required.",
            };
        }

        if (!res.ok) {
            throw new Error("Server error");
        }

        let data = null;
        try {
            data = await res.json();
        } catch (jsonErr) {
            console.error("finish_generation response parse failed", jsonErr);
        }
        if (!data || data.ok !== true) {
            throw new Error("Invalid server response");
        }

        const agentResult = data.result || null;
        if (agentResult) {
            updateResultCard(agentResult);
        }

        window.ARIA_PENDING_PROMPT = "";
        const promptInputEl = document.getElementById('prompt');
        if (promptInputEl) {
            promptInputEl.value = "";
        }

        return agentResult;
    } finally {
        hideOverlay();
        unlockButton();
    }
}

async function resumePendingGenerationIfNeeded() {
    if (autoResumeTriggered || !initialPendingPrompt || !isSpotifyConnected || initialResult) {
        return;
    }

    autoResumeTriggered = true;

    try {
        await finishPendingGeneration();
    } catch (err) {
        console.error("Failed to resume pending generation", err);
        if (err && err.code === 'auth_error') {
            alert(err.message || "Spotify connection expired. Please generate again.");
        } else {
            alert("We connected to Spotify, but finishing your playlist failed. Please click Generate again.");
        }
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
            message: "Spotify connection required.",
        };
    }

    if (!res.ok) {
        throw new Error("Server error");
    }

    return await res.json();
}

async function handleSubmit(e) {
    e.preventDefault();

    const promptInputEl = document.getElementById('prompt');
    const promptVal = promptInputEl ? promptInputEl.value.trim() : "";
    if (!promptVal) {
        return; // nothing to do without a prompt
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
                message: "Spotify connection required.",
            };
        }

        if (!res.ok) {
            throw new Error("Server error");
        }

        const data = await res.json();
        updateResultCard(data);
    } catch (err) {
        console.error(err);
        if (err && err.code === 'popup_closed') {
            alert("Spotify sign-in was cancelled before approval.");
        } else if (err && err.code === 'auth_error') {
            alert(err.message || "Could not finish connecting to Spotify. Try again.");
        } else if (err && err.code === 'network') {
            alert(err.message || "Connection lost during generation. Check your connection and try again.");
        } else if (err && err.code === 'navigation') {
            // the tab was redirected to Spotify, nothing else to do here
        } else {
            const fallbackResult = await fetchLatestResult();
            if (fallbackResult) {
                updateResultCard(fallbackResult);
                alert("Your playlist is ready but the response took too long. I grabbed it for you!");
            } else {
                alert("Sorry, something broke during generation.");
            }
        }
    } finally {
        hideOverlay();
        unlockButton();
    }
}

formEl.addEventListener('submit', handleSubmit);

window.addEventListener("DOMContentLoaded", () => {
    resumePendingGenerationIfNeeded();
});

if (initialResult) {
    updateResultCard(initialResult);
}

// -----------------------------------------------------------------
// INTERACTIVE ORB (floating sphere)
//
// - the wrapper (.sphere-wrapper) follows the cursor and scales slightly
// - the sphere always stays perfectly round (no rotateX/rotateY weirdness)
// - we only move the light a little to mimic the roll without making an eye effect
// -----------------------------------------------------------------

const sphereWrappers = Array.from(document.querySelectorAll('.sphere-wrapper'));

// build a tiny state object per sphere
const spheres = sphereWrappers.map(wrapper => {
    const inner = wrapper.querySelector('.sphere');
    return {
        wrapper,
        inner,
        // current display state:
        dx: 0,
        dy: 0,
        scale: 1,
        // target values:
        targetDx: 0,
        targetDy: 0,
        targetScale: 1,
        // geometry:
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

        // normalize movement within a controlled range
        const RANGE = 120;
        let ndx = dxPx / RANGE;
        let ndy = dyPx / RANGE;
        ndx = Math.max(-1, Math.min(1, ndx));
        ndy = Math.max(-1, Math.min(1, ndy));

        s.targetDx = ndx;
        s.targetDy = ndy;

        // cursor distance to the sphere
        const dist = Math.hypot(dxPx, dyPx);

        // magnetic effect (it grows when you get close)
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
        // gentle, lively easing for the motion
        s.dx = lerp(s.dx, s.targetDx, 0.08);
        s.dy = lerp(s.dy, s.targetDy, 0.08);
        s.scale = lerp(s.scale, s.targetScale, 0.08);

        // physical translation of the sphere toward the cursor
        const MOVE_PX = 12;
        const tx = s.dx * MOVE_PX;
        const ty = s.dy * MOVE_PX;

        // apply translate+scale on the wrapper (keeps the sphere facing forward)
        s.wrapper.style.transform =
            `translate3d(${tx}px, ${ty}px, 0) scale(${s.scale})`;

        // simulate a subtle roll by nudging the light just a little
        const LIGHT_SHIFT_PCT = 5; // very subtle -> avoids the eyeball effect
        const lx = 30 + s.dx * LIGHT_SHIFT_PCT;
        const ly = 25 + s.dy * LIGHT_SHIFT_PCT;

        s.inner.style.setProperty('--light-x', lx + '%');
        s.inner.style.setProperty('--light-y', ly + '%');
    });

    requestAnimationFrame(animateSpheres);
}

requestAnimationFrame(animateSpheres);
