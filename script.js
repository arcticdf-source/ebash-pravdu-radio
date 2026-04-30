// ===== ИНИЦИАЛИЗАЦИЯ ЭЛЕМЕНТОВ =====
const radioStream = document.getElementById('radioStream');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const nextBtn = document.getElementById('nextBtn');
const turntable = document.getElementById('turntable');
const lyricsTitle = document.getElementById('lyricsTitle');
const lyricsArtist = document.getElementById('lyricsArtist');
const lyricsContent = document.getElementById('lyricsContent');
const recentHistoryList = document.getElementById('recentHistoryList');
const listenersNowCount = document.getElementById('listenersNowCount');
const realListenersNow = document.getElementById('realListenersNow');

function resolveImageWithFallbacks(imageSelector, options) {
    const imageElement = document.querySelector(imageSelector);
    if (!imageElement) {
        return;
    }

    const {
        candidates,
        containerSelector,
        fallbackClass
    } = options;

    const container = containerSelector ? document.querySelector(containerSelector) : null;
    let index = 0;

    const applyFallback = () => {
        imageElement.style.display = 'none';
        if (container && fallbackClass) {
            container.classList.add(fallbackClass);
        }
    };

    const tryNextSource = () => {
        if (index >= candidates.length) {
            applyFallback();
            return;
        }

        const candidate = candidates[index++];
        const testImage = new Image();
        testImage.onload = () => {
            imageElement.src = candidate;
            imageElement.style.display = 'block';
            if (container && fallbackClass) {
                container.classList.remove(fallbackClass);
            }
        };
        testImage.onerror = () => {
            tryNextSource();
        };
        testImage.src = candidate;
    };

    tryNextSource();
}

// ===== ЛОКАЛЬНЫЙ ПЛЕЙЛИСТ ИЗ ПАПКИ music =====
let playlist = [];
let isPlaying = false;
let currentTrackIndex = 0;
let recentSongs = [];
let hasRecordedCurrentTrackPlay = false;
let randomStartOffsetApplied = false;
const PLAY_HISTORY_STORAGE_KEY = 'duhaBornAgainPlayHistory';
const BROKEN_TRACKS_STORAGE_KEY = 'duhaBornAgainBrokenTracks';
const SESSION_RECENT_TRACKS_STORAGE_KEY = 'duhaBornAgainSessionRecentTracks';
const SESSION_START_ANTI_REPEAT_COUNT = 5;
const ARTIST_ANTI_REPEAT_DEPTH = 3;
const PLAY_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYS_PER_TRACK_PER_WINDOW = 2;
const PLAYLIST_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const LISTENERS_MIN = 5000;
const LISTENERS_MAX = 10000;
const LISTENERS_BASELINE = 7500;
const LISTENERS_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const LISTENERS_STATE_STORAGE_KEY = 'duhaBornAgainListenersState';
const REAL_LISTENERS_NAMESPACE = 'ebash-pravdu-radio';
const REAL_LISTENERS_KEY = 'online-now';
const REAL_LISTENERS_REFRESH_INTERVAL_MS = 20 * 1000;
const REAL_LISTENERS_PRESENCE_REGISTERED_KEY = 'ebashRealPresenceRegistered';
const REAL_LISTENERS_TAB_ID_KEY = 'ebashRealListenersTabId';
const REAL_LISTENERS_OWNER_STORAGE_KEY = 'ebashShowRealCounter';
const REAL_LISTENERS_SESSION_KEY = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const METRIKA_COUNTER_ID = 108785006;
const METRIKA_GOAL_PLAY = 'radio_play';
const METRIKA_GOAL_NEXT = 'radio_next';
const METRIKA_GOAL_LISTEN_60S = 'radio_listen_60s';
const PLAYLIST_URL = (window.DUHA_PLAYLIST_URL || '').trim();
const LYRICS_API_BASE_URL = (window.DUHA_LYRICS_API_BASE_URL || '').trim();
const RANDOM_START_MIN_OFFSET_SEC = 15;
const RANDOM_START_TAIL_GUARD_SEC = 25;
const RANDOM_START_MIN_DURATION_SEC = 90;
const RANDOM_START_MIN_FRACTION = 0.2;
const RANDOM_START_MAX_FRACTION = 0.78;
let playHistoryByFile = loadPlayHistory();
const brokenTrackFiles = loadBrokenTrackFiles();
let previousSessionRecentTracks = loadPreviousSessionRecentTracks();
let antiRepeatRemaining = SESSION_START_ANTI_REPEAT_COUNT;
let recentArtists = [];
let lyricsRequestToken = 0;
const lyricsCache = new Map();
let trackFailureInProgress = false;
let nextTrackInProgress = false;
let renderedTrackKey = '';
let simulatedListenersNow = null;
let realListenersOwnerMode = false;
let realPresenceRegistered = false;
let realtimeListenersPollingTimer = null;
let listen60GoalTimer = null;
let listen60GoalSent = false;

function sendMetrikaGoal(goalName, params = {}) {
    if (typeof window.ym !== 'function') {
        return;
    }

    try {
        window.ym(METRIKA_COUNTER_ID, 'reachGoal', goalName, params);
    } catch (error) {
        console.warn(`Не удалось отправить цель Метрики ${goalName}:`, error);
    }
}

function cancelListen60GoalTimer() {
    if (!listen60GoalTimer) {
        return;
    }

    clearTimeout(listen60GoalTimer);
    listen60GoalTimer = null;
}

