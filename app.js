const API_URL = 'https://script.google.com/macros/s/AKfycbxKnu-V51U3FRIwnYyveHGbhAnWSmu38VlL8_pRq5stMPkTTb1-GBtaynhjz9kGPg8PqQ/exec';
const APP_CACHE_KEY = 'piscinaAppCacheV2';
const NOTIFICATION_PREF_KEY = 'piscinaNotificationsEnabled';
const PUSH_PUBLIC_KEY = '';
const API_TIMEOUT_MS = 18000;
const DEFAULT_APP_NAME = 'PISCINA DE PELOTAS';
const DEFAULT_SERVICES = [
    { id: 'svc_15', name: '15 Minutos', durationMinutes: 15, price: 5000, active: true },
    { id: 'svc_30', name: '30 Minutos', durationMinutes: 30, price: 8000, active: true },
    { id: 'svc_60', name: '1 Hora', durationMinutes: 60, price: 15000, active: true }
];
const cachedApp = JSON.parse(localStorage.getItem(APP_CACHE_KEY) || '{}');
let runtimePushPublicKey = PUSH_PUBLIC_KEY;
const USE_LOCAL_RECORD_CACHE = !API_URL.trim();

// State Management
let appState = {
    records: USE_LOCAL_RECORD_CACHE ? (cachedApp.records || JSON.parse(localStorage.getItem('piscinaRecords')) || []) : [],
    users: cachedApp.users || [],
    services: cachedApp.services || DEFAULT_SERVICES,
    settings: cachedApp.settings || { appName: DEFAULT_APP_NAME },
    cacheUpdatedAt: Number(cachedApp.updatedAt || 0),
    token: localStorage.getItem('piscinaToken') || '',
    currentUser: USE_LOCAL_RECORD_CACHE ? (cachedApp.currentUser || null) : null,
    needsSetup: false,
    activeSearchTerm: '',
    activePage: 1,
    activePageSize: 4,
    theme: localStorage.getItem('piscinaTheme') || 'light',
    alertedIds: new Set(),
    selectionMode: false,
    selectedExpiredIds: new Set(),
    finishQueue: JSON.parse(localStorage.getItem('piscinaFinishQueue') || '[]'),
    syncingFinishes: false,
    syncRetryTimer: null,
    notificationsEnabled: localStorage.getItem(NOTIFICATION_PREF_KEY) === 'true',
    wakeLock: null,
    recoveredPasswords: {}
};

function saveState() {
    localStorage.setItem('piscinaRecords', JSON.stringify(appState.records));
    saveAppCache();
}

function saveAppCache() {
    localStorage.setItem(APP_CACHE_KEY, JSON.stringify({
        records: appState.records,
        users: appState.users,
        services: appState.services,
        settings: appState.settings,
        currentUser: appState.currentUser,
        updatedAt: Date.now()
    }));
}

function isRemoteMode() {
    return API_URL.trim().length > 0;
}

function setLoading(isLoading) {
    const loader = document.getElementById('global-loader');
    if (loader) loader.style.display = isLoading ? 'grid' : 'none';
}

async function apiRequest(action, data = {}) {
    if (!isRemoteMode()) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, token: appState.token, ...data }),
            signal: controller.signal
        });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'Error en el API');
        return result;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('El servidor tardo demasiado. Intenta de nuevo cuando la conexion este estable.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
        return await navigator.serviceWorker.register('sw.js');
    } catch (error) {
        return null;
    }
}

function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

async function subscribeToPushNotifications() {
    const publicKey = await getRuntimePushPublicKey();
    if (!publicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;
    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
}

async function getRuntimePushPublicKey() {
    if (runtimePushPublicKey) return runtimePushPublicKey;
    if (!isRemoteMode() || !appState.token) return '';
    try {
        const config = await apiRequest('getPushConfig');
        runtimePushPublicKey = config.publicKey || '';
    } catch (error) {
        runtimePushPublicKey = '';
    }
    return runtimePushPublicKey;
}

function syncExpiredPushAlerts(recordIds) {
    if (!recordIds.length || !isRemoteMode() || !appState.token) return;
    apiRequest('sendExpiredPushAlerts', { recordIds }).catch(() => null);
}

function applyRemoteState(result) {
    if (result.needsSetup !== undefined) {
        appState.needsSetup = !!result.needsSetup;
        renderLoginMode();
    }
    if (result.records) {
        appState.records = result.records;
        const pendingFinishIds = new Set(appState.finishQueue.map(item => item.id));
        appState.records.forEach(record => {
            if (pendingFinishIds.has(record.id)) record.isActive = false;
        });
        saveState();
    }
    if (result.services) {
        appState.services = normalizeServices(result.services);
        renderServiceOptions();
        renderServices();
    }
    if (result.settings) {
        appState.settings = { ...appState.settings, ...result.settings };
        applyBranding();
    }
    if (result.users) {
        appState.users = result.users;
        renderUsers();
    }
    if (result.user) appState.currentUser = result.user;
    applyRoleVisibility();
    renderSessionUser();
    saveAppCache();
}

// DOM Elements
const views = document.querySelectorAll('.view');
const navBtns = document.querySelectorAll('.nav-btn');
const addKidBtn = document.getElementById('add-kid-btn');
const regFormContainer = document.getElementById('reg-form-container');
const addKidForm = document.getElementById('add-kid-form');
const cancelAddBtn = document.getElementById('cancel-add');
const activeKidsGrid = document.getElementById('active-kids-grid');
const activeCount = document.getElementById('active-count');
const activeSearchInput = document.getElementById('active-search-input');
const activePagination = document.getElementById('active-pagination');
const activePageSummary = document.getElementById('active-page-summary');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const adminThemeToggleBtn = document.getElementById('admin-theme-toggle-btn');
const notificationToggleBtn = document.getElementById('notification-toggle-btn');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginTitle = document.getElementById('login-title');
const loginSubtitle = document.getElementById('login-subtitle');
const loginSubmit = document.getElementById('login-submit');
const logoutBtn = document.getElementById('logout-btn');
const userForm = document.getElementById('user-form');
const usersList = document.getElementById('users-list');
const usersToggle = document.getElementById('users-toggle');
const usersPanel = document.getElementById('users-panel');
const alarmAudio = new Audio('sound/alarm.mp3');
alarmAudio.preload = 'auto';

// Admin Elements
const totalIncomeEl = document.getElementById('total-income');
const totalKidsServedEl = document.getElementById('total-kids-served');
const historyListEl = document.getElementById('history-list');
const filterBtns = document.querySelectorAll('.filter-btn');
const searchInput = document.getElementById('search-input');
const exportHistoryPdfBtn = document.getElementById('export-history-pdf');
const exportHistoryExcelBtn = document.getElementById('export-history-excel');
const selectExpiredBtn = document.getElementById('select-expired-btn');
const batchActionBar = document.getElementById('batch-action-bar');
const selectedExpiredCount = document.getElementById('selected-expired-count');
const cancelSelectionBtn = document.getElementById('cancel-selection-btn');
const finishSelectedBtn = document.getElementById('finish-selected-btn');
const syncStatus = document.getElementById('sync-status');
const timeSelect = document.getElementById('time-select');
const systemToggle = document.getElementById('system-toggle');
const systemPanel = document.getElementById('system-panel');
const settingsForm = document.getElementById('settings-form');
const appNameInput = document.getElementById('app-name-input');
const settingsSubmitBtn = document.getElementById('settings-submit-btn');
const settingsSaveFeedback = document.getElementById('settings-save-feedback');
const serviceForm = document.getElementById('service-form');
const serviceIdInput = document.getElementById('service-id');
const serviceNameInput = document.getElementById('service-name');
const serviceDurationInput = document.getElementById('service-duration');
const servicePriceInput = document.getElementById('service-price');
const cancelServiceEditBtn = document.getElementById('cancel-service-edit');
const servicesList = document.getElementById('services-list');
const systemModal = document.getElementById('system-modal');
const systemModalTitle = document.getElementById('system-modal-title');
const systemModalMessage = document.getElementById('system-modal-message');
const systemModalActions = document.getElementById('system-modal-actions');
const passwordModal = document.getElementById('password-modal');
const passwordModalClose = document.getElementById('password-modal-close');
const passwordChangeForm = document.getElementById('password-change-form');

// Edit Modal Elements
const editModal = document.getElementById('edit-modal');
const editKidForm = document.getElementById('edit-kid-form');
const cancelEditBtn = document.getElementById('cancel-edit');

// Initialize
async function init() {
    repairStaticTextEncoding();
    registerServiceWorker();
    applyTheme();
    applyBranding();
    renderServiceOptions();
    renderServices();
    renderUsers();
    setupThemeToggle();
    setupNotifications();
    unlockAlarmOnFirstGesture();
    setupAuth();
    setupPasswordChangeModal();
    setupNavigation();
    setupForms();
    setupActiveSearch();
    setupAdminFilters();
    setupUserAdmin();
    setupSystemAdmin();
    setupBatchSelection();
    setupAssistant();
    startGlobalTimer();
    await bootstrapApp();
    renderActiveKids();
    updateAdminDashboard('today');
    processFinishQueue();
}

// Format Currency
const formatCurrency = (amount) => {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        minimumFractionDigits: 0
    }).format(amount);
};

function parseCurrencyValue(value) {
    return Number(String(value || '').replace(/[^\d]/g, '')) || 0;
}

function formatCurrencyInput(input) {
    const value = parseCurrencyValue(input.value);
    input.value = value ? formatCurrency(value) : '';
}

function animateButtonSuccess(button, label = 'Guardado') {
    if (!button) return;
    const previous = button.innerHTML;
    button.classList.remove('btn-success-pop');
    button.offsetWidth;
    button.classList.add('btn-success-pop');
    button.innerHTML = `<i class="ph ph-check-circle"></i> ${label}`;
    setTimeout(() => {
        button.innerHTML = previous;
        button.classList.remove('btn-success-pop');
    }, 1050);
}

function setAppNameEditing(isEditing) {
    if (!appNameInput || !settingsSubmitBtn) return;
    appNameInput.disabled = !isEditing;
    settingsSubmitBtn.textContent = isEditing ? 'Guardar' : 'Actualizar nombre';
    settingsForm?.classList.toggle('is-editing', isEditing);
    if (isEditing) setTimeout(() => appNameInput.focus(), 80);
}

function showSettingsSavedFeedback() {
    if (!settingsSaveFeedback) return;
    settingsSaveFeedback.classList.remove('show');
    settingsSaveFeedback.offsetWidth;
    settingsSaveFeedback.classList.add('show');
    setTimeout(() => settingsSaveFeedback.classList.remove('show'), 1300);
}

