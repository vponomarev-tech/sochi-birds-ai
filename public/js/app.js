/**
 * BirdNET Live - Main Application Script
 * Handles audio capture, TensorFlow.js worker communication,
 * spectrogram visualization, and UI rendering.
 */

/* ==========================================================================
   1. CONFIGURATION & CONSTANTS
   ========================================================================== */

// Audio settings
const SAMPLE_RATE = 48000;
const WINDOW_SECONDS = 3;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;

// Inference settings
const TEMPORAL_POOL_WINDOW = 5;    // Number of recent predictions to pool
const USE_TEMPORAL_POOL = true;    // Enable log-mean-exp pooling

// Spectrogram settings
const SPECTRO_FFT_SIZE = 2048;
const SPECTRO_DEFAULT_DURATION_SEC = 20;
const SPECTRO_DEFAULT_GAIN = 1.5;
const SPECTRO_SMOOTHING = 0.0; // 0.0 = crisp details, 1.0 = very smooth
const SPECTRO_MIN_FREQ_DEFAULT = 0;
const SPECTRO_MAX_FREQ_DEFAULT = 12000;

// Supported Languages
const LANG_LABELS = {
  en_us: "English (US)", en_uk: "English (UK)", de: "Deutsch", fr: "Français",
  es: "Español", it: "Italiano", nl: "Nederlands", pt: "Português",
  fi: "Suomi", sv: "Svenska", no: "Norsk", da: "Dansk", pl: "Polski",
  ru: "Русский", uk: "Українська", cs: "Čeština", sk: "Slovenčina",
  sl: "Slovenski", hu: "Magyar", ro: "Română", tr: "Türkçe",
  ar: "العربية", ja: "日本語", ko: "한국어", th: "ไทย", zh: "中文",
  af: "Afrikaans"
};
const SUPPORTED_LABEL_LANGS = Object.keys(LANG_LABELS);

// UI Translation State
let currentUiLang = "en";
let translations = {};

/* ==========================================================================
   2. GLOBAL STATE
   ========================================================================== */

// Audio & Worker State
let isListening = false;
let workerReady = false;
let birdnetWorker = null;
let audioContext;
let workletNode;
let gainNode;
let highPassFilterNode;
let circularBuffer;
let circularWriteIndex = 0;
let currentStream;

// Inference State
let lastInferenceStart = 0;
let lastInferenceMs = null;
let recentInferenceSets = []; // Buffer for temporal pooling
let latestDetections = [];

// Spectrogram State
let spectroCanvas, spectroCtx;
let spectroAxisCanvas, spectroAxisCtx; // Overlay for axis
let spectroAnimationId = null;
let analyser;
let dataArray; // Float32 array for dB values
let bufferLength;
let spectroColumnSeconds = 0;
let lastSpectroColumnTime = 0;

// Noise Level State (relative, uncalibrated — reuses the spectrogram's own
// analyser, no extra audio node needed)
let latestNoiseDb = null;
let noiseLogIntervalId = null;
let noiseReadoutIntervalId = null;

// Geolocation State
let geolocation = null;
let geoWatchId = null;

// Caching
let lastSpeciesList = null; // Cache for explore page filtering

/* ==========================================================================
   3. UTILITIES & STORAGE
   ========================================================================== */

const store = {
  get: (k, def) => localStorage.getItem(k) ?? def,
  getFloat: (k, def) => { const v = localStorage.getItem(k); return v === null ? def : parseFloat(v); },
  getBool: (k, def) => { const v = localStorage.getItem(k); return v === null ? def : v === "true"; },
  set: (k, v) => localStorage.setItem(k, v)
};

/**
 * Bird photos via the Wikipedia REST API (freely licensed, no per-image
 * download or curation needed — Wikipedia hosts CC/public-domain images
 * and its summary endpoint returns a ready-to-use thumbnail). Cached in
 * localStorage since the species pool is small and photos don't change.
 * Failures (including "no article") are cached too, so a species with no
 * photo doesn't get re-fetched on every render.
 */
let wikiImageCache = {};
try {
  wikiImageCache = JSON.parse(store.get("bn_wiki_img_cache", "{}") || "{}");
} catch (_) {
  wikiImageCache = {};
}