function scheduleListen60GoalIfNeeded() {
    if (listen60GoalSent || listen60GoalTimer || !isPlaying) {
        return;
    }

    listen60GoalTimer = setTimeout(() => {
        listen60GoalTimer = null;

        if (!isPlaying || listen60GoalSent) {
            return;
        }

        listen60GoalSent = true;
        sendMetrikaGoal(METRIKA_GOAL_LISTEN_60S);
    }, 60 * 1000);
}

// ===== СЧЁТЧИК РЕАЛЬНЫХ СЛУШАТЕЛЕЙ (Firebase RTDB Presence) =====
// Каждый посетитель создаёт запись /presence/{sessionKey}.
// Firebase автоматически удаляет её при разрыве соединения (onDisconnect),
// поэтому счётчик не дрейфует даже при краше браузера или мобильном off.

function resolveRealListenersOwnerMode() {
    const params = new URLSearchParams(window.location.search);
    const queryValue = params.get('real');

    if (queryValue === '1') {
        localStorage.setItem(REAL_LISTENERS_OWNER_STORAGE_KEY, '1');
    } else if (queryValue === '0') {
        localStorage.removeItem(REAL_LISTENERS_OWNER_STORAGE_KEY);
    }

    return localStorage.getItem(REAL_LISTENERS_OWNER_STORAGE_KEY) === '1';
}

function renderRealListenersValue(value) {
    if (!realListenersNow || !realListenersOwnerMode) {
        return;
    }

    realListenersNow.hidden = false;
    realListenersNow.textContent = `реально онлайн на сайте: ${Math.max(0, value)}`;
}

function initRealListenersCounter() {
    if (!realListenersNow) {
        return;
    }

    realListenersOwnerMode = resolveRealListenersOwnerMode();
    realListenersNow.hidden = !realListenersOwnerMode;

    const cfg = window.FIREBASE_PRESENCE_CONFIG;

    if (!cfg || typeof window.firebase === 'undefined') {
        // Firebase не настроен — используем CounterAPI.
        if (realListenersOwnerMode) {
            realListenersNow.hidden = false;
            realListenersNow.textContent = 'реально онлайн: загрузка...';
            initRealtimeListenersNow();
        }

        return;
    }

    if (realListenersOwnerMode) {
        realListenersNow.hidden = false;
        realListenersNow.textContent = 'реально онлайн на сайте: загрузка...';
    }

    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(cfg);
        }

        const db = firebase.database();
        const presenceRef = db.ref(`presence/${REAL_LISTENERS_SESSION_KEY}`);
        const connectedRef = db.ref('.info/connected');

        // Регистрируем присутствие при подключении.
        // onDisconnect гарантирует удаление записи на стороне Firebase
        // даже при краше браузера, смене сети или закрытии вкладки без события.
        connectedRef.on('value', (snap) => {
            if (!snap.val()) {
                return;
            }

            presenceRef.onDisconnect().remove();
            presenceRef.set({ connectedAt: firebase.database.ServerValue.TIMESTAMP });
            realPresenceRegistered = true;
        });

        // Показываем счётчик только владельцу (режим ?real=1).
        if (realListenersOwnerMode) {
            db.ref('presence').on('value', (snap) => {
                renderRealListenersValue(snap.numChildren());
            });
        }

    } catch (err) {
        console.warn('Не удалось инициализировать Firebase presence:', err);

        if (realListenersOwnerMode) {
            realListenersNow.textContent = 'реально онлайн: ошибка Firebase';
        }
    }
}

const fallbackMusicFiles = [
    'Balu_Brigada_-_Backseat_79753203.mp3',
    'blink-182_-_I_Miss_You_80080581.mp3',
    'Counting_Crows_-_Accidentally_In_Love_48052726.mp3',
    'Counting_Crows_-_Mr_Jones_47970797.mp3',
    'Dave_Matthews_Band_-_Crash_into_Me_73077146.mp3',
    'Dave_Matthews_Band_-_Mother_Father_63136909.mp3',
    'Dave_Matthews_Band_-_The_Space_Between_80370129.mp3',
    'Dave_Matthews_Band_-_Where_Are_You_Going_17026281.mp3'
];

function parseTrackMetadata(filename) {
    const decodedFilename = decodeURIComponent(filename);
    const withoutExtension = decodedFilename.replace(/\.[^/.]+$/, '');
    const withoutNumericSuffix = withoutExtension.replace(/_\d+$/, '');
    const normalized = withoutNumericSuffix
        .replace(/\s*_\-_\s*/g, ' - ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = normalized.split(/\s+-\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return {
            artist: parts.shift(),
            title: parts.join(' - ')
        };
    }

    return {
        artist: 'Local Artist',
        title: normalized
    };
}

function buildPlaylistFromFiles(files) {
    return files.map((file) => ({
        ...parseTrackMetadata(file),
        sourceFileName: file,
        file: `music/${encodeURIComponent(file)}`
    }));
}

function normalizeRemoteTrack(track, playlistUrl) {
    if (!track || typeof track !== 'object') {
        return null;
    }

    const rawFile = typeof track.file === 'string' ? track.file.trim() : '';
    const rawUrl = typeof track.url === 'string' ? track.url.trim() : '';
    const source = rawFile || rawUrl;

    if (!source) {
        return null;
    }

    const resolvedFile = new URL(source, playlistUrl).toString();
    const sourceFileName = decodeURIComponent(resolvedFile.split('/').pop() || 'track');
    const metadata = parseTrackMetadata(sourceFileName);

    return {
        title: typeof track.title === 'string' && track.title.trim() ? track.title.trim() : metadata.title,
        artist: typeof track.artist === 'string' && track.artist.trim() ? track.artist.trim() : metadata.artist,
        file: resolvedFile,
        sourceFileName,
        lyrics: typeof track.lyrics === 'string' ? track.lyrics.trim() : '',
        lyricsFile: typeof track.lyricsFile === 'string' && track.lyricsFile.trim()
            ? new URL(track.lyricsFile.trim(), playlistUrl).toString()
            : ''
    };
}