function getAppName() {
    return String(appState.settings?.appName || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME;
}

function applyBranding() {
    const appName = getAppName();
    document.title = appName;
    document.querySelectorAll('[data-app-name]').forEach(element => {
        element.textContent = appName.toUpperCase();
    });
    if (appNameInput) appNameInput.value = appName;
}

function normalizeServices(services) {
    const source = Array.isArray(services) && services.length ? services : DEFAULT_SERVICES;
    return source.map(service => ({
        id: String(service.id || `svc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
        name: String(service.name || `${Number(service.durationMinutes || 0)} Minutos`).trim(),
        durationMinutes: Number(service.durationMinutes || 0),
        price: Number(service.price || 0),
        active: service.active === undefined || service.active === true || service.active === 'TRUE' || service.active === 'true',
        createdAt: Number(service.createdAt || 0),
        updatedAt: Number(service.updatedAt || 0)
    })).filter(service => service.durationMinutes > 0);
}

function renderServiceOptions() {
    if (!timeSelect) return;
    const activeServices = normalizeServices(appState.services).filter(service => service.active);
    const services = activeServices.length ? activeServices : DEFAULT_SERVICES;
    timeSelect.innerHTML = services.map((service, index) => `
        <option value="${escapeHTML(service.id)}" ${index === 0 ? 'selected' : ''}>
            ${escapeHTML(service.name)} - ${Number(service.durationMinutes)} min - ${formatCurrency(service.price)}
        </option>
    `).join('');
}

function getSelectedService() {
    const selectedId = timeSelect?.value;
    return normalizeServices(appState.services).find(service => service.id === selectedId && service.active) ||
        normalizeServices(appState.services).find(service => service.active) ||
        DEFAULT_SERVICES[0];
}

function renderServices() {
    if (!servicesList) return;
    const services = normalizeServices(appState.services).sort((a, b) => a.durationMinutes - b.durationMinutes);
    if (!services.length) {
        servicesList.innerHTML = '<div class="empty-state"><p>No hay tarifas configuradas.</p></div>';
        return;
    }
    servicesList.innerHTML = services.map(service => `
        <div class="service-item ${service.active ? '' : 'inactive'}">
            <div>
                <strong>${escapeHTML(service.name)}</strong>
                <span>${Number(service.durationMinutes)} min • ${formatCurrency(service.price)} • ${service.active ? 'Activa' : 'Oculta'}</span>
            </div>
            <div class="service-actions">
                <button type="button" onclick="editService('${service.id}')" aria-label="Editar tarifa"><i class="ph ph-pencil-simple"></i></button>
                <button type="button" onclick="toggleService('${service.id}', ${!service.active})" aria-label="${service.active ? 'Ocultar' : 'Activar'} tarifa">
                    <i class="ph ${service.active ? 'ph-eye-slash' : 'ph-eye'}"></i>
                </button>
                <button type="button" onclick="deleteService('${service.id}')" aria-label="Eliminar tarifa"><i class="ph ph-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function applyTheme() {
    document.body.classList.toggle('theme-dark', appState.theme === 'dark');
    const icon = appState.theme === 'dark' ? '<i class="ph ph-sun"></i>' : '<i class="ph ph-moon"></i>';
    if (themeToggleBtn) themeToggleBtn.innerHTML = icon;
    if (adminThemeToggleBtn) adminThemeToggleBtn.innerHTML = icon;
}

function setupThemeToggle() {
    const toggleTheme = () => {
        appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('piscinaTheme', appState.theme);
        applyTheme();
    };
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
    if (adminThemeToggleBtn) adminThemeToggleBtn.addEventListener('click', toggleTheme);
}

function getNotificationPermission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
}

function updateNotificationButton() {
    if (!notificationToggleBtn) return;
    const permission = getNotificationPermission();
    const isReady = appState.notificationsEnabled && permission === 'granted';
    notificationToggleBtn.classList.toggle('is-enabled', isReady);
    notificationToggleBtn.classList.toggle('is-blocked', permission === 'denied');
    notificationToggleBtn.innerHTML = permission === 'denied'
        ? '<i class="ph ph-bell-slash"></i><span>Bloqueadas</span>'
        : `<i class="ph ${isReady ? 'ph-bell-ringing' : 'ph-bell'}"></i><span>${isReady ? 'Alertas listas' : 'Alertas'}</span>`;
}

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        if (appState.wakeLock) return;
        appState.wakeLock = await navigator.wakeLock.request('screen');
        appState.wakeLock.addEventListener('release', () => {
            appState.wakeLock = null;
        });
    } catch (error) {}
}

async function requestNotificationAccess() {
    unlockAlarmNow();
    if (!('Notification' in window)) {
        showAlert('Este navegador no soporta notificaciones web.', 'No disponible', 'warning');
        return;
    }
    if (Notification.permission === 'denied') {
        showAlert('Las notificaciones estan bloqueadas. Activalas desde la configuracion del navegador para este sitio.', 'Bloqueadas', 'warning');
        updateNotificationButton();
        return;
    }
    const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
    appState.notificationsEnabled = permission === 'granted';
    localStorage.setItem(NOTIFICATION_PREF_KEY, String(appState.notificationsEnabled));
    updateNotificationButton();
    if (permission === 'granted') {
        requestWakeLock();
        subscribeToPushNotifications()
            .then(subscription => {
                if (subscription && isRemoteMode() && appState.token) {
                    apiRequest('savePushSubscription', { subscription: subscription.toJSON() }).catch(() => null);
                }
            })
            .catch(() => null);
        sendBrowserNotification('Alertas activadas', 'La app avisara cuando un tiempo termine.');
        playAlarm(1);
    }
}

function setupNotifications() {
    updateNotificationButton();
    if (notificationToggleBtn) notificationToggleBtn.addEventListener('click', requestNotificationAccess);
    if (appState.notificationsEnabled) requestWakeLock();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && appState.notificationsEnabled) requestWakeLock();
    });
}

function sendBrowserNotification(title, body) {
    if (!appState.notificationsEnabled || getNotificationPermission() !== 'granted') return;
    try {
        const notification = new Notification(title, {
            body,
            icon: 'images/logo.png',
            badge: 'images/logo.png',
            requireInteraction: true,
            silent: false
        });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch (err) {}
}

function notifyExpiredRecords(ids) {
    const records = ids.map(id => appState.records.find(record => record.id === id)).filter(Boolean);
    if (!records.length) return;
    const names = records.map(record => record.kidName).join(', ');
    const title = records.length === 1 ? 'Tiempo terminado' : `${records.length} tiempos terminados`;
    sendBrowserNotification(title, `${names} ${records.length === 1 ? 'ya finalizo su tiempo.' : 'ya finalizaron su tiempo.'}`);
}

function unlockAlarmNow() {
    alarmAudio.volume = 0.85;
    alarmAudio.play().then(() => {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
    }).catch(() => {});
}

function unlockAlarmOnFirstGesture() {
    const unlock = () => {
        unlockAlarmNow();
        document.removeEventListener('pointerdown', unlock);
        document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
}

function playAlarm(times = 1) {
    let played = 0;
    const playOnce = () => {
        alarmAudio.currentTime = 0;
        alarmAudio.play().catch(() => {});
        played += 1;
        if (played < times) setTimeout(playOnce, 900);
    };
    playOnce();
}

function setAuthenticated(isAuthenticated) {
    document.body.classList.toggle('is-authenticated', isAuthenticated);
    applyRoleVisibility();
    renderSessionUser();
}

function isAdmin() {
    return appState.currentUser?.role === 'admin';
}

function applyRoleVisibility() {
    document.body.classList.toggle('is-admin', isAdmin());
}

function getSessionLabel() {
    const email = repairText(appState.currentUser?.email || '');
    if (!email) return '';
    return email.split('@')[0] || email;
}

function renderSessionUser() {
    const label = getSessionLabel();
    document.querySelectorAll('[data-session-user]').forEach(element => {
        element.textContent = label ? `Sesión: ${label}` : '';
        element.hidden = !label;
        element.setAttribute('role', 'button');
        element.setAttribute('tabindex', label ? '0' : '-1');
        element.title = label ? 'Cambiar clave' : '';
    });
}

function showSystemModal({ title = 'Aviso', message = '', type = 'info', confirmText = 'OK', cancelText = '', danger = false } = {}) {
    if (!systemModal || !systemModalTitle || !systemModalMessage || !systemModalActions) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const close = (value) => {
            systemModal.style.display = 'none';
            systemModal.classList.remove('is-danger', 'is-warning', 'is-success');
            systemModalActions.innerHTML = '';
            resolve(value);
        };
        systemModal.classList.toggle('is-danger', danger || type === 'danger');
        systemModal.classList.toggle('is-warning', type === 'warning');
        systemModal.classList.toggle('is-success', type === 'success');
        const modalIcon = systemModal.querySelector('.system-modal-icon i');
        if (modalIcon) {
            modalIcon.className = `ph ${type === 'success' ? 'ph-check-circle' : danger || type === 'danger' ? 'ph-warning-circle' : type === 'warning' ? 'ph-warning' : 'ph-shield-check'}`;
        }
        systemModalTitle.textContent = title;
        systemModalMessage.textContent = message;
        systemModalActions.innerHTML = '';
        if (cancelText) {
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = cancelText;
            cancelBtn.addEventListener('click', () => close(false), { once: true });
            systemModalActions.appendChild(cancelBtn);
        }
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
        confirmBtn.textContent = confirmText;
        confirmBtn.addEventListener('click', () => close(true), { once: true });
        systemModalActions.appendChild(confirmBtn);
        systemModal.style.display = 'flex';
        setTimeout(() => confirmBtn.focus(), 40);
    });
}

const showAlert = (message, title = 'Aviso', type = 'info') => showSystemModal({ title, message, type, confirmText: 'OK' });
const confirmAction = (message, title = 'Confirmar', confirmText = 'OK', danger = false) => {
    return showSystemModal({ title, message, confirmText, cancelText: 'Cancelar', danger, type: danger ? 'danger' : 'warning' });
};

function guardAdminAction() {
    if (isAdmin()) return true;
    showAlert('Solo administradores pueden realizar esta accion.', 'Solo administradores', 'warning');
    return false;
}

function renderLoginMode() {
    if (!loginTitle || !loginSubmit) return;
    if (appState.needsSetup) {
        loginTitle.textContent = 'Crear usuario jefe';
        loginSubtitle.textContent = 'Este será el administrador principal para crear usuarios y dar accesos.';
        loginSubmit.textContent = 'Crear jefe y entrar';
        document.getElementById('login-email').placeholder = 'correo del jefe';
        document.getElementById('login-password').placeholder = 'crear contraseña';
    } else {
        loginTitle.textContent = getAppName().toUpperCase();
        loginSubtitle.textContent = 'Ingresa para gestionar tiempos, registros e ingresos.';
        loginSubmit.textContent = 'Entrar';
        document.getElementById('login-email').placeholder = 'correo@empresa.com';
        document.getElementById('login-password').placeholder = 'Tu contraseña';
    }
}

function queueBackgroundBootstrap(delay = 120) {
    setTimeout(() => {
        apiRequest('bootstrap').then(remote => {
            applyRemoteState(remote);
            renderActiveKids();
            updateAdminDashboard(getCurrentHistoryFilterType());
            processFinishQueue();
        }).catch(() => updateSyncStatus());
    }, delay);
}