async function fetchWikiImage(scientificName) {
  if (!scientificName) return null;
  if (Object.prototype.hasOwnProperty.call(wikiImageCache, scientificName)) {
    return wikiImageCache[scientificName];
  }
  let entry = null;
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(scientificName)}`,
      { headers: { Accept: "application/json" } }
    );
    if (resp.ok) {
      const data = await resp.json();
      const src = data.thumbnail && data.thumbnail.source;
      const page = data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page;
      if (src) entry = { src, page: page || null };
    }
  } catch (_) {
    // network/CORS failure — treat as "no photo", cached below like any other miss
  }
  wikiImageCache[scientificName] = entry;
  store.set("bn_wiki_img_cache", JSON.stringify(wikiImageCache));
  return entry;
}

/**
 * Wires up a card's photo <a>/<img> pair to load asynchronously from
 * Wikipedia once the card is already in the DOM, so card creation never
 * blocks on a network round trip.
 */
function loadCardPhoto(cardEl, scientificName) {
  if (!scientificName) return;
  fetchWikiImage(scientificName).then(entry => {
    if (!entry) return;
    const imgEl = cardEl.querySelector(".bird-photo-img");
    const linkEl = cardEl.querySelector(".bird-photo-link");
    if (imgEl) imgEl.src = entry.src;
    if (linkEl && entry.page) linkEl.href = entry.page;
  });
}

/**
 * Loads UI translations for the specified language.
 */
async function loadTranslations(lang) {
  try {
    const prefix = window.PATH_PREFIX || "/";
    const response = await fetch(`${prefix}locales/${lang}.json`);
    if (!response.ok) throw new Error(`Failed to load ${lang} translations`);
    translations = await response.json();
    currentUiLang = lang;
    store.set("bn_ui_lang", lang);
    updateUIText();
    
    // Re-render dynamic lists to apply new translations
    renderDetections(latestDetections);
    renderHistory();
    if (document.getElementById("exploreList")) renderExploreList();

    // Update selector if it exists
    const selector = document.getElementById("uiLangSelect");
    if (selector) selector.value = lang;
    
  } catch (e) {
    console.error("Translation load error:", e);
    // Fallback to English if not already English
    if (lang !== "en") loadTranslations("en");
  }
}

/**
 * Updates all elements with data-i18n attribute.
 */
function updateUIText() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (translations[key]) {
      el.innerHTML = translations[key];
    }
  });
  
  // Update status text if not currently recording/processing
  // (Dynamic status updates will use the new translation map)
  if (!isListening && !workerReady) {
    updateStatus("status_init");
  }
}

/**
 * Helper to get a translated string.
 */
function t(key, ...args) {
  let str = translations[key];
  if (!str) return "";
  args.forEach((arg, i) => {
    str = str.replace(`{${i}}`, arg);
  });
  return str;
}

/**
 * Updates the main status text with a translated string.
 */
function updateStatus(key, ...args) {
  const el = statusEl();
  if (el) {
    el.textContent = t(key, ...args);
    // Only set data-i18n if no args, to avoid overwriting dynamic text with static template
    if (args.length === 0) {
      el.setAttribute("data-i18n", key);
    } else {
      el.removeAttribute("data-i18n");
    }
  }
}

/* ==========================================================================
   4. USER SETTINGS (LOADED FROM STORAGE)
   ========================================================================== */

// Spectrogram
let spectroMinFreq = store.getFloat("bn_spec_min_freq", SPECTRO_MIN_FREQ_DEFAULT);
let spectroMaxFreq = store.getFloat("bn_spec_max_freq", SPECTRO_MAX_FREQ_DEFAULT);
let spectroMinDb = store.getFloat("bn_spec_min_db", -120);
let spectroMaxDb = store.getFloat("bn_spec_max_db", -40);
let spectroDurationSec = store.getFloat("bn_spec_duration", SPECTRO_DEFAULT_DURATION_SEC);
let spectroGain = store.getFloat("bn_spec_gain", SPECTRO_DEFAULT_GAIN);
let spectroAxisTicks = store.getFloat("bn_spec_axis_ticks", 9); 
let colormapName = store.get("bn_colormap", "viridis");
let colormapFn = d3.interpolateViridis; // Updated in init

// Model & Detection
let currentLabelLang = store.get("bn_lang", "ru");
let geoEnabled = store.getBool("bn_geo_enabled", true);
let detectionThreshold = store.getFloat("bn_threshold", 0.15);
if (detectionThreshold > 1.0) detectionThreshold = 0.15; // Sanity check
let inputGain = store.getFloat("bn_input_gain", 1.0);
let sensitivity = store.getFloat("bn_sensitivity", 1.0); // New: Sensitivity
let inferenceInterval = store.getFloat("bn_inference_interval", 500);
let rumbleFilterFreq = store.getFloat("bn_rumble_freq", 200);
let geoThreshold = store.getFloat("bn_geo_threshold", 0.05);

// Rarity guard: raises the effective threshold for species uncommon at this
// location/season (low geoscore), targeting the "rare species in the wrong
// place" false positives that stock BirdNET/Merlin are known for.
let raritySteepness = store.getFloat("bn_rarity_guard", 0.25);

// Per-species manual threshold overrides, keyed by scientificName.
// A manual override bypasses the rarity guard entirely: the user is
// explicitly telling the app "this species is real here", which should win
// over a geo-model prior that may simply be undersampled for this area.
let speciesThresholds = {};
try {
  speciesThresholds = JSON.parse(store.get("bn_species_thresholds", "{}") || "{}");
} catch (_) {
  speciesThresholds = {};
}

function speciesKey(p) {
  return p.scientificName || `idx-${p.index}`;
}

function getManualThreshold(key) {
  const v = speciesThresholds[key];
  return typeof v === "number" ? v : null;
}

function setManualThreshold(key, value) {
  if (value === null) {
    delete speciesThresholds[key];
  } else {
    speciesThresholds[key] = Math.max(0, Math.min(0.95, value));
  }
  store.set("bn_species_thresholds", JSON.stringify(speciesThresholds));
}

/**
 * Effective confidence threshold for one detection: a manual per-species
 * override if the user set one, otherwise the global threshold nudged up
 * for species that are rare at the current location/season.
 */
function effectiveThreshold(p) {
  const manual = getManualThreshold(speciesKey(p));
  if (manual !== null) return manual;

  let t = detectionThreshold;
  if (geoEnabled && geolocation && typeof p.geoscore === "number" && raritySteepness > 0) {
    t += raritySteepness * (1 - p.geoscore);
  }
  return Math.min(0.95, t);
}

/* ==========================================================================
   4b. DETECTION HISTORY (live session log — not present in stock BirdNET)
   ========================================================================== */

const HISTORY_COOLDOWN_MS = 60000; // don't log the same singing bird every tick
const HISTORY_MAX_ENTRIES = 300;

let detectionHistory = [];
try {
  detectionHistory = JSON.parse(store.get("bn_history", "[]") || "[]");
} catch (_) {
  detectionHistory = [];
}
let lastHistoryLogAt = {}; // species key -> timestamp ms, resets on page load

/**
 * Appends newly-qualifying detections to the session history, respecting a
 * per-species cooldown so a bird singing continuously for minutes doesn't
 * flood the log with near-duplicate entries.
 */
function logHistoryEntries(detections) {
  if (!Array.isArray(detections) || !detections.length) return;
  const now = Date.now();
  const useGeoFilter = geoEnabled && !!geolocation;

  detections
    .filter(p => !useGeoFilter || (typeof p.geoscore === "number" && p.geoscore >= 0.05))
    .filter(p => p.confidence >= effectiveThreshold(p))
    .forEach(p => {
      const key = speciesKey(p);
      const last = lastHistoryLogAt[key] || 0;
      if (now - last < HISTORY_COOLDOWN_MS) return;
      lastHistoryLogAt[key] = now;

      detectionHistory.unshift({
        t: now,
        key,
        commonName: p.commonNameI18n || p.commonName || key,
        scientificName: p.scientificName || "",
        confidence: p.confidence,
        lat: geolocation ? geolocation.lat : null,
        lon: geolocation ? geolocation.lon : null
      });
    });

  if (detectionHistory.length > HISTORY_MAX_ENTRIES) {
    detectionHistory.length = HISTORY_MAX_ENTRIES;
  }
  store.set("bn_history", JSON.stringify(detectionHistory));
  renderHistory();
}

const NOISE_LOG_INTERVAL_MS = 30000;
const NOISE_HISTORY_MAX_ENTRIES = 500;

let noiseHistory = [];
try {
  noiseHistory = JSON.parse(store.get("bn_noise_history", "[]") || "[]");
} catch (_) {
  noiseHistory = [];
}

/**
 * Logs one relative noise-level sample with the current location (if
 * geolocation is on), on the same cadence idea as the detection history —
 * a periodic environmental reading, not tied to any single bird.
 */
function logNoiseSample() {
  if (latestNoiseDb == null) return;
  noiseHistory.unshift({
    t: Date.now(),
    db: Math.round(latestNoiseDb * 10) / 10,
    lat: geolocation ? geolocation.lat : null,
    lon: geolocation ? geolocation.lon : null
  });
  if (noiseHistory.length > NOISE_HISTORY_MAX_ENTRIES) {
    noiseHistory.length = NOISE_HISTORY_MAX_ENTRIES;
  }
  store.set("bn_noise_history", JSON.stringify(noiseHistory));
}

function renderHistory() {
  const container = document.getElementById("historyList");
  if (!container) return;

  if (!detectionHistory.length) {
    container.innerHTML = `<div class="text-center text-muted py-3 small">${tt("msg_history_empty", "No detections logged yet this session.")}</div>`;
    return;
  }

  container.innerHTML = detectionHistory.map(h => {
    const time = new Date(h.t).toLocaleTimeString();
    const pct = Math.round(h.confidence * 100);
    return `
      <div class="d-flex justify-content-between align-items-center border-bottom py-2 small history-row">
        <span class="text-muted flex-shrink-0" style="width: 5.5em;">${time}</span>
        <span class="flex-grow-1 mx-2 text-truncate" title="${h.scientificName}">${h.commonName}</span>
        <span class="badge bg-secondary flex-shrink-0">${pct}%</span>
      </div>
    `;
  }).join("");
}

function setupHistoryControls() {
  const btn = document.getElementById("clearHistoryBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    detectionHistory = [];
    lastHistoryLogAt = {};
    store.set("bn_history", "[]");
    renderHistory();
  });
}

/* ==========================================================================
   5. DOM ACCESSORS
   ========================================================================== */

const statusEl          = () => document.getElementById("statusText");
const recordButtonEl    = () => document.getElementById("recordButton");
const recordLabelTextEl = () => document.querySelector(".record-label-text");
const detectionsList    = () => document.getElementById("detectionsList");
const geoStatusEl       = () => document.getElementById("geoStatusText");
const geoCoordsEl       = () => document.getElementById("geoCoordsText");
const settingsToggleEl  = () => document.getElementById("settingsToggle");
const settingsDrawerEl  = () => document.getElementById("settingsDrawer");
const settingsOverlayEl = () => document.getElementById("settingsOverlay");

/* ==========================================================================
   6. INITIALIZATION (BOOT)
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  updateColormap(colormapName);

  // Initialize Language (defaults to Russian; user can still switch in Settings)
  const savedLang = store.get("bn_ui_lang");
  const initialLang = savedLang || "ru";
  loadTranslations(initialLang);
  
  const isLive = !!document.getElementById("recordButton");
  const isExplore = !!document.getElementById("exploreList");
  const isMap = !!document.getElementById("mapView");

  if (isMap) {
    initMapPage();
    return; // map page doesn't need the BirdNET worker at all
  }

  // Only run if we are on Live or Explore pages
  if (!isLive && !isExplore) return;

  initWorker();
  setupSettingsToggle();
  initUIControls();
  setupSpeciesThresholdControls();

  if (isLive) {
    setupRecordButton();
    initSpectrogramCanvas(); // Initialize canvas size immediately to prevent layout shift
    setupHistoryControls();
    renderHistory();
  }

  // Handle Geolocation Initialization
  if (geoEnabled) {
    getGeolocation();
  } else {
    updateGeoDisplay("status_geo_disabled", null);
    if (isExplore) {
      // Show hint instead of full list if geo is off
      const container = document.getElementById("exploreList");
      if (container) {
        container.innerHTML = `
          <div class="col-12 text-center py-5 text-muted">
            <i class="bi bi-geo-alt-slash fs-1 d-block mb-3 opacity-25"></i>
            <p data-i18n="msg_explore_geo_disabled">${t("msg_explore_geo_disabled")}</p>
          </div>
        `;
      }
    }
  }
});

/* ==========================================================================
   7. WORKER & MODEL LOGIC
   ========================================================================== */

function initWorker(langOverride) {
  if (birdnetWorker) {
    try { birdnetWorker.terminate(); } catch (_) {}
    birdnetWorker = null;
    workerReady = false;
    
    // Disable record button while reloading
    const btn = recordButtonEl();
    if (btn) btn.disabled = true;
  }
  
  const prefix = (window.PATH_PREFIX || "/");
  const tfPath = prefix + "js/tfjs-4.14.0.min.js";
  const root   = prefix + "models";
  const lang   = langOverride || currentLabelLang || (navigator.language || "en-US");
  const params = new URLSearchParams({ tf: tfPath, root, lang });
  
  const status = statusEl();
  if (status) updateStatus("status_loading_percent", 0);
  
  birdnetWorker = new Worker(prefix + "js/birdnet-worker.js?" + params.toString());

  birdnetWorker.onmessage = (event) => {
    const data = event.data || {};
    switch (data.message) {
      case "load_model":
      case "warmup":
      case "load_geomodel":
      case "load_labels":
        if (typeof data.progress === "number") {
          updateStatus("status_loading_percent", data.progress);
        }
        break;
        
      case "labels_loaded":
        updateStatus("status_ready");
        requestSpeciesList();
        break;

      case "loaded":
        workerReady = true;
        updateStatus("status_ready");
        
        // Enable record button
        const btn = recordButtonEl();
        if (btn) btn.disabled = false;

        if (geolocation) sendAreaScores();
        // If on explore page, request list immediately after load
        if (document.getElementById("exploreList")) requestSpeciesList();
        break;

      case "pooled":
        // Handle inference results
        if (Array.isArray(data.pooled)) {
          recentInferenceSets.push(data.pooled);
          if (recentInferenceSets.length > TEMPORAL_POOL_WINDOW) {
            recentInferenceSets.shift();
          }
        }
        const toRender = USE_TEMPORAL_POOL
          ? computeTemporalPooledDetections(recentInferenceSets)
          : data.pooled;
        renderDetections(toRender);
        if (isListening) logHistoryEntries(toRender);

        if (isListening && lastInferenceStart) {
          lastInferenceMs = Math.round(performance.now() - lastInferenceStart);
          updateStatus("status_listening_inference", lastInferenceMs);
        }
        break;

      case "area-scores":
        // Geo priors updated, refresh explore list if visible
        if (document.getElementById("exploreList")) requestSpeciesList();
        break;

      case "species_list":
        renderExploreList(data.list);
        break;
    }
  };

  birdnetWorker.onerror = (err) => {
    console.error("Worker error", err);
    updateStatus("status_worker_error");
  };
}

function requestSpeciesList() {
  if (birdnetWorker) {
    birdnetWorker.postMessage({ message: "get_species_list" });
  }
}

/* ==========================================================================
   8. AUDIO ENGINE & INFERENCE LOOP
   ========================================================================== */

function setupRecordButton() {
  const btn = recordButtonEl();
  if (!btn) return;
  
  // Initially disable until model loads
  btn.disabled = true;
  
  btn.addEventListener("click", async () => {
    if (!isListening) {
      await startListening();
    } else {
      stopListening();
    }
  });
}

async function startListening() {
  if (!workerReady) {
    updateStatus("status_loading");
    return;
  }
  try {
    isListening = true;
    
    // UI Updates
    const button = recordButtonEl();
    if (button) button.classList.add("recording");
    const label = recordLabelTextEl();
    if (label) {
      label.textContent = t("btn_stop");
      label.setAttribute("data-i18n", "btn_stop");
    }
    const spinner = document.getElementById("listeningIndicator");
    if (spinner) spinner.classList.remove("d-none");
    
    updateStatus("status_requesting_mic");
    await requestWakeLock();

    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    await setupAudioGraphFromStream(currentStream);
    updateStatus("status_listening");

    updateNoiseReadoutUI();
    noiseReadoutIntervalId = setInterval(updateNoiseReadoutUI, 1000);
    noiseLogIntervalId = setInterval(logNoiseSample, NOISE_LOG_INTERVAL_MS);
  } catch (e) {
    console.error(e);
    updateStatus("status_mic_failed");
    stopListening(); // Cleanup UI state
  }
}

function stopListening() {
  isListening = false;
  releaseWakeLock();
  
  // UI Updates
  const button = recordButtonEl();
  if (button) button.classList.remove("recording");
  const label = recordLabelTextEl();
  if (label) {
    label.textContent = t("btn_start");
    label.setAttribute("data-i18n", "btn_start");
  }
  const spinner = document.getElementById("listeningIndicator");
  if (spinner) spinner.classList.add("d-none");

  updateStatus("status_stopped");

  // Reset State
  lastInferenceStart = 0;
  lastInferenceMs = null;
  if (noiseReadoutIntervalId) { clearInterval(noiseReadoutIntervalId); noiseReadoutIntervalId = null; }
  if (noiseLogIntervalId) { clearInterval(noiseLogIntervalId); noiseLogIntervalId = null; }
  latestNoiseDb = null;
  updateNoiseReadoutUI();

  // Cleanup Audio
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (highPassFilterNode) {
    highPassFilterNode.disconnect();
    highPassFilterNode = null;
  }
  if (audioContext) {
    stopSpectrogram();
    audioContext.close();
    audioContext = null;
  }
}

async function setupAudioGraphFromStream(stream) {
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Resume if suspended (browser requirements)
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  const source = audioContext.createMediaStreamSource(stream);
  
  // Create Gain Node (Hardware-like gain)
  gainNode = audioContext.createGain();
  gainNode.gain.value = inputGain;
  
  // Create High-Pass Filter (Rumble Filter)
  highPassFilterNode = audioContext.createBiquadFilter();
  highPassFilterNode.type = "highpass";
  highPassFilterNode.frequency.value = rumbleFilterFreq;
  highPassFilterNode.Q.value = 0.707; // Butterworth

  // Connect Mic -> Gain -> HighPass
  source.connect(gainNode);
  gainNode.connect(highPassFilterNode);

  // Start visualizer (Connect HighPass -> Spectrogram)
  startSpectrogram(highPassFilterNode);

  // Setup circular buffer for inference
  circularBuffer = new Float32Array(WINDOW_SAMPLES);
  circularWriteIndex = 0;

  if (!audioContext.audioWorklet) {
    updateStatus("status_browser_old");
    return;
  }

  // Use AudioWorklet for raw audio access (Replaces ScriptProcessor)
  try {
    const prefix = (window.PATH_PREFIX || "/");
    await audioContext.audioWorklet.addModule(prefix + "js/audio-processor.js");

    workletNode = new AudioWorkletNode(audioContext, "audio-processor");

    // Handle audio data from the worklet
    workletNode.port.onmessage = (event) => {
      const input = event.data;
      for (let i = 0; i < input.length; i++) {
        circularBuffer[circularWriteIndex] = input[i];
        circularWriteIndex = (circularWriteIndex + 1) % circularBuffer.length;
      }
    };

    // Connect Gain -> Worklet -> Destination
    // gainNode.connect(workletNode); // OLD
    highPassFilterNode.connect(workletNode);
    workletNode.connect(audioContext.destination);

  } catch (err) {
    console.error("Failed to load AudioWorklet", err);
    updateStatus("status_audio_failed");
    return;
  }

  startInferenceLoop();
}

function startInferenceLoop() {
  const tick = () => {
    if (!isListening || !workerReady || !circularBuffer || !birdnetWorker) return;
    
    const windowed = getCurrentWindow();
    if (windowed) {
      const geoCtx = geolocation ? {
        latitude: geolocation.lat,
        longitude: geolocation.lon
      } : {};
      
      lastInferenceStart = performance.now();
      birdnetWorker.postMessage(
        { 
          message: "predict", 
          pcmAudio: windowed, 
          overlapSec: 1.5, 
          sensitivity: sensitivity, // Pass sensitivity to worker
          ...geoCtx 
        },
        [windowed.buffer]
      );
    }
    
    if (isListening) setTimeout(tick, inferenceInterval);
  };
  tick();
}

/**
 * Extracts the most recent 3 seconds of audio from the circular buffer.
 */
function getCurrentWindow() {
  if (!circularBuffer) return null;
  const result = new Float32Array(WINDOW_SAMPLES);
  let idx = circularWriteIndex; 
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    // Gain is already applied by GainNode, just clamp to prevent clipping artifacts in model
    result[i] = Math.max(-1, Math.min(1, circularBuffer[idx]));
    idx = (idx + 1) % circularBuffer.length;
  }
  return result;
}

/* ==========================================================================
   9. SPECTROGRAM VISUALIZATION
   ========================================================================== */

function initSpectrogramCanvas() {
  if (spectroCanvas) return;
  spectroCanvas = document.getElementById("liveSpectrogram");
  if (!spectroCanvas) return;

  // Create Axis Overlay if it doesn't exist
  if (!spectroAxisCanvas) {
    const parent = spectroCanvas.parentElement;
    if (parent) {
      parent.style.position = "relative"; // Ensure positioning context
      spectroAxisCanvas = document.createElement("canvas");
      spectroAxisCanvas.className = "spectro-axis-overlay";
      spectroAxisCanvas.style.position = "absolute";
      spectroAxisCanvas.style.top = "0";
      spectroAxisCanvas.style.left = "0";
      spectroAxisCanvas.style.pointerEvents = "none"; // Let clicks pass through
      spectroAxisCanvas.style.zIndex = "10"; // Above spectrogram
      parent.appendChild(spectroAxisCanvas);
      spectroAxisCtx = spectroAxisCanvas.getContext("2d");
    }
  }
  
  resizeSpectrogramCanvas();
  window.addEventListener("resize", resizeSpectrogramCanvas);
}

function resizeSpectrogramCanvas() {
  if (!spectroCanvas) return;
  const cssW = spectroCanvas.clientWidth || 600;
  const cssH = spectroCanvas.clientHeight || 220;

  // Preserve existing content if possible
  let snapshot = null;
  if (spectroCtx) {
    try {
      snapshot = spectroCtx.getImageData(0, 0, spectroCanvas.width, spectroCanvas.height);
    } catch (_) {}
  }

  spectroCanvas.width = cssW;
  spectroCanvas.height = cssH;

  // Optimize for frequent readback (resizing)
  spectroCtx = spectroCanvas.getContext("2d", { willReadFrequently: true });
  spectroCtx.fillStyle = "#000";
  spectroCtx.fillRect(0, 0, cssW, cssH);

  if (snapshot) spectroCtx.putImageData(snapshot, 0, 0);

  // Resize Axis Overlay (High DPI support)
  if (spectroAxisCanvas) {
    const dpr = window.devicePixelRatio || 1;
    // Set physical size based on DPR
    spectroAxisCanvas.width = Math.floor(cssW * dpr);
    spectroAxisCanvas.height = Math.floor(cssH * dpr);
    
    // Set CSS size to match layout
    spectroAxisCanvas.style.width = `${cssW}px`;
    spectroAxisCanvas.style.height = `${cssH}px`;
    
    // Scale context so drawing operations use CSS pixels
    spectroAxisCtx.scale(dpr, dpr);
    
    drawSpectrogramAxis();
  }

  spectroColumnSeconds = cssW > 0 ? spectroDurationSec / cssW : 0.05;
  lastSpectroColumnTime = audioContext ? audioContext.currentTime : 0;
}

function drawSpectrogramAxis() {
  if (!spectroAxisCtx || !spectroAxisCanvas) return;
  const ctx = spectroAxisCtx;
  // Use logical CSS dimensions for drawing
  const w = spectroAxisCanvas.clientWidth;
  const h = spectroAxisCanvas.clientHeight;

  ctx.clearRect(0, 0, w, h);
  
  // Background strip for legibility
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(0, 0, 40, h);

  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = "10px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const numSteps = spectroAxisTicks;
  const range = spectroMaxFreq - spectroMinFreq;

  for (let i = 0; i <= numSteps; i++) {
    const ratio = i / numSteps;
    const freq = spectroMinFreq + (range * ratio);
    // Canvas Y is inverted (0 is top/high freq)
    let y = h - (ratio * h);
    
    // Aesthetic tweak: inset edge ticks so they aren't on the absolute pixel edge
    if (i === 0) y -= 5;          // Move bottom tick up
    if (i === numSteps) y += 5;   // Move top tick down
    
    // Adjust text position to avoid clipping at edges
    let textY = y;
    if (i === 0) textY -= 5;
    if (i === numSteps) textY += 5;

    ctx.fillText(`${(freq/1000).toFixed(1)}k`, 32, textY);
    
    // Tick mark
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(34, y, 6, 1);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  }
}

function startSpectrogram(source) {
  initSpectrogramCanvas();
  if (!spectroCanvas) return;

  analyser = audioContext.createAnalyser();
  analyser.fftSize = SPECTRO_FFT_SIZE;
  analyser.smoothingTimeConstant = SPECTRO_SMOOTHING;
  source.connect(analyser);

  bufferLength = analyser.frequencyBinCount;
  dataArray = new Float32Array(bufferLength); // Use Float32 for dB

  lastSpectroColumnTime = audioContext.currentTime;
  if (!spectroColumnSeconds) {
    const w = spectroCanvas.width || 600;
    spectroColumnSeconds = spectroDurationSec / w;
  }
  if (!spectroAnimationId) {
    spectroAnimationId = requestAnimationFrame(drawSpectrogram);
  }
}

function stopSpectrogram() {
  if (spectroAnimationId) {
    cancelAnimationFrame(spectroAnimationId);
    spectroAnimationId = null;
  }
  if (analyser) {
    try { analyser.disconnect(); } catch (_) {}
    analyser = null;
  }
}

function updateColormap(name) {
  switch (name) {
    case "inferno": colormapFn = d3.interpolateInferno; break;
    case "plasma": colormapFn = d3.interpolatePlasma; break;
    case "viridis": colormapFn = d3.interpolateViridis; break;
    case "turbo": colormapFn = d3.interpolateTurbo; break;
    case "cubehelix": colormapFn = d3.interpolateCubehelixDefault; break;
    default: colormapFn = d3.interpolateMagma; break;
  }
}

function drawSpectrogram() {
  spectroAnimationId = requestAnimationFrame(drawSpectrogram);
  if (!analyser || !audioContext) return;

  analyser.getFloatFrequencyData(dataArray);
  updateNoiseLevel(dataArray);

  const w = spectroCanvas.width;
  const h = spectroCanvas.height;
  if (!w || !h) return;

  // Calculate scrolling
  if (!spectroColumnSeconds) {
    spectroColumnSeconds = spectroDurationSec / Math.max(1, w);
  }
  const audioNow = audioContext.currentTime;
  let columnsNeeded = Math.floor((audioNow - lastSpectroColumnTime) / spectroColumnSeconds);
  if (columnsNeeded <= 0) return;
  columnsNeeded = Math.min(columnsNeeded, w - 1);
  lastSpectroColumnTime += columnsNeeded * spectroColumnSeconds;

  // Shift canvas left
  spectroCtx.drawImage(
    spectroCanvas,
    columnsNeeded, 0, w - columnsNeeded, h,
    0, 0, w - columnsNeeded, h
  );

  // Frequency bin mapping
  const nyquist = SAMPLE_RATE / 2;
  const startBin = Math.max(0, Math.floor((spectroMinFreq / nyquist) * bufferLength));
  const endBin = Math.min(bufferLength - 1, Math.floor((spectroMaxFreq / nyquist) * bufferLength));
  const binCount = endBin - startBin + 1;

  // Draw new columns
  for (let c = 0; c < columnsNeeded; c++) {
    const x = w - columnsNeeded + c;
    
    // Clear column
    spectroCtx.fillStyle = "#000";
    spectroCtx.fillRect(x, 0, 1, h);

    // Draw frequency bins
    for (let i = startBin; i <= endBin; i++) {
      const db = dataArray[i];
      
      // Normalize dB to 0..1 range
      let norm = (db - spectroMinDb) / (spectroMaxDb - spectroMinDb);
      norm = Math.max(0, Math.min(1, norm));
      
      // Optional: slight gamma for contrast
      norm = Math.pow(norm, 0.8);

      // Map to Y pixels (flip Y so low freq is at bottom)
      // Calculate exact pixel boundaries for this bin to prevent gaps
      const relIndex = i - startBin;
      
      // yBottom is the lower edge of the bin (lower frequency, higher Y pixel value)
      const yBottom = h * (1 - relIndex / binCount);
      // yTop is the upper edge of the bin (higher frequency, lower Y pixel value)
      const yTop = h * (1 - (relIndex + 1) / binCount);
      
      // Snap to integer pixels to avoid sub-pixel rendering gaps
      const yDraw = Math.floor(yTop);
      const hDraw = Math.ceil(yBottom) - yDraw;

      spectroCtx.fillStyle = colormapFn(norm);
      spectroCtx.fillRect(x, yDraw, 1, hDraw);
    }
  }
}

/**
 * Approximate, uncalibrated relative loudness from the same frequency data
 * already computed for the spectrogram (average dBFS across all bins).
 * Not a certified SPL/dB(A) reading — phone/browser mics have unknown,
 * varying gain — but useful for comparing "louder here vs quieter there"
 * over time and location.
 */
function updateNoiseLevel(freqData) {
  let sum = 0, count = 0;
  for (let i = 0; i < freqData.length; i++) {
    const v = freqData[i];
    if (Number.isFinite(v)) { sum += v; count++; }
  }
  if (count > 0) latestNoiseDb = sum / count;
}

function updateNoiseReadoutUI() {
  const el = document.getElementById("noiseLevelText");
  if (!el) return;
  el.textContent = latestNoiseDb != null ? `${Math.round(latestNoiseDb)} dB` : "—";
}

/* ==========================================================================
   10. UI & RENDERING
   ========================================================================== */

function initUIControls() {
  // Geolocation Toggle
  const geoToggle = document.getElementById("geoToggle");
  if (geoToggle) {
    geoToggle.checked = geoEnabled;
    geoToggle.addEventListener("change", () => {
      geoEnabled = geoToggle.checked;
      store.set("bn_geo_enabled", geoEnabled);

      if (geoEnabled) {
        updateGeoDisplay("status_geo_requesting", null);
        getGeolocation();
      } else {
        geolocation = null;
        if (geoWatchId !== null) {
          navigator.geolocation.clearWatch(geoWatchId);
          geoWatchId = null;
        }
        updateGeoDisplay("status_geo_disabled", null);
        
        // Handle Explore page state change
        if (document.getElementById("exploreList")) {
           const container = document.getElementById("exploreList");
           container.innerHTML = `
            <div class="col-12 text-center py-5 text-muted">
              <i class="bi bi-geo-alt-slash fs-1 d-block mb-3 opacity-25"></i>
              <p data-i18n="msg_explore_geo_disabled">${t("msg_explore_geo_disabled")}</p>
            </div>
          `;
        } else {
          renderDetections();
        }
      }
    });
  }

  // Settings Sliders
  bindRange("geoThresholdRange", geoThreshold * 100, (v) => {
    geoThreshold = v / 100;
    store.set("bn_geo_threshold", geoThreshold);
    if (document.getElementById("exploreList")) {
      renderExploreList(null); // Re-render cached list
    }
  }, (v) => `${Math.round(v)}%`);

  bindRange("durationRange", spectroDurationSec, (v) => {
    spectroDurationSec = v;
    if (spectroCanvas && spectroCanvas.width > 0) {
      spectroColumnSeconds = spectroDurationSec / spectroCanvas.width;
    }
  }, (v) => `${v}s`, "bn_spec_duration");

  bindRange("gainRange", spectroGain, (v) => {
    spectroGain = v;
  }, (v) => `${v.toFixed(1)}×`, "bn_spec_gain");

  bindRange("thresholdRange", detectionThreshold * 100, (v) => {
    detectionThreshold = v / 100;
    store.set("bn_threshold", detectionThreshold);
    renderDetections();
  }, (v) => `${Math.round(v)}%`);

  bindRange("rarityGuardRange", raritySteepness * 100, (v) => {
    raritySteepness = v / 100;
    store.set("bn_rarity_guard", raritySteepness);
    renderDetections();
  }, (v) => `+${Math.round(v)}%`);

  bindRange("inputGainRange", inputGain, (v) => {
    inputGain = v;
    // Apply gain immediately if listening
    if (gainNode) gainNode.gain.value = v;
  }, (v) => `${v.toFixed(1)}×`, "bn_input_gain");

  bindRange("rumbleFilterRange", rumbleFilterFreq, (v) => {
    rumbleFilterFreq = v;
    if (highPassFilterNode) highPassFilterNode.frequency.value = v;
  }, (v) => `${Math.round(v)} Hz`, "bn_rumble_freq");

  bindRange("sensitivityRange", sensitivity, (v) => {
    sensitivity = v;
  }, (v) => v.toFixed(1), "bn_sensitivity");

  bindRange("inferenceIntervalRange", inferenceInterval, (v) => {
    inferenceInterval = v;
  }, (v) => `${Math.round(v)} ms`, "bn_inference_interval");

  bindRange("minFreqRange", spectroMinFreq, (v) => {
    spectroMinFreq = Math.min(v, spectroMaxFreq - 100);
    drawSpectrogramAxis();
  }, (v) => `${Math.round(v)} Hz`, "bn_spec_min_freq");

  bindRange("maxFreqRange", spectroMaxFreq, (v) => {
    spectroMaxFreq = Math.max(v, spectroMinFreq + 100);
    drawSpectrogramAxis();
  }, (v) => `${Math.round(v)} Hz`, "bn_spec_max_freq");

  bindRange("axisTicksRange", spectroAxisTicks, (v) => {
    spectroAxisTicks = v;
    drawSpectrogramAxis();
  }, (v) => `${v}`, "bn_spec_axis_ticks");

  bindRange("minDbRange", spectroMinDb, (v) => {
    spectroMinDb = Math.min(v, spectroMaxDb - 10);
  }, (v) => `${v} dB`, "bn_spec_min_db");

  bindRange("maxDbRange", spectroMaxDb, (v) => {
    spectroMaxDb = Math.max(v, spectroMinDb + 10);
  }, (v) => `${v} dB`, "bn_spec_max_db");

  // Dropdowns
  const colormapSelect = document.getElementById("colormapSelect");
  if (colormapSelect) {
    colormapSelect.value = colormapName;
    colormapSelect.addEventListener("change", () => {
      colormapName = colormapSelect.value;
      store.set("bn_colormap", colormapName);
      updateColormap(colormapName);
    });
  }

  const uiLangSelect = document.getElementById("uiLangSelect");
  if (uiLangSelect) {
    uiLangSelect.value = currentUiLang;
    uiLangSelect.addEventListener("change", () => {
      loadTranslations(uiLangSelect.value);
    });
  }

  const langSelect = document.getElementById("labelLangSelect");
  if (langSelect) {
    langSelect.innerHTML = SUPPORTED_LABEL_LANGS
      .map(code => {
        const label = LANG_LABELS[code] || code;
        const sel = code === currentLabelLang ? " selected" : "";
        return `<option value="${code}"${sel}>${label}</option>`;
      })
      .join("");
    langSelect.addEventListener("change", () => {
      currentLabelLang = langSelect.value;
      store.set("bn_lang", currentLabelLang);
      latestDetections = [];
      renderDetections([]);
      
      if (birdnetWorker && workerReady) {
        updateStatus("status_reloading_model");
        birdnetWorker.postMessage({ message: 'load_labels', lang: currentLabelLang });
      } else {
        initWorker(currentLabelLang);
      }
    });
  }
}

function bindRange(id, initialValue, onChange, format, storageKey) {
  const input = document.getElementById(id);
  const label = document.querySelector(`[id='${id.replace("Range", "Value")}']`);
  if (!input) return;
  if (typeof initialValue === "number") {
    input.value = initialValue;
  }
  const setLabel = (val) => {
    if (label) label.textContent = format ? format(val) : val;
  };
  setLabel(parseFloat(input.value));
  input.addEventListener("input", () => {
    const val = parseFloat(input.value);
    onChange(val, input);
    setLabel(val);
    if (storageKey) store.set(storageKey, val);
  });
}

function setupSettingsToggle() {
  const toggle = settingsToggleEl();
  const drawer = settingsDrawerEl();
  const overlay = settingsOverlayEl();
  const closeBtn = document.getElementById("settingsClose");
  const closeBtnBottom = document.getElementById("settingsCloseBottom");

  if (!toggle || !drawer) return;

  const setState = (open) => {
    // Manage focus to avoid "aria-hidden" violation
    if (!open) {
      // If closing and focus is inside, move it back to toggle
      if (drawer.contains(document.activeElement)) {
        toggle.focus();
      }
    }

    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    drawer.classList.toggle("open", open);
    document.body.classList.toggle("drawer-open", open);
    if (overlay) {
      overlay.classList.toggle("active", open);
      overlay.setAttribute("aria-hidden", open ? "false" : "true");
    }

    if (open) {
      // If opening, move focus to close button
      if (closeBtn) closeBtn.focus();
    }
  };

  setState(false);

  toggle.addEventListener("click", () => {
    const open = !drawer.classList.contains("open");
    setState(open);
  });

  if (overlay) overlay.addEventListener("click", () => setState(false));
  if (closeBtn) closeBtn.addEventListener("click", () => setState(false));
  if (closeBtnBottom) closeBtnBottom.addEventListener("click", () => setState(false));
  
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") setState(false);
  });
}

/**
 * Translation helper with an inline English fallback, for strings not
 * present in every locale file yet.
 */
function tt(key, fallback, ...args) {
  const v = t(key, ...args);
  return v || fallback;
}

const THRESHOLD_STEP = 0.05;

/**
 * Renders the "own threshold" control strip shown under each detection card:
 * current effective threshold (manual override, or auto/rarity-adjusted),
 * plus +/- steppers and a reset button when an override is active.
 */
function renderThresholdRow(key, p) {
  const manual = getManualThreshold(key);
  const eff = effectiveThreshold(p);
  const label = manual !== null
    ? tt("lbl_own_threshold", `Own threshold: ${Math.round(manual * 100)}%`, Math.round(manual * 100))
    : tt("lbl_auto_threshold", `Auto threshold: ${Math.round(eff * 100)}%`, Math.round(eff * 100));
  const resetBtn = manual !== null
    ? `<button type="button" class="btn btn-sm btn-link p-0 ms-1 species-thr-btn" data-action="reset" data-species="${key}">${tt("btn_reset", "reset")}</button>`
    : "";
  return `
    <span>${label}</span>
    <button type="button" class="btn btn-sm btn-link p-0 ms-2 species-thr-btn" data-action="dec" data-species="${key}" title="${tt("lbl_lower_threshold", "Lower threshold for this species")}">&minus;</button>
    <button type="button" class="btn btn-sm btn-link p-0 ms-1 species-thr-btn" data-action="inc" data-species="${key}" title="${tt("lbl_raise_threshold", "Raise threshold for this species")}">+</button>
    ${resetBtn}
  `;
}

/**
 * Handles clicks on the per-card threshold controls via event delegation
 * (cards are re-created/diffed on every render, so we bind once on the
 * container instead of per-card).
 */
function setupSpeciesThresholdControls() {
  const container = detectionsList();
  if (!container) return;
  container.addEventListener("click", (evt) => {
    const btn = evt.target.closest(".species-thr-btn");
    if (!btn) return;
    const key = btn.dataset.species;
    const action = btn.dataset.action;
    const det = latestDetections.find(p => speciesKey(p) === key);
    const base = getManualThreshold(key) ?? (det ? effectiveThreshold(det) : detectionThreshold);

    if (action === "reset") {
      setManualThreshold(key, null);
    } else if (action === "inc") {
      setManualThreshold(key, base + THRESHOLD_STEP);
    } else if (action === "dec") {
      setManualThreshold(key, base - THRESHOLD_STEP);
    }
    renderDetections();
  });
}

/**
 * Renders the list of detected species (Live View).
 * Uses DOM diffing to prevent flickering of images.
 */
function renderDetections(pooled) {
  if (Array.isArray(pooled)) latestDetections = pooled;
  const container = detectionsList();
  if (!container) return;
  
  const useGeoFilter = geoEnabled && !!geolocation;
  const all = latestDetections || [];

  // Filter by Geo (if enabled) and Confidence
  const afterGeo = useGeoFilter
    ? all.filter(p => typeof p.geoscore === "number" && p.geoscore >= 0.05)
    : all;
  const afterAudio = afterGeo.filter(p => p.confidence >= effectiveThreshold(p));
  const top = afterAudio.sort((a, b) => b.confidence - a.confidence).slice(0, 20);

  // Empty State
  if (!top.length) {
    container.innerHTML = `
      <div class="col-12 text-center text-muted py-5">
        <i class="bi bi-soundwave fs-1 d-block mb-3 opacity-25"></i>
        <p>${t("msg_no_detections", Math.round(detectionThreshold * 100))}</p>
        ${useGeoFilter ? `<small>${t("msg_geo_active")}</small>` : ""}
      </div>
    `;
    return;
  }

  // Clear empty state message if present
  if (container.querySelector(".text-center.text-muted")) {
    container.innerHTML = "";
  }

  // Diffing Strategy: Map existing cards by species key
  const existingCards = new Map();
  Array.from(container.children).forEach(child => {
    const key = child.dataset.species;
    if (key) existingCards.set(key, child);
  });

  const newKeys = new Set();

  top.forEach((p, index) => {
    const confPct = (p.confidence * 100).toFixed(1);
    const geoInfo = useGeoFilter && typeof p.geoscore === "number"
      ? t("lbl_geo_score", (p.geoscore * 100).toFixed(1))
      : "";
    const commonName = p.commonNameI18n || p.commonName || `Class ${p.index}`;
    const scientificName = p.scientificName || "";
    const key = scientificName || `idx-${p.index}`;
    const thresholdRowHtml = renderThresholdRow(key, p);

    newKeys.add(key);
    let cardCol = existingCards.get(key);

    if (cardCol) {
      // UPDATE existing card (text only)
      const badge = cardCol.querySelector(".badge");
      if (badge) badge.textContent = `${confPct}%`;

      const geoDiv = cardCol.querySelector(".geo-info");
      if (geoDiv) {
        if (geoInfo) geoDiv.innerHTML = `<i class="bi bi-geo-alt me-1"></i>${geoInfo}`;
        else geoDiv.innerHTML = "";
      }

      const thrDiv = cardCol.querySelector(".species-threshold-row");
      if (thrDiv) thrDiv.innerHTML = thresholdRowHtml;

      container.appendChild(cardCol); // Re-order
    } else {
      // CREATE new card
      cardCol = document.createElement("div");
      cardCol.className = "col-md-6 col-lg-4 fade-in";
      cardCol.dataset.species = key;
      cardCol.innerHTML = `
        <div class="card h-100 border-0 shadow-sm overflow-hidden">
          <div class="d-flex h-100">
            <a class="bird-photo-link flex-shrink-0 position-relative d-block" style="width: 90px; background-color: #f8f9fa;" href="#" target="_blank" rel="noopener" title="${tt("lbl_photo_credit", "Photo via Wikipedia")}" onclick="return this.getAttribute('href') !== '#';">
              <img class="bird-photo-img" src="img/dummy.webp"
                   alt="${commonName}"
                   loading="lazy"
                   style="width: 100%; height: 100%; object-fit: cover;"
                   onerror="this.onerror=null; this.src='img/dummy.webp';">
            </a>
            <div class="card-body py-2 px-3 flex-grow-1">
              <div class="d-flex justify-content-between align-items-start mb-1">
                <h6 class="card-title mb-0 fw-bold text-primary text-truncate me-2" style="min-width: 0; font-size: 0.95rem;" title="${commonName}">${commonName}</h6>
                <span class="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-10 flex-shrink-0">
                  ${confPct}%
                </span>
              </div>
              ${scientificName ? `<div class="text-muted fst-italic small mb-2 text-truncate" style="font-size: 0.8rem;">${scientificName}</div>` : ""}
              <div class="small text-muted border-top pt-2 mt-1 geo-info">
                ${geoInfo ? `<i class="bi bi-geo-alt me-1"></i>${geoInfo}` : ""}
              </div>
              <div class="small text-muted species-threshold-row">${thresholdRowHtml}</div>
            </div>
          </div>
        </div>
      `;
      container.appendChild(cardCol);
      loadCardPhoto(cardCol, scientificName);
    }
  });

  // Remove old cards
  existingCards.forEach((node, key) => {
    if (!newKeys.has(key)) node.remove();
  });
}

/**
 * Renders the list of local species (Explore View).
 */
function renderExploreList(list) {
  if (list) lastSpeciesList = list;
  const sourceList = list || lastSpeciesList;

  const container = document.getElementById("exploreList");
  if (!container || !sourceList) return;

  if (!geolocation || !geoEnabled) {
    container.innerHTML = `
      <div class="col-12 text-center py-5 text-muted">
        <i class="bi bi-geo-alt-slash fs-1 d-block mb-3 opacity-25"></i>
        <p data-i18n="msg_explore_geo_disabled">${t("msg_explore_geo_disabled")}</p>
      </div>
    `;
    return;
  }

  const sorted = sourceList
    .filter(item => item.geoscore >= geoThreshold) 
    .sort((a, b) => b.geoscore - a.geoscore);

  container.innerHTML = "";
  
  if (sorted.length === 0) {
    container.innerHTML = `<div class="col-12 text-center text-muted py-5">${t("msg_explore_no_species", Math.round(geoThreshold * 100))}<br>${t("msg_explore_lower_threshold")}</div>`;
    return;
  }

  sorted.forEach(bird => {
    const scorePct = (bird.geoscore * 100).toFixed(1);
    const common = bird.commonNameI18n || bird.commonName;

    const col = document.createElement("div");
    col.className = "col-md-6 col-lg-4";
    col.innerHTML = `
      <div class="card h-100 border-0 shadow-sm overflow-hidden">
        <div class="d-flex h-100">
          <a class="bird-photo-link flex-shrink-0 position-relative d-block" style="width: 90px; background-color: #f8f9fa;" href="#" target="_blank" rel="noopener" title="${tt("lbl_photo_credit", "Photo via Wikipedia")}" onclick="return this.getAttribute('href') !== '#';">
            <img class="bird-photo-img" src="img/dummy.webp"
                 alt="${common}"
                 loading="lazy"
                 style="width: 100%; height: 100%; object-fit: cover;"
                 onerror="this.onerror=null; this.src='img/dummy.webp';">
          </a>
          <div class="card-body py-2 px-3 flex-grow-1">
            <div class="d-flex justify-content-between align-items-start mb-1">
              <div class="overflow-hidden me-2">
                <h6 class="card-title mb-0 fw-bold text-dark text-truncate" style="font-size: 0.95rem;" title="${common}">${common}</h6>
                <div class="text-muted fst-italic small mt-1 text-truncate" style="font-size: 0.8rem;">${bird.scientificName}</div>
              </div>
              <span class="badge bg-light text-dark border flex-shrink-0">
                ${scorePct}%
              </span>
            </div>
            <div class="mt-3">
              <div class="progress" style="height: 4px;">
                <div class="progress-bar bg-success" role="progressbar" style="width: ${scorePct}%" aria-valuenow="${scorePct}" aria-valuemin="0" aria-valuemax="100"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    container.appendChild(col);
    loadCardPhoto(col, bird.scientificName);
  });
}