async function loadPlaylistFromRemoteSource() {
    if (!PLAYLIST_URL) {
        return false;
    }

    try {
        const response = await fetch(PLAYLIST_URL, { cache: 'no-store' });
        if (!response.ok) {
            return false;
        }

        const payload = await response.json();
        if (!Array.isArray(payload)) {
            return false;
        }

        const remotePlaylist = payload
            .map((track) => normalizeRemoteTrack(track, PLAYLIST_URL))
            .filter(Boolean);

        if (remotePlaylist.length === 0) {
            return false;
        }

        playlist = remotePlaylist;
        window.playlist = playlist;
        return true;
    } catch (error) {
        console.error('Не удалось загрузить удаленный playlist.json:', error);
        return false;
    }
}

function loadPlayHistory() {
    try {
        const raw = localStorage.getItem(PLAY_HISTORY_STORAGE_KEY);
        if (!raw) {
            return {};
        }

        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn('Не удалось прочитать историю воспроизведений:', error);
        return {};
    }
}

function savePlayHistory() {
    try {
        localStorage.setItem(PLAY_HISTORY_STORAGE_KEY, JSON.stringify(playHistoryByFile));
    } catch (error) {
        console.warn('Не удалось сохранить историю воспроизведений:', error);
    }
}

function loadBrokenTrackFiles() {
    try {
        const raw = localStorage.getItem(BROKEN_TRACKS_STORAGE_KEY);
        if (!raw) {
            return new Set();
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return new Set();
        }

        return new Set(parsed.filter((file) => typeof file === 'string' && file.trim()));
    } catch (error) {
        console.warn('Не удалось прочитать список поврежденных треков:', error);
        return new Set();
    }
}

function saveBrokenTrackFiles() {
    try {
        localStorage.setItem(BROKEN_TRACKS_STORAGE_KEY, JSON.stringify(Array.from(brokenTrackFiles)));
    } catch (error) {
        console.warn('Не удалось сохранить список поврежденных треков:', error);
    }
}

function pruneBrokenTrackFiles() {
    const playlistFiles = new Set(playlist.map((track) => track.file));
    let changed = false;

    Array.from(brokenTrackFiles).forEach((file) => {
        if (!playlistFiles.has(file)) {
            brokenTrackFiles.delete(file);
            changed = true;
        }
    });

    if (changed) {
        saveBrokenTrackFiles();
    }
}

function loadPreviousSessionRecentTracks() {
    try {
        const raw = localStorage.getItem(SESSION_RECENT_TRACKS_STORAGE_KEY);
        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter((file) => typeof file === 'string' && file.trim())
            .slice(0, SESSION_START_ANTI_REPEAT_COUNT);
    } catch (error) {
        console.warn('Не удалось прочитать треки прошлой сессии:', error);
        return [];
    }
}

function saveCurrentSessionRecentTracks() {
    const recentFiles = recentSongs
        .map((song) => song?.file)
        .filter((file) => typeof file === 'string' && file.trim())
        .slice(0, SESSION_START_ANTI_REPEAT_COUNT);

    try {
        localStorage.setItem(SESSION_RECENT_TRACKS_STORAGE_KEY, JSON.stringify(recentFiles));
    } catch (error) {
        console.warn('Не удалось сохранить треки текущей сессии:', error);
    }
}

function prunePlayHistory(now = Date.now()) {
    const cutoff = now - PLAY_LIMIT_WINDOW_MS;
    const normalizedHistory = {};

    Object.entries(playHistoryByFile).forEach(([file, timestamps]) => {
        if (!Array.isArray(timestamps)) {
            return;
        }

        const validTimestamps = timestamps
            .filter((ts) => Number.isFinite(ts) && ts >= cutoff)
            .sort((a, b) => a - b);

        if (validTimestamps.length > 0) {
            normalizedHistory[file] = validTimestamps;
        }
    });

    playHistoryByFile = normalizedHistory;
    savePlayHistory();
}

function getTrackPlayCountInWindow(file, now = Date.now()) {
    const cutoff = now - PLAY_LIMIT_WINDOW_MS;
    const timestamps = Array.isArray(playHistoryByFile[file]) ? playHistoryByFile[file] : [];
    return timestamps.filter((ts) => ts >= cutoff).length;
}

function recordCurrentTrackPlay() {
    const current = playlist[currentTrackIndex];
    if (!current) {
        return;
    }

    const now = Date.now();
    prunePlayHistory(now);

    const existing = Array.isArray(playHistoryByFile[current.file]) ? playHistoryByFile[current.file] : [];
    existing.push(now);
    playHistoryByFile[current.file] = existing;
    savePlayHistory();
}

function normalizeArtist(artist) {
    return (artist || '').trim().toLowerCase();
}