async function bootstrapApp() {
    if (!isRemoteMode()) {
        appState.currentUser = { email: 'local', role: 'admin', active: true };
        setAuthenticated(true);
        applyRemoteState({ services: appState.services, settings: appState.settings });
        return;
    }

    if (!appState.token) {
        setAuthenticated(false);
        renderLoginMode();
        try {
            const result = await apiRequest('health');
            applyRemoteState(result);
        } catch (err) {
            loginError.textContent = err.message;
        }
        return;
    }

    if (appState.records.length || appState.currentUser) {
        setAuthenticated(true);
        renderActiveKids();
        updateAdminDashboard(getCurrentHistoryFilterType());
        processFinishQueue();
    } else {
        setLoading(true);
    }
    try {
        const result = await apiRequest('bootstrap');
        applyRemoteState(result);
        setAuthenticated(true);
    } catch (err) {
        localStorage.removeItem('piscinaToken');
        appState.token = '';
        appState.currentUser = null;
        appState.records = [];
        setAuthenticated(false);
        renderLoginMode();
        if (loginError) loginError.textContent = err.message;
        updateSyncStatus();
    } finally {
        setLoading(false);
    }
}

function setupAuth() {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        loginSubmit.disabled = true;
        loginSubmit.textContent = appState.needsSetup ? 'Creando...' : 'Entrando...';
        try {
            const result = await apiRequest('login', {
                email: document.getElementById('login-email').value,
                password: document.getElementById('login-password').value,
                fast: true
            });
            appState.token = result.token;
            localStorage.setItem('piscinaToken', result.token);
            applyRemoteState(result);
            setAuthenticated(true);
            renderActiveKids();
            updateAdminDashboard('today');
            queueBackgroundBootstrap();
        } catch (err) {
            loginError.textContent = err.message;
        } finally {
            loginSubmit.disabled = false;
            renderLoginMode();
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('piscinaToken');
        appState.token = '';
        appState.currentUser = null;
        setAuthenticated(false);
    });
}

function renderUsers() {
    if (!usersList) return;
    if (!appState.users.length) {
        usersList.innerHTML = '<div class="empty-state"><p>No hay usuarios creados.</p></div>';
        return;
    }

    usersList.innerHTML = '';
    const sortedUsers = [...appState.users].sort((a, b) => {
        const activityDiff = (Number(b.activityCount || 0) - Number(a.activityCount || 0));
        if (activityDiff !== 0) return activityDiff;
        return Number(b.lastActivityAt || b.lastLoginAt || 0) - Number(a.lastActivityAt || a.lastLoginAt || 0);
    });

    sortedUsers.forEach(user => {
        const activityCount = Number(user.activityCount || 0);
        const isLowActivity = user.role !== 'admin' && activityCount <= 1;
        const isPendingUser = String(user.id || '').startsWith('pending_');
        const canDeleteUser = appState.currentUser?.role === 'admin' && user.role !== 'admin' && user.id !== appState.currentUser?.id && !isPendingUser;
        const canRecoverPassword = appState.currentUser?.role === 'admin' && user.role !== 'admin' && !isPendingUser;
        const recovered = appState.recoveredPasswords[user.id];
        const passwordText = recovered?.revealed ? recovered.password : '********';
        const passwordIcon = recovered?.revealed ? 'ph-eye-slash' : 'ph-eye';
        const passwordTitle = recovered ? (recovered.revealed ? 'Ocultar clave' : 'Revelar clave') : 'Generar clave temporal';
        const copyButton = recovered?.revealed ? `
            <button class="password-copy-btn" onclick="copyRecoveredPassword('${user.id}')" aria-label="Copiar clave" title="Copiar clave">
                <i class="ph ph-clipboard-text"></i>
            </button>
        ` : '';
        const passwordRecovery = canRecoverPassword ? `
            <div class="password-recovery">
                <span>${escapeHTML(passwordText)}</span>
                <button class="password-eye-btn" onclick="recoverUserPassword('${user.id}')" aria-label="${passwordTitle}" title="${passwordTitle}">
                    <i class="ph ${passwordIcon}"></i>
                </button>
                ${copyButton}
            </div>
        ` : '';
        const deleteButton = canDeleteUser ? `
            <button class="user-delete-btn" onclick="deleteUser('${user.id}')" aria-label="Eliminar usuario" title="Eliminar usuario">
                <i class="ph ph-trash"></i>
            </button>
        ` : '';
        const item = document.createElement('div');
        item.className = `user-item ${isLowActivity ? 'low-activity' : ''}`;
        item.innerHTML = `
            <div>
                <strong>${escapeHTML(user.email)}</strong>
                <span>${escapeHTML(user.role)} &bull; ${user.active ? 'Activo' : 'Sin acceso'} &bull; ${activityCount} acciones</span>
                ${isLowActivity ? '<em class="sad-badge">Poca actividad</em>' : ''}
                ${passwordRecovery}
            </div>
            <div class="user-actions">
                <button class="btn ${user.active ? 'btn-secondary' : 'btn-primary'}" onclick="toggleUserAccess('${user.id}', ${!user.active})">
                    ${user.active ? 'Quitar acceso' : 'Activar'}
                </button>
                ${deleteButton}
            </div>
        `;
        usersList.appendChild(item);
    });
}
function setAdminAccordion(section, forceOpen = false) {
    const openSystem = section === 'system' ? (forceOpen || !systemPanel.classList.contains('open')) : false;
    const openUsers = section === 'users' ? (forceOpen || !usersPanel.classList.contains('open')) : false;
    systemPanel.classList.toggle('open', openSystem);
    systemToggle.classList.toggle('open', openSystem);
    usersPanel.classList.toggle('open', openUsers);
    usersToggle.classList.toggle('open', openUsers);
}

function openPasswordModal() {
    if (!passwordModal || !passwordChangeForm) return;
    passwordChangeForm.reset();
    passwordModal.style.display = 'flex';
    setTimeout(() => document.getElementById('password-current')?.focus(), 60);
}

function closePasswordModal() {
    if (!passwordModal || !passwordChangeForm) return;
    passwordModal.style.display = 'none';
    passwordChangeForm.reset();
}

function generateMemorablePassword() {
    const digits = [];
    while (digits.length < 3) {
        const digit = Math.floor(Math.random() * 10);
        if (!digits.includes(digit)) digits.push(digit);
    }
    return `Sansil${digits.join('')}`;
}

function setupPasswordChangeModal() {
    document.querySelectorAll('[data-session-user]').forEach(element => {
        element.addEventListener('click', openPasswordModal);
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPasswordModal();
            }
        });
    });
    passwordModalClose?.addEventListener('click', closePasswordModal);
    passwordModal?.addEventListener('click', (event) => {
        if (event.target === passwordModal) closePasswordModal();
    });
    passwordChangeForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!isRemoteMode()) {
            showAlert('Configura API_URL para cambiar contraseñas.', 'Modo local', 'warning');
            return;
        }
        const currentPassword = document.getElementById('password-current').value;
        const newPassword = document.getElementById('password-new').value;
        if (!currentPassword || !newPassword) return;
        if (newPassword.length < 4) {
            showAlert('La clave nueva debe tener mínimo 4 caracteres.', 'Clave corta', 'warning');
            return;
        }
        const submitButton = passwordChangeForm.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        closePasswordModal();
        showAlert('Clave actualizada correctamente.', 'Clave guardada', 'success');
        try {
            await apiRequest('changeOwnPassword', { currentPassword, newPassword });
        } catch (err) {
            showAlert(err.message, 'No se pudo cambiar', 'danger');
        } finally {
            submitButton.disabled = false;
        }
    });
}

function setupUserAdmin() {
    usersToggle.addEventListener('click', () => {
        setAdminAccordion('users');
    });

    userForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!guardAdminAction()) return;
        if (!isRemoteMode()) {
            showAlert('Configura API_URL para crear usuarios en Google Sheets.', 'Modo local', 'warning');
            return;
        }
        const email = document.getElementById('user-email').value.trim().toLowerCase();
        const password = document.getElementById('user-password').value;
        if (!email || !password) return;
        if (appState.users.some(user => String(user.email).toLowerCase() === email)) {
            showAlert('Ese usuario ya existe.', 'Usuario existente', 'warning');
            return;
        }
        const optimisticUser = {
            id: `pending_${Date.now()}`,
            email,
            role: 'user',
            active: true,
            createdAt: Date.now(),
            lastLoginAt: 0,
            activityCount: 0,
            lastActivityAt: 0
        };
        appState.users.push(optimisticUser);
        renderUsers();
        saveAppCache();
        userForm.reset();
        showAlert('Usuario creado.', 'Usuario creado', 'success');
        try {
            const result = await apiRequest('createUser', {
                user: {
                    email,
                    password
                }
            });
            appState.users = appState.users.map(user => user.id === optimisticUser.id ? result.user : user);
            renderUsers();
            saveAppCache();
        } catch (err) {
            appState.users = appState.users.filter(user => user.id !== optimisticUser.id);
            renderUsers();
            saveAppCache();
            showAlert(err.message, 'No se pudo crear', 'danger');
        }
    });
}

function setupSystemAdmin() {
    setAppNameEditing(false);
    if (servicePriceInput) {
        servicePriceInput.addEventListener('input', () => formatCurrencyInput(servicePriceInput));
        servicePriceInput.addEventListener('blur', () => formatCurrencyInput(servicePriceInput));
    }

    if (systemToggle && systemPanel) {
        systemToggle.addEventListener('click', () => {
            setAdminAccordion('system');
        });
    }

    if (settingsForm) {
        settingsForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!guardAdminAction()) return;
            if (appNameInput.disabled) {
                setAppNameEditing(true);
                return;
            }
            const appName = appNameInput.value.trim();
            if (!appName) return;
            const previous = { ...appState.settings };
            appState.settings = { ...appState.settings, appName };
            applyBranding();
            saveAppCache();
            setAppNameEditing(false);
            showSettingsSavedFeedback();
            try {
                if (isRemoteMode()) {
                    const result = await apiRequest('saveSettings', { settings: appState.settings });
                    applyRemoteState(result);
                }
            } catch (err) {
                appState.settings = previous;
                applyBranding();
                setAppNameEditing(false);
                showAlert(err.message, 'No se pudo guardar', 'danger');
            }
        });
    }

    if (serviceForm) {
        serviceForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!guardAdminAction()) return;
            const existing = appState.services.find(item => item.id === serviceIdInput.value);
            const service = {
                id: serviceIdInput.value || `svc_${Date.now()}`,
                name: serviceNameInput.value.trim(),
                durationMinutes: Number(serviceDurationInput.value),
                price: parseCurrencyValue(servicePriceInput.value),
                active: existing ? existing.active : true
            };
            if (!service.name || service.durationMinutes <= 0 || service.price < 0) return;
            await saveService(service);
            animateButtonSuccess(serviceForm.querySelector('button[type="submit"]'), 'Guardada');
            resetServiceForm();
        });
    }

    if (cancelServiceEditBtn) cancelServiceEditBtn.addEventListener('click', resetServiceForm);
}