/* ==========================================================================
   11. GEOLOCATION
   ========================================================================== */

function updateGeoDisplay(key, coords) {
  const status = geoStatusEl();
  const coordsEl = geoCoordsEl();
  if (status) {
    status.textContent = t(key);
    status.setAttribute("data-i18n", key);
  }
  if (coordsEl) {
    coordsEl.textContent = coords
      ? `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)} (±${Math.round(coords.accuracy)}m)`
      : "—";
  }
}

function getGeolocation() {
  if (!navigator.geolocation) {
    updateGeoDisplay("status_geo_unsupported", null);
    return;
  }
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  updateGeoDisplay("status_geo_requesting", null);

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      geolocation = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      };
      updateGeoDisplay("status_geo_acquired", geolocation);
      sendAreaScores();
      renderDetections(); // re-filter with geo prior active
    },
    (err) => {
      console.warn("Geolocation error", err);
      geolocation = null;
      updateGeoDisplay("status_geo_failed", null);
      renderDetections();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 15000,
      timeout: 20000
    }
  );
}

function sendAreaScores() {
  if (!birdnetWorker || !geolocation) return;
  const now = new Date();
  const startYear = new Date(now.getFullYear(), 0, 1);
  const week = Math.min(
    52,
    Math.max(
      1,
      Math.floor((now - startYear) / (7 * 24 * 60 * 60 * 1000)) + 1
    )
  );
  const hour = now.getHours();
  birdnetWorker.postMessage({
    message: "area-scores",
    latitude: geolocation.lat,
    longitude: geolocation.lon,
    week,
    hour
  });
}