function getEligibleTrackIndices(excludeIndex = null) {
    return playlist
        .map((track, index) => ({ track, index }))
        .filter(({ track, index }) => {
            if (excludeIndex !== null && index === excludeIndex && playlist.length > 1) {
                return false;
            }

            if (brokenTrackFiles.has(track.file)) {
                return false;
            }

            if (getTrackPlayCountInWindow(track.file) >= MAX_PLAYS_PER_TRACK_PER_WINDOW) {
                return false;
            }

            return true;
        })
        .map(({ index }) => index);
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffleArray(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function seedRecentHistoryWithRandomTracks(excludeIndex = null) {
    if (recentSongs.length > 0 || playlist.length === 0) {
        return;
    }

    const poolWithExclude = playlist
        .map((track, index) => ({ track, index }))
        .filter(({ index }) => excludeIndex === null || index !== excludeIndex);

    const sourcePool = poolWithExclude.length > 0
        ? poolWithExclude
        : playlist.map((track, index) => ({ track, index }));

    const shuffled = shuffleArray(sourcePool);
    const initialHistory = [];
    const targetCount = Math.min(5, shuffled.length);

    for (let i = 0; i < targetCount; i += 1) {
        const track = shuffled[i].track;
        initialHistory.push({
            title: track.title,
            artist: track.artist,
            file: track.file
        });
    }

    recentSongs = initialHistory;
}

function renderSimulatedListenersNow() {
    if (!listenersNowCount || !Number.isFinite(simulatedListenersNow)) {
        return;
    }

    listenersNowCount.textContent = String(simulatedListenersNow);
}

function saveSimulatedListenersState(updatedAt = Date.now()) {
    if (!Number.isFinite(simulatedListenersNow)) {
        return;
    }

    try {
        localStorage.setItem(LISTENERS_STATE_STORAGE_KEY, JSON.stringify({
            value: simulatedListenersNow,
            updatedAt
        }));
    } catch (error) {
        console.warn('Не удалось сохранить состояние счетчика слушателей:', error);
    }
}

function loadSimulatedListenersState() {
    try {
        const raw = localStorage.getItem(LISTENERS_STATE_STORAGE_KEY);
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw);
        const value = Number(parsed?.value);
        const updatedAt = Number(parsed?.updatedAt);
        const hasValidValue = Number.isFinite(value) && value >= LISTENERS_MIN && value <= LISTENERS_MAX;
        const hasValidTimestamp = Number.isFinite(updatedAt) && updatedAt > 0;

        if (!hasValidValue || !hasValidTimestamp) {
            return null;
        }

        return { value, updatedAt };
    } catch (error) {
        console.warn('Не удалось прочитать состояние счетчика слушателей:', error);
        return null;
    }
}

function updateSimulatedListenersNow() {
    if (!Number.isFinite(simulatedListenersNow)) {
        simulatedListenersNow = getRandomInt(LISTENERS_MIN, LISTENERS_MAX);
        renderSimulatedListenersNow();
        saveSimulatedListenersState();
        return;
    }

    const minStep = 6;
    const maxStep = 28;
    const step = getRandomInt(minStep, maxStep);
    const biasToGrow = simulatedListenersNow <= LISTENERS_BASELINE ? 0.56 : 0.44;
    let direction = Math.random() < biasToGrow ? 1 : -1;

    if (simulatedListenersNow <= LISTENERS_MIN + 40) {
        direction = 1;
    } else if (simulatedListenersNow >= LISTENERS_MAX - 40) {
        direction = -1;
    }

    simulatedListenersNow += direction * step;
    simulatedListenersNow = Math.max(LISTENERS_MIN, Math.min(LISTENERS_MAX, simulatedListenersNow));
    renderSimulatedListenersNow();
    saveSimulatedListenersState();
}

function initSimulatedListenersNow() {
    if (!listenersNowCount) {
        return;
    }

    const savedState = loadSimulatedListenersState();
    let lastUpdatedAt = Date.now();

    if (savedState) {
        simulatedListenersNow = savedState.value;
        lastUpdatedAt = savedState.updatedAt;
    } else {
        simulatedListenersNow = getRandomInt(LISTENERS_MIN, LISTENERS_MAX);
        saveSimulatedListenersState(lastUpdatedAt);
    }

    renderSimulatedListenersNow();

    const elapsedMs = Date.now() - lastUpdatedAt;
    const msUntilNextUpdate = elapsedMs >= LISTENERS_UPDATE_INTERVAL_MS
        ? 0
        : LISTENERS_UPDATE_INTERVAL_MS - elapsedMs;

    setTimeout(() => {
        updateSimulatedListenersNow();
        setInterval(() => {
            updateSimulatedListenersNow();
        }, LISTENERS_UPDATE_INTERVAL_MS);
    }, msUntilNextUpdate);
}

function getRealtimeListenersEndpoint(action = '') {
    const basePath = `https://api.counterapi.dev/v1/${encodeURIComponent(REAL_LISTENERS_NAMESPACE)}/${encodeURIComponent(REAL_LISTENERS_KEY)}`;
    return action ? `${basePath}/${action}` : basePath;
}

function getRealtimeListenersTabId() {
    const existing = sessionStorage.getItem(REAL_LISTENERS_TAB_ID_KEY);
    if (existing) {
        return existing;
    }

    const generated = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(REAL_LISTENERS_TAB_ID_KEY, generated);
    return generated;
}

function renderRealtimeListenersNow(value) {
    const normalized = Math.max(0, Number(value) || 0);

    // Симулированный публичный счётчик не трогаем — только реальный для владельца.
    if (realListenersOwnerMode) {
        renderRealListenersValue(normalized);
    }
}

async function refreshRealtimeListenersNow() {
    try {
        const response = await fetch(getRealtimeListenersEndpoint(), {
            cache: 'no-store'
        });

        if (!response.ok) {
            return;
        }

        const payload = await response.json();
        const count = Number(payload?.count);

        if (Number.isFinite(count)) {
            renderRealtimeListenersNow(count);
        }
    } catch (error) {
        console.warn('Не удалось получить реальный онлайн счетчик:', error);
    }
}

function updateRealtimePresence(direction) {
    const action = direction > 0 ? 'up' : 'down';

    fetch(getRealtimeListenersEndpoint(action), {
        cache: 'no-store',
        keepalive: true
    }).catch((error) => {
        console.warn('Не удалось обновить присутствие в счетчике:', error);
    });
}

function registerRealtimePresence() {
    if (sessionStorage.getItem(REAL_LISTENERS_PRESENCE_REGISTERED_KEY) === '1') {
        return;
    }

    getRealtimeListenersTabId();
    sessionStorage.setItem(REAL_LISTENERS_PRESENCE_REGISTERED_KEY, '1');
    updateRealtimePresence(1);
}

function unregisterRealtimePresence() {
    if (sessionStorage.getItem(REAL_LISTENERS_PRESENCE_REGISTERED_KEY) !== '1') {
        return;
    }

    sessionStorage.removeItem(REAL_LISTENERS_PRESENCE_REGISTERED_KEY);
    updateRealtimePresence(-1);
}

function initRealtimeListenersNow() {
    registerRealtimePresence();
    refreshRealtimeListenersNow();

    if (realtimeListenersPollingTimer) {
        clearInterval(realtimeListenersPollingTimer);
    }

    realtimeListenersPollingTimer = setInterval(() => {
        refreshRealtimeListenersNow();
    }, REAL_LISTENERS_REFRESH_INTERVAL_MS);

    window.addEventListener('beforeunload', unregisterRealtimePresence);
    window.addEventListener('pagehide', unregisterRealtimePresence);
    window.addEventListener('pageshow', () => {
        registerRealtimePresence();
        refreshRealtimeListenersNow();
    });
}

function getEligibleTrackIndicesAvoidingRecentArtists(excludeIndex = null) {
    const eligible = getEligibleTrackIndices(excludeIndex);
    if (recentArtists.length === 0) {
        return eligible;
    }

    const recentArtistSet = new Set(recentArtists.map(normalizeArtist));
    const filtered = eligible.filter((index) => {
        const artist = normalizeArtist(playlist[index]?.artist);
        return !recentArtistSet.has(artist);
    });

    return filtered.length > 0 ? filtered : eligible;
}

function getEligibleTrackIndicesAvoidingPreviousSession(excludeIndex = null) {
    const previousSessionSet = new Set(previousSessionRecentTracks);
    const eligible = getEligibleTrackIndicesAvoidingRecentArtists(excludeIndex);

    if (antiRepeatRemaining <= 0 || previousSessionSet.size === 0) {
        return eligible;
    }

    const filtered = eligible.filter((index) => {
        const file = playlist[index]?.file;
        return file && !previousSessionSet.has(file);
    });

    return filtered.length > 0 ? filtered : eligible;
}

function chooseRandomNextTrackIndex() {
    if (playlist.length === 0) {
        return null;
    }

    let eligible = getEligibleTrackIndicesAvoidingPreviousSession(currentTrackIndex);

    if (eligible.length === 0) {
        eligible = getEligibleTrackIndicesAvoidingPreviousSession(null);
    }

    if (eligible.length === 0) {
        return null;
    }

    const randomPosition = Math.floor(Math.random() * eligible.length);
    return eligible[randomPosition];
}

function chooseRandomStartTrackIndex() {
    if (playlist.length === 0) {
        return null;
    }

    let eligible = getEligibleTrackIndicesAvoidingPreviousSession(null);
    if (eligible.length === 0) {
        eligible = playlist
            .map((track, index) => ({ track, index }))
            .filter(({ track }) => !brokenTrackFiles.has(track.file))
            .map(({ index }) => index);
    }

    if (eligible.length === 0) {
        eligible = playlist.map((_, index) => index);
    }

    const randomPosition = Math.floor(Math.random() * eligible.length);
    return eligible[randomPosition];
}

function hasPlayableTracks() {
    return playlist.some((track) => !brokenTrackFiles.has(track.file));
}

function markCurrentTrackAsBroken() {
    const failedTrack = playlist[currentTrackIndex];
    if (!failedTrack) {
        return null;
    }

    brokenTrackFiles.add(failedTrack.file);
    saveBrokenTrackFiles();
    return failedTrack;
}

function skipBrokenCurrentTrack(message) {
    if (trackFailureInProgress) {
        return;
    }

    const failedTrack = markCurrentTrackAsBroken();
    if (failedTrack) {
        console.warn('Трек помечен как поврежденный и будет пропускаться:', failedTrack.file);
    }

    if (!hasPlayableTracks()) {
        pause();
        lyricsContent.textContent = 'Все найденные треки недоступны или повреждены. Добавьте рабочие аудиофайлы в папку music.';
        return;
    }

    trackFailureInProgress = true;
    internalNextTrack(true, {
        pushToHistory: false,
        failedTrackMessage: true,
        failureMessage: message
    }).finally(() => {
        trackFailureInProgress = false;
    });
}

function handlePlayError(err, options = {}) {
    const { fromUserAction = false } = options;
    const errorName = err?.name || '';

    console.error('Ошибка воспроизведения:', err);

    // AbortError часто возникает при быстром переключении src и не означает битый файл.
    if (errorName === 'AbortError') {
        return;
    }

    // Браузер может заблокировать autoplay вне жеста пользователя.
    if (errorName === 'NotAllowedError') {
        lyricsContent.textContent = fromUserAction
            ? 'Браузер заблокировал запуск трека. Нажмите Play еще раз.'
            : 'Автозапуск заблокирован браузером. Нажмите Play.';
        return;
    }

    skipBrokenCurrentTrack('Не удалось воспроизвести трек. Он автоматически пропущен.');
}

function playWhenReady(options = {}) {
    const attemptPlay = () => {
        // Применяем случайную стартовую позицию прямо перед воспроизведением.
        if (!randomStartOffsetApplied && radioStream.readyState >= 2) {
            randomStartOffsetApplied = true;
            const duration = Number(radioStream.duration);
            if (Number.isFinite(duration) && duration > RANDOM_START_MIN_DURATION_SEC) {
                const minByFraction = duration * RANDOM_START_MIN_FRACTION;
                const maxByFraction = duration * RANDOM_START_MAX_FRACTION;
                const minOffset = Math.max(RANDOM_START_MIN_OFFSET_SEC, Math.floor(minByFraction));
                const maxOffset = Math.min(Math.floor(maxByFraction), Math.floor(duration - RANDOM_START_TAIL_GUARD_SEC));

                if (maxOffset > minOffset) {
                    const randomOffset = getRandomInt(minOffset, maxOffset);
                    try {
                        radioStream.currentTime = randomOffset;
                    } catch (error) {
                        console.warn('Не удалось установить случайную стартовую позицию:', error);
                    }
                }
            }
        }

        radioStream.play().catch((err) => handlePlayError(err, options));
    };

    if (radioStream.readyState >= 2) {
        attemptPlay();
        return;
    }

    radioStream.addEventListener('canplay', attemptPlay, { once: true });
}

function prettifyTrackTitle(filename) {
    return filename
        .replace(/\.[^/.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getLyricsPlaceholder() {
    return '';
}

function getLyricsLoadingMessage(title, artist) {
    return `Ищу текст песни...\n\nТрек: ${title}\nИсполнитель: ${artist}`;
}

function stripLrcTimestamps(content) {
    return content
        .split('\n')
        .map((line) => line.replace(/\[[0-9]{1,2}:[0-9]{2}(?:\.[0-9]{1,3})?\]/g, '').trim())
        .filter(Boolean)
        .join('\n');
}

function getLocalLyricsCandidates(track) {
    const sourceFileName = track.sourceFileName || decodeURIComponent(track.file.split('/').pop());
    const baseName = sourceFileName.replace(/\.[^/.]+$/, '');
    return [
        { url: `music/${encodeURIComponent(baseName)}.txt`, type: 'txt' },
        { url: `music/${encodeURIComponent(baseName)}.lrc`, type: 'lrc' }
    ];
}

async function fetchLocalLyrics(track) {
    if (track.lyrics) {
        return track.lyrics;
    }

    if (track.lyricsFile) {
        try {
            const response = await fetch(track.lyricsFile, { cache: 'no-store' });
            if (response.ok) {
                return (await response.text()).trim();
            }
        } catch (error) {
            console.warn(`Не удалось прочитать удаленный текст ${track.lyricsFile}:`, error);
        }
    }

    if (!window.location.protocol.startsWith('http')) {
        return null;
    }

    const cacheKey = track.sourceFileName || track.file;
    if (lyricsCache.has(cacheKey)) {
        return lyricsCache.get(cacheKey);
    }

    const candidates = getLocalLyricsCandidates(track);

    for (const candidate of candidates) {
        try {
            const response = await fetch(candidate.url, { cache: 'no-store' });
            if (!response.ok) {
                continue;
            }

            const rawText = await response.text();
            const normalized = candidate.type === 'lrc'
                ? stripLrcTimestamps(rawText)
                : rawText.trim();

            if (normalized) {
                lyricsCache.set(cacheKey, normalized);
                return normalized;
            }
        } catch (error) {
            console.warn(`Не удалось прочитать локальный текст ${candidate.url}:`, error);
        }
    }

    lyricsCache.set(cacheKey, null);
    return null;
}

async function fetchLyricsFromConfiguredApi(track) {
    if (!LYRICS_API_BASE_URL) {
        return null;
    }

    const url = new URL(LYRICS_API_BASE_URL);
    url.searchParams.set('artist', track.artist);
    url.searchParams.set('title', track.title);

    const response = await fetch(url.toString(), {
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Lyrics API returned ${response.status}`);
    }

    const payload = await response.json();
    const lyrics = payload?.lyrics || payload?.text || payload?.plainLyrics || payload?.content;
    return typeof lyrics === 'string' && lyrics.trim() ? lyrics.trim() : null;
}

async function updateLyricsForCurrentTrack() {
    const current = playlist[currentTrackIndex];
    const requestToken = ++lyricsRequestToken;

    if (!current) {
        lyricsContent.textContent = 'В папке music пока нет поддерживаемых файлов (mp3/wav/ogg/m4a/aac).';
        return;
    }

    lyricsContent.textContent = getLyricsLoadingMessage(current.title, current.artist);

    try {
        const localLyrics = await fetchLocalLyrics(current);
        if (requestToken !== lyricsRequestToken) {
            return;
        }

        if (localLyrics) {
            lyricsContent.textContent = localLyrics;
            return;
        }

        if (!LYRICS_API_BASE_URL) {
            lyricsContent.textContent = getLyricsPlaceholder();
            return;
        }

        const lyrics = await fetchLyricsFromConfiguredApi(current);
        if (requestToken !== lyricsRequestToken) {
            return;
        }

        lyricsContent.textContent = lyrics || `Текст для \"${current.title}\" не найден ни локально, ни в подключенном источнике.`;
    } catch (error) {
        console.error('Не удалось загрузить текст песни:', error);
        if (requestToken !== lyricsRequestToken) {
            return;
        }

        lyricsContent.textContent = `Не удалось получить текст песни.\n\nПоложите рядом с треком файл .txt или .lrc с тем же именем.\n\nТрек: ${current.title}\nИсполнитель: ${current.artist}`;
    }
}

async function loadPlaylistFromMusicFolder() {
    const remoteLoaded = await loadPlaylistFromRemoteSource();
    if (remoteLoaded) {
        return true;
    }

    if (!window.location.protocol.startsWith('http')) {
        playlist = buildPlaylistFromFiles(fallbackMusicFiles);
        window.playlist = playlist;
        return playlist.length > 0;
    }

    try {
        const response = await fetch('music/', { cache: 'no-store' });
        if (!response.ok) {
            return false;
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const supported = /\.(mp3|wav|ogg|m4a|aac)$/i;

        const files = Array.from(doc.querySelectorAll('a'))
            .map((a) => a.getAttribute('href') || '')
            .filter((href) => supported.test(href))
            .map((href) => decodeURIComponent(href.split('/').pop()));

        const uniqueSortedFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b));
        playlist = buildPlaylistFromFiles(uniqueSortedFiles);

        window.playlist = playlist;
        return playlist.length > 0;
    } catch (error) {
        console.error('Не удалось прочитать папку music:', error);
        playlist = buildPlaylistFromFiles(fallbackMusicFiles);
        window.playlist = playlist;
        return playlist.length > 0;
    }
}

function updateUIForCurrentTrack() {
    const current = playlist[currentTrackIndex];

    if (!current) {
        lyricsTitle.textContent = 'EBASH-PRAVDU-RADIO®';
        lyricsArtist.textContent = 'Local Playlist';
        lyricsContent.textContent = 'В папке music пока нет поддерживаемых файлов (mp3/wav/ogg/m4a/aac).';
        renderedTrackKey = '';
        return;
    }

    const currentTrackKey = `${current.file}|${current.title}|${current.artist}`;
    if (renderedTrackKey === currentTrackKey) {
        return;
    }

    renderedTrackKey = currentTrackKey;
    lyricsTitle.textContent = current.title;
    lyricsArtist.textContent = current.artist;
    updateLyricsForCurrentTrack();
}

function renderRecentHistory() {
    if (!recentHistoryList) {
        return;
    }

    recentHistoryList.innerHTML = '';

    if (recentSongs.length === 0) {
        const item = document.createElement('div');
        item.className = 'recent-history-item';
        item.innerHTML = `
            <div class="recent-history-number">-</div>
            <div class="recent-history-song">
                <div class="recent-history-track">История пока пустая</div>
                <div class="recent-history-artist">Треки появятся после переключения</div>
            </div>
        `;
        recentHistoryList.appendChild(item);
        return;
    }

    recentSongs.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = 'recent-history-item';
        item.innerHTML = `
            <div class="recent-history-number">${index + 1}.</div>
            <div class="recent-history-song">
                <div class="recent-history-track">${song.title}</div>
                <div class="recent-history-artist">${song.artist}</div>
            </div>
        `;
        recentHistoryList.appendChild(item);
    });
}

function loadTrack(index) {
    if (playlist.length === 0) {
        updateUIForCurrentTrack();
        return;
    }

    currentTrackIndex = (index + playlist.length) % playlist.length;
    const track = playlist[currentTrackIndex];

    radioStream.src = track.file;
    hasRecordedCurrentTrackPlay = false;
    renderedTrackKey = '';
    randomStartOffsetApplied = false;
    radioStream.load();
    updateUIForCurrentTrack();
}

function pushCurrentToHistory() {
    const current = playlist[currentTrackIndex];
    if (!current) {
        return;
    }

    recentSongs.unshift({ title: current.title, artist: current.artist, file: current.file });
    recentSongs = recentSongs.slice(0, 5);
    saveCurrentSessionRecentTracks();
    renderRecentHistory();

    const artistKey = normalizeArtist(current.artist);
    recentArtists = [artistKey, ...recentArtists.filter((a) => a !== artistKey)].slice(0, ARTIST_ANTI_REPEAT_DEPTH);
}

async function refreshPlaylist(keepCurrentTrack = true) {
    const currentFile = playlist[currentTrackIndex]?.file;
    const loaded = await loadPlaylistFromMusicFolder();

    if (!loaded) {
        // Keep the current in-memory playlist on transient refresh failures.
        if (playlist.length > 0) {
            updateUIForCurrentTrack();
            return false;
        }

        currentTrackIndex = 0;
        updateUIForCurrentTrack();
        return false;
    }

    if (keepCurrentTrack && currentFile) {
        const found = playlist.findIndex((t) => t.file === currentFile);
        currentTrackIndex = found >= 0 ? found : 0;
    } else {
        currentTrackIndex = 0;
    }

    pruneBrokenTrackFiles();

    updateUIForCurrentTrack();
    return true;
}

function play(options = {}) {
    const { fromUserAction = false } = options;

    if (fromUserAction) {
        sendMetrikaGoal(METRIKA_GOAL_PLAY);
    }

    if (playlist.length === 0) {
        lyricsContent.textContent = 'Плейлист пуст. Добавьте mp3/wav/ogg/m4a/aac в папку music.';
        return;
    }

    const current = playlist[currentTrackIndex];
    if (current && brokenTrackFiles.has(current.file)) {
        internalNextTrack(true, {
            pushToHistory: false,
            failedTrackMessage: true,
            fromUserAction
        });
        return;
    }

    playWhenReady({ fromUserAction });
}

function pause() {
    radioStream.pause();
}

function togglePlay() {
    if (isPlaying) {
        pause();
    } else {
        play({ fromUserAction: true });
    }
}

function onPlay() {
    isPlaying = true;
    scheduleListen60GoalIfNeeded();
    if (!hasRecordedCurrentTrackPlay) {
        recordCurrentTrackPlay();
        pushCurrentToHistory();
        if (antiRepeatRemaining > 0) {
            antiRepeatRemaining -= 1;
        }
        hasRecordedCurrentTrackPlay = true;
    }
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'flex';
    turntable.classList.remove('paused');
}

function onPause() {
    isPlaying = false;
    cancelListen60GoalTimer();
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    turntable.classList.add('paused');
}

const internalNextTrack = async (autoplay = true, options = {}) => {
    if (nextTrackInProgress) {
        return;
    }

    nextTrackInProgress = true;

    const {
        pushToHistory = false,
        failedTrackMessage = false,
        failureMessage = 'Поврежденный трек пропущен автоматически. Воспроизведение продолжается.',
        fromUserAction = false
    } = options;

    try {
        await refreshPlaylist(true);

        if (pushToHistory) {
            pushCurrentToHistory();
        }

        if (!hasPlayableTracks()) {
            pause();
            lyricsContent.textContent = 'Все найденные треки недоступны или повреждены. Добавьте рабочие аудиофайлы в папку music.';
            return;
        }

        const nextIndex = chooseRandomNextTrackIndex();
        if (nextIndex === null) {
            pause();
            lyricsContent.textContent = 'Лимит на повторы за 24 часа достигнут. Повторите позже, когда окно обновится.';
            return;
        }

        loadTrack(nextIndex);
        if (failedTrackMessage) {
            lyricsContent.textContent = failureMessage;
        }

        if (autoplay) {
            play({ fromUserAction });
        }
    } finally {
        nextTrackInProgress = false;
    }
};

async function onTrackEnded() {
    await internalNextTrack(true);
}

function onAudioError() {
    skipBrokenCurrentTrack('Ошибка загрузки трека. Он автоматически пропущен.');
}

async function initPlayer() {
    playBtn.addEventListener('click', () => play({ fromUserAction: true }));
    pauseBtn.addEventListener('click', pause);
    nextBtn?.addEventListener('click', () => {
        sendMetrikaGoal(METRIKA_GOAL_NEXT);
        internalNextTrack(true, { fromUserAction: true });
    });
    turntable.addEventListener('click', togglePlay);

    radioStream.addEventListener('play', onPlay);
    radioStream.addEventListener('pause', onPause);
    radioStream.addEventListener('ended', onTrackEnded);
    radioStream.addEventListener('error', onAudioError);
    radioStream.preload = 'auto';
    radioStream.setAttribute('playsinline', '');
    radioStream.setAttribute('webkit-playsinline', '');

    await refreshPlaylist(false);
    const randomStartIndex = chooseRandomStartTrackIndex();
    seedRecentHistoryWithRandomTracks(randomStartIndex);
    loadTrack(randomStartIndex ?? currentTrackIndex);
    renderRecentHistory();

    // Автоподхват новых файлов из music
    setInterval(async () => {
        if (isPlaying) {
            return;
        }

        try {
            await refreshPlaylist(true);
        } catch (error) {
            console.warn('Не удалось обновить плейлист в фоне:', error);
        }
    }, PLAYLIST_REFRESH_INTERVAL_MS);

    window.addEventListener('beforeunload', saveCurrentSessionRecentTracks);
}

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
    }

    if (e.code === 'ArrowRight') {
        e.preventDefault();
        sendMetrikaGoal(METRIKA_GOAL_NEXT);
        internalNextTrack(true, { fromUserAction: true });
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    initRealListenersCounter();

    resolveImageWithFallbacks('.label-photo', {
        containerSelector: '.label-inner',
        fallbackClass: 'photo-fallback',
        candidates: [
            'assets/ebash.jpg',
            'assets/ebash.jpeg',
            'assets/ebash.png',
            'assets/ebash.JPG',
            'assets/ebash.JPEG',
            'assets/ebash.PNG'
        ]
    });

    resolveImageWithFallbacks('.station-brand-badge img', {
        containerSelector: '.station-brand-badge',
        fallbackClass: 'fallback',
        candidates: [
            'ebash-logo.png',
            'ebash-logo.jpg',
            'ebash-logo.jpeg',
            'ebash-logo.PNG',
            'ebash-logo.JPG',
            'ebash-logo.JPEG',
            'assets/ebash-logo.png',
            'assets/ebash-logo.jpg',
            'assets/ebash-logo.jpeg',
            'assets/ebash-logo.PNG',
            'assets/ebash-logo.JPG',
            'assets/ebash-logo.JPEG'
        ]
    });

    initSimulatedListenersNow();
    await initPlayer();

    if (window.location.protocol === 'file:') {
        console.warn('Для стабильного воспроизведения локальных mp3 и сетевых запросов лучше открыть страницу через http://127.0.0.1:8080/index.html.');
    }

    window.reloadPlaylist = async () => {
        const wasPlaying = !radioStream.paused;
        await refreshPlaylist(true);
        loadTrack(currentTrackIndex);
        if (wasPlaying) {
            play({ fromUserAction: false });
        }
    };

    window.nextTrack = () => internalNextTrack(true);
    window.clearBrokenTracks = () => {
        brokenTrackFiles.clear();
        saveBrokenTrackFiles();
        console.info('Список поврежденных треков очищен.');
    };
});