function resetServiceForm() {
    if (!serviceForm) return;
    serviceForm.reset();
    serviceIdInput.value = '';
}

async function saveService(service) {
    if (!guardAdminAction()) return;
    const previous = [...appState.services];
    const index = appState.services.findIndex(item => item.id === service.id);
    if (index >= 0) appState.services[index] = { ...appState.services[index], ...service, updatedAt: Date.now() };
    else appState.services.push({ ...service, createdAt: Date.now(), updatedAt: Date.now() });
    renderServiceOptions();
    renderServices();
    saveAppCache();
    try {
        if (isRemoteMode()) {
            const result = await apiRequest('saveService', { service });
            applyRemoteState(result);
        }
    } catch (err) {
        appState.services = previous;
        renderServiceOptions();
        renderServices();
        showAlert(err.message, 'No se pudo guardar', 'danger');
    }
}

window.editService = function(id) {
    if (!guardAdminAction()) return;
    const service = appState.services.find(item => item.id === id);
    if (!service) return;
    serviceIdInput.value = service.id;
    serviceNameInput.value = service.name;
    serviceDurationInput.value = service.durationMinutes;
    servicePriceInput.value = formatCurrency(service.price);
    serviceNameInput.focus();
};

window.toggleService = async function(id, active) {
    if (!guardAdminAction()) return;
    const service = appState.services.find(item => item.id === id);
    if (!service) return;
    await saveService({ ...service, active });
};

window.deleteService = async function(id) {
    if (!guardAdminAction()) return;
    if (!await confirmAction('Seguro que deseas eliminar esta tarifa?', 'Eliminar tarifa', 'Eliminar', true)) return;
    const previous = [...appState.services];
    appState.services = appState.services.filter(item => item.id !== id);
    renderServiceOptions();
    renderServices();
    saveAppCache();
    try {
        if (isRemoteMode()) {
            const result = await apiRequest('deleteService', { id });
            applyRemoteState(result);
        }
    } catch (err) {
        appState.services = previous;
        renderServiceOptions();
        renderServices();
        showAlert(err.message, 'No se pudo eliminar', 'danger');
    }
};

window.toggleUserAccess = async function(id, active) {
    if (!guardAdminAction()) return;
    if (!isRemoteMode()) {
        showAlert('Configura API_URL para administrar usuarios.', 'Modo local', 'warning');
        return;
    }
    const previous = [...appState.users.map(user => ({ ...user }))];
    appState.users = appState.users.map(user => user.id === id ? { ...user, active } : user);
    renderUsers();
    saveAppCache();
    try {
        const result = await apiRequest('setUserAccess', { id, active });
        appState.users = appState.users.map(user => user.id === id ? result.user : user);
        renderUsers();
        saveAppCache();
    } catch (err) {
        appState.users = previous;
        renderUsers();
        saveAppCache();
        showAlert(err.message, 'No se pudo actualizar', 'danger');
    }
};

window.deleteUser = async function(id) {
    if (!guardAdminAction()) return;
    if (!isRemoteMode()) {
        showAlert('Configura API_URL para administrar usuarios.', 'Modo local', 'warning');
        return;
    }
    const target = appState.users.find(user => user.id === id);
    if (!target) return;
    if (target.role === 'admin' || target.id === appState.currentUser?.id) {
        showAlert('Este usuario no se puede eliminar.', 'Acción protegida', 'warning');
        return;
    }
    if (!await confirmAction(`Seguro que deseas eliminar a ${target.email}?`, 'Eliminar usuario', 'Eliminar', true)) return;

    const previous = [...appState.users.map(user => ({ ...user }))];
    appState.users = appState.users.filter(user => user.id !== id);
    renderUsers();
    saveAppCache();
    try {
        await apiRequest('deleteUser', { id });
    } catch (err) {
        appState.users = previous;
        renderUsers();
        saveAppCache();
        showAlert(err.message, 'No se pudo eliminar', 'danger');
    }
};

window.recoverUserPassword = async function(id) {
    if (!guardAdminAction()) return;
    if (!isRemoteMode()) {
        showAlert('Configura API_URL para recuperar contraseñas.', 'Modo local', 'warning');
        return;
    }
    const target = appState.users.find(user => user.id === id);
    if (!target || target.role === 'admin') return;

    const recovered = appState.recoveredPasswords[id];
    if (recovered?.revealed) {
        appState.recoveredPasswords[id] = { ...recovered, revealed: false };
        renderUsers();
        return;
    }
    const message = recovered
        ? `Se generará otra clave temporal para ${target.email}. La clave anterior dejará de funcionar.`
        : `Se generará una clave temporal nueva para ${target.email}. La clave anterior dejará de funcionar.`;
    if (!await confirmAction(message, 'Recuperar clave', recovered ? 'Generar otra' : 'Generar')) return;
    let tempPassword = generateMemorablePassword();
    while (recovered?.password === tempPassword) tempPassword = generateMemorablePassword();
    appState.recoveredPasswords[id] = { password: tempPassword, revealed: true };
    renderUsers();
    try {
        const result = await apiRequest('resetUserPassword', { id, tempPassword });
        if (result.user) {
            appState.users = appState.users.map(user => user.id === id ? result.user : user);
        }
        appState.recoveredPasswords[id] = { password: result.tempPassword || tempPassword, revealed: true };
        renderUsers();
        saveAppCache();
    } catch (err) {
        delete appState.recoveredPasswords[id];
        renderUsers();
        showAlert(err.message, 'No se pudo recuperar', 'danger');
    }
};

window.copyRecoveredPassword = async function(id) {
    const recovered = appState.recoveredPasswords[id];
    if (!recovered?.password) return;
    try {
        await navigator.clipboard.writeText(recovered.password);
        showAlert('Clave copiada al portapapeles.', 'Copiada', 'success');
    } catch (err) {
        showAlert('No se pudo copiar automáticamente. Selecciona la clave y cópiala manualmente.', 'Portapapeles', 'warning');
    }
};

const escapeHTML = (value) => {
    return repairText(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[char]);
};

function repairText(value) {
    let text = String(value ?? '');
    if (!/[\u00c3\u00c2]/.test(text) || typeof TextDecoder === 'undefined') return text;
    for (let index = 0; index < 2 && /[\u00c3\u00c2]/.test(text); index += 1) {
        try {
            const bytes = Uint8Array.from([...text].map(char => char.charCodeAt(0) & 255));
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            if (!decoded || decoded === text) break;
            text = decoded;
        } catch (error) {
            break;
        }
    }
    return text;
}

function repairStaticTextEncoding() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
        const fixed = repairText(node.nodeValue);
        if (fixed !== node.nodeValue) node.nodeValue = fixed;
    });
    document.querySelectorAll('[placeholder], [aria-label], [title]').forEach(element => {
        ['placeholder', 'aria-label', 'title'].forEach(attribute => {
            if (!element.hasAttribute(attribute)) return;
            const fixed = repairText(element.getAttribute(attribute));
            if (fixed !== element.getAttribute(attribute)) element.setAttribute(attribute, fixed);
        });
    });
}

function normalizeSearchText(value) {
    return repairText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s$.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function matchesSmartSearch(searchTerm, values) {
    const tokens = normalizeSearchText(searchTerm).split(' ').filter(Boolean);
    if (!tokens.length) return true;
    const haystack = normalizeSearchText(values.filter(value => value !== undefined && value !== null).join(' '));
    return tokens.every(token => haystack.includes(token));
}

// Navigation
function setupNavigation() {
    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active button
            navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Show target view
            const targetId = btn.getAttribute('data-target');
            views.forEach(v => v.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'admin-view') {
                const activeFilter = document.querySelector('.filter-btn.active').getAttribute('data-filter');
                updateAdminDashboard(activeFilter);
            }
        });
    });
}

// Forms & Modals
function setupForms() {
    const openRegistrationForm = () => {
        regFormContainer.style.display = 'flex';
        regFormContainer.classList.remove('closing');
        requestAnimationFrame(() => regFormContainer.classList.add('open'));
        setTimeout(() => document.getElementById('kid-name').focus(), 180);
    };
    const closeRegistrationForm = () => {
        regFormContainer.classList.remove('open');
        regFormContainer.classList.add('closing');
        setTimeout(() => {
            regFormContainer.style.display = 'none';
            regFormContainer.classList.remove('closing');
        }, 220);
    };

    addKidBtn.addEventListener('click', () => {
        if (regFormContainer.classList.contains('open')) closeRegistrationForm();
        else openRegistrationForm();
    });

    cancelAddBtn.addEventListener('click', () => {
        closeRegistrationForm();
        addKidForm.reset();
    });

    regFormContainer.addEventListener('click', event => {
        if (event.target === regFormContainer) closeRegistrationForm();
    });

    addKidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = addKidForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        const kidName = document.getElementById('kid-name').value.trim();
        const parentName = document.getElementById('parent-name').value.trim();
        const parentPhone = document.getElementById('parent-phone').value.trim();
        const selectedService = getSelectedService();
        const durationMinutes = Number(selectedService.durationMinutes);
        const price = Number(selectedService.price);
        
        const now = Date.now();
        const endTime = now + (durationMinutes * 60 * 1000);
        
        const newRecord = {
            id: 'rec_' + now,
            kidName,
            parentName,
            parentPhone,
            durationMinutes,
            price,
            serviceId: selectedService.id,
            serviceName: selectedService.name,
            startTime: now,
            endTime: endTime,
            isActive: true,
            createdAt: now,
            updatedAt: now,
            syncState: isRemoteMode() ? 'saving' : 'synced'
        };
        const previousRecords = [...appState.records];
        appState.records.unshift(newRecord);
        appState.activePage = 1;
        saveState();
        addKidForm.reset();
        closeRegistrationForm();
        renderActiveKids();
        updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
        
        try {
            if (isRemoteMode()) {
                const result = await apiRequest('createRecord', { record: newRecord });
                appState.records = appState.records.map(record => record.id === newRecord.id ? result.record : record);
            } else {
                appState.records = appState.records.map(record => record.id === newRecord.id ? { ...record, syncState: 'synced' } : record);
            }
            saveState();
            renderActiveKids();
            updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
        } catch (err) {
            appState.records = previousRecords;
            saveState();
            renderActiveKids();
            updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
            showAlert(err.message, 'No se pudo crear', 'danger');
        } finally {
            submitBtn.disabled = false;
        }
    });

    // Edit Form
    cancelEditBtn.addEventListener('click', () => {
        editModal.style.display = 'none';
        editKidForm.reset();
    });

    editKidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('edit-id').value;
        const recordIndex = appState.records.findIndex(r => r.id === id);
        
        if (recordIndex !== -1) {
            const submitBtn = editKidForm.querySelector('button[type="submit"]');
            const previousRecords = [...appState.records.map(record => ({ ...record }))];
            try {
                appState.records[recordIndex].kidName = document.getElementById('edit-kid-name').value;
                appState.records[recordIndex].parentName = document.getElementById('edit-parent-name').value;
                appState.records[recordIndex].parentPhone = document.getElementById('edit-parent-phone').value;
                appState.records[recordIndex].updatedAt = Date.now();
                appState.records[recordIndex].syncState = isRemoteMode() ? 'saving' : 'synced';
                
                const extraTime = parseInt(document.getElementById('edit-extra-time').value) || 0;
                if (extraTime > 0) {
                    appState.records[recordIndex].durationMinutes += extraTime;
                    appState.records[recordIndex].endTime += (extraTime * 60 * 1000);
                }

                submitBtn.disabled = true;
                saveState();
                editModal.style.display = 'none';
                renderActiveKids();
                updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));

                if (isRemoteMode()) {
                    const result = await apiRequest('updateRecord', { record: appState.records[recordIndex] });
                    appState.records = appState.records.map(record => record.id === id ? result.record : record);
                }
                
                saveState();
                renderActiveKids();
                updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
            } catch (err) {
                appState.records = previousRecords;
                saveState();
                renderActiveKids();
                updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
                showAlert(err.message, 'No se pudo editar', 'danger');
            } finally {
                submitBtn.disabled = false;
            }
            return;
        }
    });
}