/* ==========================================================================
   12. SYSTEM UTILITIES
   ========================================================================== */

// Wake Lock (Keep screen on while recording)
let wakeLock = null;
let wakeLockRequested = false;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLockRequested = true;
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      wakeLockRequested = false;
    });
  } catch (e) {
    console.warn("Wake Lock request failed:", e);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(()=>{});
    wakeLock = null;
    wakeLockRequested = false;
  }
}

// Lifecycle Management
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isListening) {
    stopListening();
  }
});

window.addEventListener("pagehide", () => {
  if (isListening) {
    stopListening();
  }
});

/**
 * Temporal Pooling: Log-Mean-Exp over logits.
 * Smooths predictions over time to reduce noise.
 */
function computeTemporalPooledDetections(sets) {
  if (!sets || !sets.length) return [];
  if (sets.length === 1) return sets[0];

  const eps = 1e-8;
  const byIndex = new Map();
  
  // Group confidences by species index
  for (let s = 0; s < sets.length; s++) {
    for (const det of sets[s]) {
      const idx = det.index;
      if (!byIndex.has(idx)) {
        byIndex.set(idx, { samples: [], ref: det });
      }
      byIndex.get(idx).samples.push(det.confidence);
    }
  }

  const pooled = [];
  for (const [idx, entry] of byIndex.entries()) {
    const samples = entry.samples;
    // Convert confidences to logits
    const logits = samples.map(c => {
      const clipped = Math.min(1 - eps, Math.max(eps, c));
      return Math.log(clipped / (1 - clipped));
    });
    
    // Log-mean-exp pooling
    const maxLogit = Math.max(...logits);
    const sumExp = logits.reduce((acc, l) => acc + Math.exp(l - maxLogit), 0);
    const lme = maxLogit + Math.log(sumExp / logits.length);
    
    // Back to probability
    const pooledConf = 1 / (1 + Math.exp(-lme));

    pooled.push({
      ...entry.ref,
      confidence: pooledConf
    });
  }

  pooled.sort((a, b) => b.confidence - a.confidence);
  return pooled;
}