function setupActiveSearch() {
    activeSearchInput.addEventListener('input', () => {
        appState.activeSearchTerm = activeSearchInput.value.trim();
        appState.activePage = 1;
        renderActiveKids();
    });
}

// Active Kids Rendering & Timer
function renderActiveKidsLegacy() {
    const activeRecords = appState.records.filter(r => r.isActive).sort((a, b) => a.endTime - b.endTime);
    activeCount.textContent = activeRecords.length;
    
    if (activeRecords.length === 0) {
        activeKidsGrid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-smiley-blank"></i>
                <p>No hay niños registrados en este momento.</p>
            </div>
        `;
        return;
    }

    activeKidsGrid.innerHTML = '';
    const now = Date.now();

    activeRecords.forEach(record => {
        const remainingMs = record.endTime - now;
        const isTimeUp = remainingMs <= 0;
        
        const card = document.createElement('div');
        card.className = `kid-card ${isTimeUp ? 'time-up' : ''}`;
        card.id = `card-${record.id}`;
        
        // Calculate display time
        let displayTime = "00:00";
        if (!isTimeUp) {
            const totalSeconds = Math.floor(remainingMs / 1000);
            const m = Math.floor(totalSeconds / 60);
            const s = totalSeconds % 60;
            displayTime = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        
        card.innerHTML = `
            <div class="kid-card-header">
                <div class="kid-info">
                    <h3>${record.kidName}</h3>
                    <p><i class="ph ph-user"></i> ${record.parentName}</p>
                    <p><i class="ph ph-phone"></i> ${record.parentPhone}</p>
                </div>
            </div>
            <div class="timer-display" id="timer-${record.id}">
                ${displayTime}
            </div>
            <div class="kid-actions">
                <button onclick="editRecord('${record.id}')"><i class="ph ph-pencil-simple"></i> Editar</button>
                <button onclick="finishRecord('${record.id}')"><i class="ph ph-check-circle"></i> Finalizar</button>
            </div>
        `;
        
        activeKidsGrid.appendChild(card);
    });
}

function renderActiveKids() {
    const now = Date.now();
    const activeRecords = appState.records
        .filter(r => r.isActive)
        .sort((a, b) => {
            const aExpired = a.endTime <= now;
            const bExpired = b.endTime <= now;
            if (aExpired !== bExpired) return aExpired ? -1 : 1;
            return a.endTime - b.endTime;
        });
    const expiredRecords = activeRecords.filter(r => r.endTime <= now);
    activeCount.textContent = activeRecords.length;
    selectExpiredBtn.hidden = expiredRecords.length === 0;

    if (activeRecords.length === 0) {
        activeKidsGrid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-smiley-blank"></i>
                <p>No hay niños registrados en este momento.</p>
            </div>
        `;
        activePagination.innerHTML = '';
        activePageSummary.textContent = '';
        updateBatchActionBar();
        return;
    }

    const searchTerm = appState.activeSearchTerm;
    const filteredRecords = searchTerm
        ? activeRecords.filter(record => matchesSmartSearch(searchTerm, [
            record.kidName,
            record.parentName,
            record.parentPhone,
            record.serviceName,
            record.durationMinutes,
            record.price,
            record.endTime <= now ? 'vencido terminado alerta' : 'activo'
        ]))
        : activeRecords;

    if (filteredRecords.length === 0) {
        activeKidsGrid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-magnifying-glass"></i>
                <p>No encontramos niños con esa búsqueda.</p>
            </div>
        `;
        activePagination.innerHTML = '';
        activePageSummary.textContent = '0 resultados';
        updateBatchActionBar();
        return;
    }

    const totalPages = Math.max(1, Math.ceil(filteredRecords.length / appState.activePageSize));
    if (appState.activePage > totalPages) appState.activePage = totalPages;

    const startIndex = (appState.activePage - 1) * appState.activePageSize;
    const pageRecords = filteredRecords.slice(startIndex, startIndex + appState.activePageSize);
    const rangeStart = startIndex + 1;
    const rangeEnd = startIndex + pageRecords.length;

    activePageSummary.textContent = `${rangeStart}-${rangeEnd} de ${filteredRecords.length}`;
    activeKidsGrid.innerHTML = '';

    pageRecords.forEach(record => {
        const remainingMs = record.endTime - now;
        const isTimeUp = remainingMs <= 0;
        const alertIndex = isTimeUp ? expiredRecords.findIndex(r => r.id === record.id) + 1 : 0;
        const isSaving = record.syncState === 'saving';
        const card = document.createElement('div');
        const isSelected = appState.selectedExpiredIds.has(record.id);
        card.className = `kid-card ${isTimeUp ? 'time-up' : ''} ${isSelected ? 'selected' : ''} ${isSaving ? 'is-saving' : ''}`;
        card.id = `card-${record.id}`;

        let displayTime = "00:00";
        if (!isTimeUp) {
            const totalSeconds = Math.floor(remainingMs / 1000);
            const m = Math.floor(totalSeconds / 60);
            const s = totalSeconds % 60;
            displayTime = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }

        card.innerHTML = `
            ${isTimeUp && appState.selectionMode ? `
                <button class="card-selector" type="button" onclick="toggleExpiredSelection('${record.id}')" aria-label="Seleccionar ${escapeHTML(record.kidName)}">
                    <i class="ph ${isSelected ? 'ph-check-circle-fill' : 'ph-circle'}"></i>
                </button>` : ''}
            <div class="kid-card-header">
                <div class="kid-info">
                    <h3>${escapeHTML(record.kidName)}</h3>
                    <p><i class="ph ph-user"></i> ${escapeHTML(record.parentName)}</p>
                    <p><i class="ph ph-phone"></i> ${escapeHTML(record.parentPhone)}</p>
                </div>
                <span class="active-status ${isTimeUp ? 'expired' : ''}">
                    ${isSaving ? '<i class="ph ph-cloud-arrow-up"></i> Guardando' : (isTimeUp ? `<i class="ph ph-bell-ringing bell-alert"></i> Alerta ${alertIndex}` : 'Activo')}
                </span>
            </div>
            <div class="timer-display" id="timer-${record.id}">
                ${displayTime}
            </div>
            <div class="kid-actions ${appState.selectionMode && isTimeUp ? 'selection-actions' : ''}">
                <button onclick="editRecord('${record.id}')"><i class="ph ph-pencil-simple"></i> Editar</button>
                <button onclick="${isTimeUp ? 'acceptExpiredRecord' : 'finishRecord'}('${record.id}')">
                    <i class="ph ${isTimeUp ? 'ph-bell-simple-slash' : 'ph-check-circle'}"></i>
                    ${isTimeUp ? 'Aceptar y finalizar' : 'Finalizar'}
                </button>
            </div>
        `;

        if (isTimeUp && appState.selectionMode) {
            card.addEventListener('click', (event) => {
                if (!event.target.closest('.kid-actions') && !event.target.closest('.card-selector')) toggleExpiredSelection(record.id);
            });
        }

        activeKidsGrid.appendChild(card);
    });

    renderActivePagination(totalPages);
    updateBatchActionBar();
}

function renderActivePagination(totalPages) {
    if (totalPages <= 1) {
        activePagination.innerHTML = '';
        return;
    }

    activePagination.innerHTML = `
        <button class="pagination-btn" ${appState.activePage === 1 ? 'disabled' : ''} onclick="changeActivePage(${appState.activePage - 1})">
            <i class="ph ph-caret-left"></i>
        </button>
        <span>Página ${appState.activePage} de ${totalPages}</span>
        <button class="pagination-btn" ${appState.activePage === totalPages ? 'disabled' : ''} onclick="changeActivePage(${appState.activePage + 1})">
            <i class="ph ph-caret-right"></i>
        </button>
    `;
}

window.changeActivePage = function(page) {
    appState.activePage = page;
    renderActiveKids();
};

function setupBatchSelection() {
    selectExpiredBtn.addEventListener('click', () => {
        appState.selectionMode = true;
        appState.selectedExpiredIds = new Set(
            appState.records.filter(record => record.isActive && record.endTime <= Date.now()).map(record => record.id)
        );
        renderActiveKids();
    });
    cancelSelectionBtn.addEventListener('click', exitSelectionMode);
    finishSelectedBtn.addEventListener('click', () => {
        const ids = [...appState.selectedExpiredIds];
        if (ids.length) queueFinishedRecords(ids);
        exitSelectionMode();
    });
    window.addEventListener('online', processFinishQueue);
    updateSyncStatus();
}

window.toggleExpiredSelection = function(id) {
    if (appState.selectedExpiredIds.has(id)) appState.selectedExpiredIds.delete(id);
    else appState.selectedExpiredIds.add(id);
    renderActiveKids();
};

function exitSelectionMode() {
    appState.selectionMode = false;
    appState.selectedExpiredIds.clear();
    renderActiveKids();
}

function updateBatchActionBar() {
    batchActionBar.hidden = !appState.selectionMode;
    selectedExpiredCount.textContent = appState.selectedExpiredIds.size;
    finishSelectedBtn.disabled = appState.selectedExpiredIds.size === 0;
}

function persistFinishQueue() {
    localStorage.setItem('piscinaFinishQueue', JSON.stringify(appState.finishQueue));
    updateSyncStatus();
}

function updateSyncStatus() {
    if (!syncStatus) return;
    const pending = appState.finishQueue.length;
    syncStatus.hidden = pending === 0;
    if (pending) syncStatus.innerHTML = `<i class="ph ph-cloud-arrow-up"></i> ${pending} cierre${pending === 1 ? '' : 's'} guardándose en segundo plano`;
}

function queueFinishedRecords(ids) {
    const now = Date.now();
    ids.forEach(id => {
        const record = appState.records.find(item => item.id === id);
        if (!record) return;
        record.isActive = false;
        appState.alertedIds.delete(id);
        if (isRemoteMode() && !appState.finishQueue.some(item => item.id === id)) {
            appState.finishQueue.push({ id, operationId: `finish_${id}_${now}`, attempts: 0, nextTryAt: now });
        }
    });
    appState.activePage = 1;
    saveState();
    persistFinishQueue();
    renderActiveKids();
    updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
    processFinishQueue();
}

async function processFinishQueue() {
    if (!isRemoteMode() || appState.syncingFinishes || !appState.finishQueue.length || !navigator.onLine) return;
    const now = Date.now();
    const ready = appState.finishQueue.filter(item => Number(item.nextTryAt || 0) <= now).slice(0, 100);
    if (!ready.length) {
        const delay = Math.max(500, Math.min(...appState.finishQueue.map(item => item.nextTryAt || now)) - now);
        clearTimeout(appState.syncRetryTimer);
        appState.syncRetryTimer = setTimeout(processFinishQueue, delay);
        return;
    }

    appState.syncingFinishes = true;
    syncStatus.classList.add('is-syncing');
    try {
        const result = await apiRequest('finishRecordsBatch', { items: ready.map(({ id, operationId }) => ({ id, operationId })) });
        const completed = new Set(result.succeeded || []);
        const permanentlyMissing = new Set((result.failed || []).filter(item => item.error === 'Registro no encontrado').map(item => item.id));
        appState.finishQueue = appState.finishQueue.filter(item => !completed.has(item.id) && !permanentlyMissing.has(item.id));
    } catch (error) {
        // Compatibilidad temporal con una implementación anterior del Apps Script.
        if (/no soportada/i.test(error.message || '')) {
            const fallback = await Promise.allSettled(ready.map(item => apiRequest('finishRecord', { id: item.id })));
            const completed = new Set(ready.filter((item, index) => fallback[index].status === 'fulfilled').map(item => item.id));
            appState.finishQueue = appState.finishQueue.filter(item => !completed.has(item.id));
        }
        ready.filter(item => appState.finishQueue.some(queued => queued.id === item.id)).forEach(item => {
            item.attempts = Number(item.attempts || 0) + 1;
            item.nextTryAt = Date.now() + Math.min(30000, 800 * Math.pow(2, item.attempts));
        });
    } finally {
        appState.syncingFinishes = false;
        syncStatus.classList.remove('is-syncing');
        persistFinishQueue();
        if (appState.finishQueue.length) {
            clearTimeout(appState.syncRetryTimer);
            appState.syncRetryTimer = setTimeout(processFinishQueue, 1200);
        }
    }
}

function startGlobalTimer() {
    setInterval(() => {
        const now = Date.now();
        const activeRecords = appState.records.filter(r => r.isActive);
        const newlyExpired = [];
        
        activeRecords.forEach(record => {
            const remainingMs = record.endTime - now;
            const timerEl = document.getElementById(`timer-${record.id}`);
            const cardEl = document.getElementById(`card-${record.id}`);

            if (remainingMs <= 0 && !appState.alertedIds.has(record.id)) {
                appState.alertedIds.add(record.id);
                newlyExpired.push(record.id);
            }
            
            if (!timerEl || !cardEl) return;

            if (remainingMs <= 0) {
                if (!cardEl.classList.contains('time-up')) {
                    cardEl.classList.add('time-up');
                    timerEl.textContent = "00:00";
                    const statusEl = cardEl.querySelector('.active-status');
                    if (statusEl) {
                        statusEl.textContent = 'Terminado';
                        statusEl.classList.add('expired');
                    }
                    // Vibration (supported browsers)
                    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
                }
            } else {
                const totalSeconds = Math.floor(remainingMs / 1000);
                const m = Math.floor(totalSeconds / 60);
                const s = totalSeconds % 60;
                timerEl.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
        });

        if (newlyExpired.length > 0) {
            appState.activePage = 1;
            notifyExpiredRecords(newlyExpired);
            syncExpiredPushAlerts(newlyExpired);
            playAlarm(Math.min(newlyExpired.length, 3));
            if (navigator.vibrate) navigator.vibrate([250, 100, 250, 100, 250]);
            renderActiveKids();
        }
    }, 1000);
}

window.editRecord = function(id) {
    const record = appState.records.find(r => r.id === id);
    if (!record) return;
    
    document.getElementById('edit-id').value = record.id;
    document.getElementById('edit-kid-name').value = record.kidName;
    document.getElementById('edit-parent-name').value = record.parentName;
    document.getElementById('edit-parent-phone').value = record.parentPhone;
    document.getElementById('edit-extra-time').value = "0";
    
    editModal.style.display = 'flex';
};

async function completeActiveRecord(id) {
    queueFinishedRecords([id]);
}

window.finishRecord = async function(id) {
    if(await confirmAction('Seguro que deseas marcar este tiempo como finalizado?', 'Finalizar tiempo', 'Finalizar')) {
        completeActiveRecord(id);
    }
};

window.acceptExpiredRecord = function(id) {
    completeActiveRecord(id);
};

// Admin Dashboard
function setupAdminFilters() {
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateAdminDashboard(btn.getAttribute('data-filter'));
        });
    });

    searchInput.addEventListener('input', () => {
        const activeFilter = document.querySelector('.filter-btn.active').getAttribute('data-filter');
        updateAdminDashboard(activeFilter);
    });

    if (exportHistoryPdfBtn) exportHistoryPdfBtn.addEventListener('click', exportHistoryPdf);
    if (exportHistoryExcelBtn) exportHistoryExcelBtn.addEventListener('click', exportHistoryExcel);
}

function getCurrentHistoryFilterType() {
    return document.querySelector('.filter-btn.active')?.getAttribute('data-filter') || 'today';
}

function getHistoryFilterLabel(filterType) {
    return ({
        today: 'Hoy',
        yesterday: 'Ayer',
        '7days': 'Últimos 7 días',
        '15days': 'Últimos 15 días',
        '30days': 'Últimos 30 días',
        all: 'Todos'
    })[filterType] || 'Historial';
}

function getFilteredHistoryRecords(filterType = getCurrentHistoryFilterType()) {
    const now = new Date();
    now.setHours(0,0,0,0);
    const todayMs = now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    
    const searchTerm = searchInput.value;
    
    return appState.records.filter(r => {
        // Date Filtering
        let inDateRange = true;
        const recordDate = new Date(r.startTime);
        recordDate.setHours(0,0,0,0);
        const recordDateMs = recordDate.getTime();
        
        switch(filterType) {
            case 'today':
                inDateRange = recordDateMs === todayMs;
                break;
            case 'yesterday':
                inDateRange = recordDateMs === (todayMs - dayMs);
                break;
            case '7days':
                inDateRange = recordDateMs >= (todayMs - (7 * dayMs));
                break;
            case '15days':
                inDateRange = recordDateMs >= (todayMs - (15 * dayMs));
                break;
            case '30days':
                inDateRange = recordDateMs >= (todayMs - (30 * dayMs));
                break;
            case 'all':
                inDateRange = true;
                break;
        }

        // Search Filtering
        const inSearch = matchesSmartSearch(searchTerm, [
            r.id,
            r.kidName,
            r.parentName,
            r.parentPhone,
            r.serviceName,
            r.durationMinutes,
            r.price,
            formatCurrency(r.price),
            r.isActive ? 'activo en piscina' : 'finalizado historial',
            new Date(r.startTime).toLocaleString('es-CO')
        ]);

        return inDateRange && inSearch;
    }).sort((a, b) => b.startTime - a.startTime);
}

function updateAdminDashboard(filterType) {
    let filteredRecords = getFilteredHistoryRecords(filterType);

    if (exportHistoryPdfBtn) exportHistoryPdfBtn.disabled = filteredRecords.length === 0;
    if (exportHistoryExcelBtn) exportHistoryExcelBtn.disabled = filteredRecords.length === 0;

    // Calculate totals
    const totalIncome = filteredRecords.reduce((sum, r) => sum + r.price, 0);
    totalIncomeEl.textContent = formatCurrency(totalIncome);
    totalKidsServedEl.textContent = filteredRecords.length;

    // Render List
    if (filteredRecords.length === 0) {
        historyListEl.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-receipt"></i>
                <p>No hay registros para este periodo o búsqueda.</p>
            </div>
        `;
        return;
    }

    historyListEl.innerHTML = '';
    filteredRecords.forEach(r => {
        const dateObj = new Date(r.startTime);
        const dateStr = dateObj.toLocaleDateString('es-CO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <div class="history-info">
                <h4>${escapeHTML(r.kidName)} (${escapeHTML(r.serviceName || `${r.durationMinutes} min`)})</h4>
                <p>${escapeHTML(r.parentName)} - ${escapeHTML(r.parentPhone)} • ${dateStr}</p>
            </div>
            <div class="history-price">
                ${formatCurrency(r.price)}
                ${r.isActive ? '<span class="active-history-status">Activo</span>' : ''}
                <button class="history-print-btn" onclick="printReceipt('${r.id}')" aria-label="Imprimir factura">
                    <i class="ph ph-printer"></i>
                </button>
                <button class="history-delete-btn" onclick="deleteHistoryRecord('${r.id}')">
                    <i class="ph ph-trash"></i>
                </button>
            </div>
        `;
        historyListEl.appendChild(item);
    });
}

window.deleteHistoryRecord = async function(id) {
    if (!guardAdminAction()) return;
    if (!await confirmAction('Seguro que deseas eliminar este registro?', 'Eliminar registro', 'Eliminar', true)) return;
    const previousRecords = [...appState.records.map(record => ({ ...record }))];
    const previousQueue = [...appState.finishQueue.map(item => ({ ...item }))];
    appState.records = appState.records.filter(record => record.id !== id);
    appState.finishQueue = appState.finishQueue.filter(item => item.id !== id);
    saveState();
    persistFinishQueue();
    renderActiveKids();
    updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
    try {
        if (isRemoteMode()) await apiRequest('deleteRecord', { id });
        saveState();
    } catch (err) {
        appState.records = previousRecords;
        appState.finishQueue = previousQueue;
        saveState();
        persistFinishQueue();
        renderActiveKids();
        updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
        showAlert(err.message, 'No se pudo eliminar', 'danger');
    }
};

function formatReceiptCurrency(amount) {
    return '$ ' + Number(amount || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function formatReceiptDate(value) {
    return new Date(value).toLocaleString('es-CO', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

function formatReceiptTime(value) {
    return new Date(value).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function buildReceiptDocument(record) {
    const started = formatReceiptDate(record.startTime);
    const ended = formatReceiptTime(record.endTime);
    const total = formatReceiptCurrency(record.price);
    const appName = getAppName().toUpperCase();
    const serviceLabel = record.serviceName || `${Number(record.durationMinutes || 0)} MIN`;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>RECIBO ${escapeHTML(record.id)}</title>
<style>
  @page {
    size: A4;
    margin: 4mm;
  }

  * {
    box-sizing: border-box;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: "Courier New", monospace;
    font-size: 27px;
    font-weight: 800;
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .recibo {
    width: 100%;
    min-height: auto;
    padding: 4mm 5mm;
  }

  .center {
    text-align: center;
  }

  .logo {
    max-width: 280px;
    margin: 0 auto 10px;
    display: block;
  }

  .title {
    font-size: 48px;
    font-weight: 900;
    margin-bottom: 6px;
  }

  .subtitle {
    font-size: 27px;
    font-weight: 800;
    margin-bottom: 14px;
  }

  .line {
    border-top: 4px dashed #000;
    margin: 14px 0;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 22px;
    margin: 9px 0;
    font-size: 28px;
    font-weight: 900;
  }

  .label {
    font-weight: 900;
    flex: 0 0 auto;
  }

  .value {
    text-align: right;
    font-weight: 900;
    overflow-wrap: anywhere;
  }

  .total-box {
    border: 4px dashed #000;
    padding: 16px;
    margin-top: 16px;
  }

  .total-box .label {
    font-size: 27px;
  }

  .total {
    font-size: 58px;
    font-weight: 900;
    text-align: center;
    margin-top: 10px;
  }

  .footer {
    font-size: 23px;
    font-weight: 800;
    text-align: center;
    margin-top: 14px;
  }

  @media screen {
    html {
      background: #f4f4f4;
    }

    body {
      max-width: 210mm;
      margin: 0 auto;
      box-shadow: 0 18px 60px rgba(0, 0, 0, .14);
    }
  }

  @media print {
    body {
      box-shadow: none;
    }
  }
</style>
</head>
<body>
<div class="recibo">
  <div class="center">
    <img src="images/logo.png" class="logo" alt="LOGO">
    <div class="title">${escapeHTML(appName)}</div>
    <div class="subtitle">RECIBO DE SERVICIO</div>
  </div>

  <div class="line"></div>

  <div class="row">
    <div class="label">RECIBO</div>
    <div class="value">${escapeHTML(record.id)}</div>
  </div>

  <div class="row">
    <div class="label">NIÑO</div>
    <div class="value">${escapeHTML(record.kidName)}</div>
  </div>

  <div class="row">
    <div class="label">RESPONSABLE</div>
    <div class="value">${escapeHTML(record.parentName)}</div>
  </div>

  <div class="row">
    <div class="label">TELÉFONO</div>
    <div class="value">${escapeHTML(record.parentPhone)}</div>
  </div>

  <div class="row">
    <div class="label">SERVICIO</div>
    <div class="value">${escapeHTML(serviceLabel)}</div>
  </div>

  <div class="row">
    <div class="label">FECHA</div>
    <div class="value">${escapeHTML(started)}</div>
  </div>

  <div class="row">
    <div class="label">SALIDA</div>
    <div class="value">${escapeHTML(ended)}</div>
  </div>

  <div class="line"></div>

  <div class="total-box">
    <div class="center label">TOTAL A PAGAR</div>
    <div class="total">${escapeHTML(total)}</div>
  </div>

  <div class="footer">
    ¡GRACIAS POR SU VISITA!<br>
    CONSERVE ESTE RECIBO
  </div>
</div>

<script>
  window.onload = function () {
    setTimeout(function () {
      window.print();
    }, 120);
    window.onafterprint = function () {
      window.close();
    };
  };
<\/script>
</body>
</html>`;
    return '<!doctype html><html><head><meta charset="utf-8"><title>Factura ' + escapeHTML(record.id) + '</title><style>' +
        '@page{size:80mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}' +
        'body{width:80mm;min-height:112mm;margin:0 auto;padding:4mm 3.8mm 8mm;font:15.8px/1.48 "Courier New",Courier,ui-monospace,monospace;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        'h1{font:900 24px/1.05 Arial,Helvetica,sans-serif;text-align:center;margin:0 0 6px;letter-spacing:-.4px;white-space:nowrap}.subtitle{text-align:center;font-size:15px;margin-bottom:13px}' +
        '.dash{border-top:2px dashed #111;height:0;margin:14px 0 15px;width:100%}.field{margin:1px 0;white-space:nowrap;overflow:hidden;text-overflow:clip}strong{font-weight:900}' +
        '.field:nth-child(8) strong,.field:nth-child(10) strong{font-size:0}.field:nth-child(8) strong:before{content:"Ni\\00f1o:";font-size:15.8px}.field:nth-child(10) strong:before{content:"Tel\\00e9fono:";font-size:15.8px}' +
        '.row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin:1px 0;white-space:nowrap}.row span:first-child{min-width:0}.row span:last-child{text-align:right;white-space:nowrap;flex:0 0 auto}' +
        '.total{font:900 22px/1.18 Arial,Helvetica,sans-serif;letter-spacing:.1px;margin-top:0}.thanks{text-align:center;margin:26px 0 3px;font-size:0}.thanks:before{content:"\\00a1 Gracias por visitarnos!";font-size:17px}.note{text-align:center;font-size:14px}' +
        '@media screen{html{background:#f4f4f4}body{box-shadow:0 18px 60px rgba(0,0,0,.14);min-height:112mm}}@media print{button{display:none}body{box-shadow:none;margin:0}}' +
        '</style></head><body>' +
        '<h1>' + escapeHTML(appName) + '</h1><div class="subtitle">Comprobante de servicio</div><div class="dash"></div>' +
        '<div class="field">Factura: ' + escapeHTML(record.id) + '</div><div class="field">Fecha: ' + escapeHTML(started) + '</div><div class="field">Salida estimada: ' + escapeHTML(ended) + '</div><div class="dash"></div>' +
        '<div class="field"><strong>Niño:</strong> ' + escapeHTML(record.kidName) + '</div><div class="field"><strong>Responsable:</strong> ' + escapeHTML(record.parentName) + '</div><div class="field"><strong>Teléfono:</strong> ' + escapeHTML(record.parentPhone) + '</div>' +
        '<div class="dash"></div><div class="row"><span>' + escapeHTML(serviceLabel) + '</span><span>' + formatReceiptCurrency(record.price) + '</span></div>' +
        '<div class="dash"></div><div class="row total"><span>TOTAL</span><span>' + formatReceiptCurrency(record.price) + '</span></div>' +
        '<p class="thanks">¡Gracias por visitarnos!</p><div class="note">Documento informativo</div>' +
        '<script>window.onload=function(){setTimeout(function(){window.print()},120);window.onafterprint=function(){window.close()}}<\/script></body></html>';
}

window.printReceipt = function(id) {
    const record = appState.records.find(item => item.id === id);
    if (!record) return;
    const popup = window.open('', '_blank', 'width=1600,height=1800');
    if (!popup) {
        showAlert('Permite ventanas emergentes para imprimir el recibo.', 'Ventana bloqueada', 'warning');
        return;
    }
    popup.document.write(buildReceiptDocument(record));
    popup.document.close();
    return;
    const started = new Date(record.startTime).toLocaleString('es-CO');
    const ended = new Date(record.endTime).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Factura ${escapeHTML(record.id)}</title><style>
        @page{size:80mm auto;margin:3mm}*{box-sizing:border-box}body{width:72mm;margin:0 auto;font:12px/1.4 ui-monospace,Consolas,monospace;color:#000}
        h1{font:700 17px Arial,sans-serif;text-align:center;margin:8px 0 2px}.center{text-align:center}.muted{font-size:10px}.line{border-top:1px dashed #000;margin:10px 0}
        .row{display:flex;justify-content:space-between;gap:8px;margin:4px 0}.total{font-size:16px;font-weight:800}.thanks{text-align:center;margin:14px 0 2px}@media print{button{display:none}}
    </style></head><body>
        <h1>PISCINA DE PELOTAS</h1><div class="center muted">Comprobante de servicio</div><div class="line"></div>
        <div>Factura: ${escapeHTML(record.id)}</div><div>Fecha: ${escapeHTML(started)}</div><div>Salida estimada: ${escapeHTML(ended)}</div><div class="line"></div>
        <div><strong>Niño:</strong> ${escapeHTML(record.kidName)}</div><div><strong>Responsable:</strong> ${escapeHTML(record.parentName)}</div><div><strong>Teléfono:</strong> ${escapeHTML(record.parentPhone)}</div>
        <div class="line"></div><div class="row"><span>Servicio (${Number(record.durationMinutes)} min)</span><span>${formatCurrency(record.price)}</span></div>
        <div class="line"></div><div class="row total"><span>TOTAL</span><span>${formatCurrency(record.price)}</span></div>
        <p class="thanks">¡Gracias por visitarnos!</p><div class="center muted">Documento informativo</div>
        <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script></body></html>`);
    popup.document.close();
};

function getHistoryExportSummary(records) {
    return {
        totalRecords: records.length,
        totalIncome: records.reduce((sum, record) => sum + Number(record.price || 0), 0),
        activeCount: records.filter(record => record.isActive).length
    };
}

function openPrintableHistoryReport(records, filterType) {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup) {
        showAlert('Permite ventanas emergentes para generar el PDF.', 'Ventana bloqueada', 'warning');
        return;
    }
    const summary = getHistoryExportSummary(records);
    const generatedAt = new Date().toLocaleString('es-CO');
    const appName = getAppName().toUpperCase();
    const rows = records.map((record, index) => {
        const start = new Date(record.startTime).toLocaleString('es-CO');
        const end = new Date(record.endTime).toLocaleString('es-CO');
        return '<tr>' +
            '<td>' + (index + 1) + '</td>' +
            '<td><strong>' + escapeHTML(record.kidName) + '</strong><span>' + escapeHTML(record.id) + '</span></td>' +
            '<td>' + escapeHTML(record.parentName) + '</td>' +
            '<td>' + escapeHTML(record.parentPhone) + '</td>' +
            '<td>' + escapeHTML(record.serviceName || `${Number(record.durationMinutes || 0)} min`) + '</td>' +
            '<td>' + escapeHTML(start) + '</td>' +
            '<td>' + escapeHTML(end) + '</td>' +
            '<td>' + (record.isActive ? 'Activo' : 'Finalizado') + '</td>' +
            '<td class="money">' + formatCurrency(record.price) + '</td>' +
        '</tr>';
    }).join('');

    popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Historial ' + escapeHTML(appName) + '</title><style>' +
        '@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:12px/1.45 Inter,Arial,sans-serif}' +
        '.page{max-width:1120px;margin:0 auto;padding:24px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:24px;border-radius:24px;color:#fff;background:linear-gradient(135deg,#001f3f,#15537c);box-shadow:0 20px 50px rgba(0,31,63,.18)}' +
        'h1{margin:0;font-size:30px;letter-spacing:-.6px}.meta{opacity:.86;margin-top:6px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.card{padding:14px;border-radius:18px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.08);border:1px solid #e8edf5}.label{font-size:10px;color:#667085;text-transform:uppercase;font-weight:800;letter-spacing:.7px}.value{font-size:22px;font-weight:900;margin-top:4px;color:#001f3f}' +
        'table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 14px 34px rgba(15,23,42,.08)}th{background:#eef4fb;color:#001f3f;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:10px;border-bottom:1px solid #dce7f3}td{padding:10px;border-bottom:1px solid #edf1f6;vertical-align:top}td span{display:block;color:#667085;font-size:10px;margin-top:2px}.money{text-align:right;font-weight:900;color:#001f3f;white-space:nowrap}tr:last-child td{border-bottom:0}.footer{text-align:center;color:#667085;margin-top:16px;font-size:11px}' +
        '@media print{body{background:#fff}.page{padding:0}.hero,.card,table{box-shadow:none}.hero{break-inside:avoid}.cards{break-inside:avoid}}' +
        '</style></head><body><main class="page">' +
        '<section class="hero"><div><h1>' + escapeHTML(appName) + '</h1><div class="meta">Historial de registros · ' + escapeHTML(getHistoryFilterLabel(filterType)) + '</div></div><div class="meta">Generado: ' + escapeHTML(generatedAt) + '</div></section>' +
        '<section class="cards"><div class="card"><div class="label">Registros</div><div class="value">' + summary.totalRecords + '</div></div><div class="card"><div class="label">Ingresos</div><div class="value">' + formatCurrency(summary.totalIncome) + '</div></div><div class="card"><div class="label">Activos</div><div class="value">' + summary.activeCount + '</div></div></section>' +
        '<table><thead><tr><th>#</th><th>Niño / Factura</th><th>Responsable</th><th>Teléfono</th><th>Servicio</th><th>Ingreso</th><th>Salida estimada</th><th>Estado</th><th>Valor</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="footer">Documento informativo generado desde el sistema ' + escapeHTML(appName) + '.</div>' +
        '<script>window.onload=function(){setTimeout(function(){window.print()},160)}<\/script></main></body></html>');
    popup.document.close();
}

function exportHistoryPdf() {
    const filterType = getCurrentHistoryFilterType();
    const records = getFilteredHistoryRecords(filterType);
    if (!records.length) {
        showAlert('No hay registros para exportar con el filtro actual.', 'Sin registros', 'warning');
        return;
    }
    openPrintableHistoryReport(records, filterType);
}

function exportHistoryExcel() {
    const filterType = getCurrentHistoryFilterType();
    const records = getFilteredHistoryRecords(filterType);
    if (!records.length) {
        showAlert('No hay registros para exportar con el filtro actual.', 'Sin registros', 'warning');
        return;
    }
    const summary = getHistoryExportSummary(records);
    const rows = records.map((record, index) => {
        return '<tr>' +
            '<td>' + (index + 1) + '</td>' +
            '<td>' + escapeHTML(record.id) + '</td>' +
            '<td>' + escapeHTML(record.kidName) + '</td>' +
            '<td>' + escapeHTML(record.parentName) + '</td>' +
            '<td style="mso-number-format:\\@;">' + escapeHTML(record.parentPhone) + '</td>' +
            '<td>' + escapeHTML(record.serviceName || `${Number(record.durationMinutes || 0)} min`) + '</td>' +
            '<td>' + escapeHTML(new Date(record.startTime).toLocaleString('es-CO')) + '</td>' +
            '<td>' + escapeHTML(new Date(record.endTime).toLocaleString('es-CO')) + '</td>' +
            '<td>' + (record.isActive ? 'Activo' : 'Finalizado') + '</td>' +
            '<td>' + Number(record.price || 0) + '</td>' +
        '</tr>';
    }).join('');
    const html = '<html><head><meta charset="utf-8"><style>' +
        'table{border-collapse:collapse;font-family:Arial,sans-serif}th{background:#001f3f;color:#fff;font-weight:700}td,th{border:1px solid #cfd8e3;padding:8px}tr:nth-child(even){background:#f5f8fc}.money{font-weight:700}' +
        '</style></head><body>' +
        '<table><tr><th colspan="10" style="font-size:18px;background:#001f3f;color:#fff;">' + escapeHTML(getAppName().toUpperCase()) + ' - Historial de registros</th></tr>' +
        '<tr><td colspan="10">Filtro: ' + escapeHTML(getHistoryFilterLabel(filterType)) + ' | Registros: ' + summary.totalRecords + ' | Ingresos: ' + formatCurrency(summary.totalIncome) + '</td></tr>' +
        '<tr><th>#</th><th>Factura</th><th>Niño</th><th>Responsable</th><th>Teléfono</th><th>Servicio</th><th>Ingreso</th><th>Salida estimada</th><th>Estado</th><th>Valor COP</th></tr>' +
        rows + '</table></body></html>';
    const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = 'historial-piscina-' + filterType + '-' + date + '.xls';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function setupAssistant() {
    const launcher = document.getElementById('assistant-launcher');
    const panel = document.getElementById('assistant-panel');
    const close = document.getElementById('assistant-close');
    const form = document.getElementById('assistant-form');
    const input = document.getElementById('assistant-input');
    const dateFrom = document.getElementById('assistant-date-from');
    const dateTo = document.getElementById('assistant-date-to');
    const rangeRun = document.getElementById('assistant-range-run');
    const toggle = (open) => {
        panel.classList.toggle('open', open);
        panel.setAttribute('aria-hidden', String(!open));
        if (open) setTimeout(() => input.focus(), 120);
    };
    launcher.addEventListener('click', () => toggle(!panel.classList.contains('open')));
    close.addEventListener('click', () => toggle(false));
    document.querySelectorAll('[data-assistant-action]').forEach(button => {
        button.addEventListener('click', () => runAssistantAction(button.dataset.assistantAction));
    });
    if (rangeRun && dateFrom && dateTo) {
        const today = new Date().toISOString().slice(0, 10);
        dateFrom.value = today;
        dateTo.value = today;
        rangeRun.addEventListener('click', () => {
            addAssistantMessage(getBusinessRangeSummary(dateFrom.value, dateTo.value), 'assistant');
        });
    }
    form.addEventListener('submit', event => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        addAssistantMessage(question, 'user');
        input.value = '';
        setTimeout(() => addAssistantMessage(answerSystemQuestion(question), 'assistant'), 280);
    });
    addAssistantMessage('Hola. Estoy pendiente de la operación. Puedo resumir ingresos, tiempos activos, vencimientos, rangos de fechas y ayudarte a imprimir facturas.', 'assistant');
}

function addAssistantMessage(text, role) {
    const messages = document.getElementById('assistant-messages');
    const bubble = document.createElement('div');
    bubble.className = `assistant-message ${role}`;
    bubble.textContent = repairText(text);
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
}

function getTodayRecords() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return appState.records.filter(record => Number(record.startTime) >= start.getTime());
}

function getRecordsByDateRange(fromValue, toValue) {
    if (!fromValue || !toValue) return [];
    const from = new Date(`${fromValue}T00:00:00`);
    const to = new Date(`${toValue}T23:59:59.999`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
    return appState.records.filter(record => {
        const startTime = Number(record.startTime || 0);
        return startTime >= from.getTime() && startTime <= to.getTime();
    });
}

function getBusinessRangeSummary(fromValue, toValue) {
    const records = getRecordsByDateRange(fromValue, toValue);
    if (records === null) return 'Selecciona un rango válido: la fecha inicial debe ser anterior o igual a la fecha final.';
    if (!records.length) return `No hay registros entre ${fromValue} y ${toValue}.`;
    const income = records.reduce((sum, record) => sum + Number(record.price || 0), 0);
    const active = records.filter(record => record.isActive).length;
    const finished = records.length - active;
    const serviceCounts = records.reduce((acc, record) => {
        const label = repairText(record.serviceName || `${Number(record.durationMinutes || 0)} min`);
        acc[label] = (acc[label] || 0) + 1;
        return acc;
    }, {});
    const topService = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0];
    const average = income / records.length;
    return `Del ${fromValue} al ${toValue}: ${records.length} servicios, ${formatCurrency(income)} en ingresos, promedio ${formatCurrency(average)} por servicio, ${finished} finalizados y ${active} activos. Servicio más vendido: ${topService[0]} (${topService[1]}).`;
}

function runAssistantAction(action) {
    if (action === 'invoice') {
        const latest = [...appState.records].sort((a, b) => b.startTime - a.startTime)[0];
        if (latest) printReceipt(latest.id);
        else addAssistantMessage('Todavía no hay registros disponibles para imprimir.', 'assistant');
        return;
    }
    if (action === 'range') {
        const rangePanel = document.getElementById('assistant-range-panel');
        if (rangePanel) rangePanel.hidden = !rangePanel.hidden;
        if (!rangePanel?.hidden) addAssistantMessage('Selecciona fecha inicial y final para analizar el negocio en ese rango.', 'assistant');
        return;
    }
    const prompts = { summary: 'Dame el resumen de hoy', active: '¿Quién está en la piscina?', income: '¿Cuánto hemos vendido hoy?' };
    addAssistantMessage(answerSystemQuestion(prompts[action]), 'assistant');
}

function answerSystemQuestion(question) {
    const q = normalizeSearchText(question);
    const today = getTodayRecords();
    const active = appState.records.filter(record => record.isActive);
    const expired = active.filter(record => record.endTime <= Date.now());
    const income = today.reduce((sum, record) => sum + Number(record.price || 0), 0);
    if (/ingreso|venta|recaud|dinero|cuanto/.test(q)) return `Hoy van ${formatCurrency(income)} en ${today.length} ingresos. El promedio por servicio es ${formatCurrency(today.length ? income / today.length : 0)}.`;
    if (/venc|termin|alert/.test(q)) return expired.length ? `Hay ${expired.length} tiempo${expired.length === 1 ? '' : 's'} vencido${expired.length === 1 ? '' : 's'}: ${expired.map(item => repairText(item.kidName)).join(', ')}.` : 'Todo está al día: no hay tiempos vencidos en este momento.';
    if (/quien|piscina|activ|nin/.test(q)) return active.length ? `Ahora hay ${active.length} niño${active.length === 1 ? '' : 's'} en la piscina: ${active.map(item => repairText(item.kidName)).join(', ')}.` : 'La piscina está libre en este momento.';
    if (/resumen|hoy|estado/.test(q)) return `Resumen de hoy: ${today.length} servicios, ${formatCurrency(income)} en ingresos, ${active.length} activos y ${expired.length} pendientes de confirmar.`;
    return 'Puedo ayudarte con ingresos de hoy, niños activos, tiempos vencidos, rangos de fechas, un resumen operativo o la factura del registro más reciente.';
}

// Boot up
document.addEventListener('DOMContentLoaded', init);