/* ==========================================================================
   13. MAP VIEW (local-only for now — see About page roadmap for the
   shared/Telegram version)
   ========================================================================== */

const SOCHI_CENTER = [43.6028, 39.7342];

/**
 * Plots every session-history entry that has a location on a Leaflet map.
 * Entirely local: reads the same detectionHistory array/localStorage used
 * by the Live page's history log, nothing is sent anywhere.
 */
// Rough clamp range for coloring relative noise samples — not calibrated
// SPL thresholds, just the typical span this analyser tends to produce.
const NOISE_COLOR_MIN_DB = -90;
const NOISE_COLOR_MAX_DB = -20;

function initMapPage() {
  const mapEl = document.getElementById("mapView");
  if (!mapEl || typeof L === "undefined") return;

  const birdPoints = detectionHistory.filter(h => typeof h.lat === "number" && typeof h.lon === "number");
  const noisePoints = noiseHistory.filter(h => typeof h.lat === "number" && typeof h.lon === "number");
  const anyPoint = birdPoints[0] || noisePoints[0];

  const map = L.map("mapView").setView(anyPoint ? [anyPoint.lat, anyPoint.lon] : SOCHI_CENTER, anyPoint ? 12 : 10);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
  }).addTo(map);

  const birdMarkers = birdPoints.map(h => {
    const marker = L.marker([h.lat, h.lon]).addTo(map);
    const time = new Date(h.t).toLocaleString();
    marker.bindPopup(`<strong>${h.commonName}</strong><br>${time}<br>${Math.round(h.confidence * 100)}%`);
    return marker;
  });

  const noiseMarkers = noisePoints.map(h => {
    const t01 = Math.max(0, Math.min(1, (h.db - NOISE_COLOR_MIN_DB) / (NOISE_COLOR_MAX_DB - NOISE_COLOR_MIN_DB)));
    const color = typeof d3 !== "undefined" ? d3.interpolateRdYlGn(1 - t01) : "#888";
    const marker = L.circleMarker([h.lat, h.lon], {
      radius: 7,
      color,
      fillColor: color,
      fillOpacity: 0.6,
      weight: 1
    }).addTo(map);
    const time = new Date(h.t).toLocaleString();
    marker.bindPopup(`${tt("lbl_noise_level", "Noise")}: ${h.db} dB (rel.)<br>${time}`);
    return marker;
  });

  const allMarkers = [...birdMarkers, ...noiseMarkers];
  if (allMarkers.length > 1) {
    map.fitBounds(L.featureGroup(allMarkers).getBounds().pad(0.2));
  }

  const note = document.getElementById("mapEmptyNote");
  if (note && !allMarkers.length) note.classList.remove("d-none");
}
