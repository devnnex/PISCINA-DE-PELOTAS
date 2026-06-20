const API_URL = 'https://script.google.com/macros/s/AKfycbxNeIVBnX9P28-nJWRD1YenwNyhj5jMaw35Ypl_8vqtcGXkZvT3k4u8u06wuUkYR7yhYA/exec';

// State Management
let appState = {
    records: JSON.parse(localStorage.getItem('piscinaRecords')) || [],
    users: [],
    token: localStorage.getItem('piscinaToken') || '',
    currentUser: null,
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
    syncRetryTimer: null
};

function saveState() {
    localStorage.setItem('piscinaRecords', JSON.stringify(appState.records));
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

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: appState.token, ...data })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Error en el API');
    return result;
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
    if (result.users) {
        appState.users = result.users;
        renderUsers();
    }
    if (result.user) appState.currentUser = result.user;
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

// Edit Modal Elements
const editModal = document.getElementById('edit-modal');
const editKidForm = document.getElementById('edit-kid-form');
const cancelEditBtn = document.getElementById('cancel-edit');

// Initialize
async function init() {
    applyTheme();
    setupThemeToggle();
    unlockAlarmOnFirstGesture();
    setupAuth();
    setupNavigation();
    setupForms();
    setupActiveSearch();
    setupAdminFilters();
    setupUserAdmin();
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

function unlockAlarmOnFirstGesture() {
    const unlock = () => {
        alarmAudio.volume = 0.75;
        alarmAudio.play().then(() => {
            alarmAudio.pause();
            alarmAudio.currentTime = 0;
        }).catch(() => {});
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
        loginTitle.textContent = 'PISCINA DE PELOTAS';
        loginSubtitle.textContent = 'Ingresa para gestionar tiempos, registros e ingresos.';
        loginSubmit.textContent = 'Entrar';
        document.getElementById('login-email').placeholder = 'correo@empresa.com';
        document.getElementById('login-password').placeholder = 'Tu contraseña';
    }
}

async function bootstrapApp() {
    if (!isRemoteMode()) {
        appState.currentUser = { email: 'local', role: 'admin', active: true };
        setAuthenticated(true);
        return;
    }

    if (!appState.token) {
        setLoading(true);
        try {
            const result = await apiRequest('health');
            applyRemoteState(result);
        } catch (err) {
            loginError.textContent = err.message;
        } finally {
            setLoading(false);
        }
        setAuthenticated(false);
        return;
    }

    setLoading(true);
    try {
        const result = await apiRequest('bootstrap');
        applyRemoteState(result);
        setAuthenticated(true);
    } catch (err) {
        localStorage.removeItem('piscinaToken');
        appState.token = '';
        setAuthenticated(false);
    } finally {
        setLoading(false);
    }
}

function setupAuth() {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        setLoading(true);
        try {
            const result = await apiRequest('login', {
                email: document.getElementById('login-email').value,
                password: document.getElementById('login-password').value
            });
            appState.token = result.token;
            localStorage.setItem('piscinaToken', result.token);
            applyRemoteState(result);
            setAuthenticated(true);
            renderActiveKids();
            updateAdminDashboard('today');
        } catch (err) {
            loginError.textContent = err.message;
        } finally {
            setLoading(false);
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
        const item = document.createElement('div');
        item.className = `user-item ${isLowActivity ? 'low-activity' : ''}`;
        item.innerHTML = `
            <div>
                <strong>${escapeHTML(user.email)}</strong>
                <span>${user.role} • ${user.active ? 'Activo' : 'Sin acceso'} • ${activityCount} acciones</span>
                ${isLowActivity ? '<em class="sad-badge">Poca actividad</em>' : ''}
            </div>
            <button class="btn ${user.active ? 'btn-secondary' : 'btn-primary'}" onclick="toggleUserAccess('${user.id}', ${!user.active})">
                ${user.active ? 'Quitar acceso' : 'Activar'}
            </button>
        `;
        usersList.appendChild(item);
    });
}

function setupUserAdmin() {
    usersToggle.addEventListener('click', () => {
        usersPanel.classList.toggle('open');
        usersToggle.classList.toggle('open');
    });

    userForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!isRemoteMode()) {
            alert('Configura API_URL para crear usuarios en Google Sheets.');
            return;
        }
        setLoading(true);
        try {
            const result = await apiRequest('createUser', {
                user: {
                    email: document.getElementById('user-email').value,
                    password: document.getElementById('user-password').value
                }
            });
            appState.users.push(result.user);
            renderUsers();
            userForm.reset();
        } catch (err) {
            alert(err.message);
        } finally {
            setLoading(false);
        }
    });
}

window.toggleUserAccess = async function(id, active) {
    if (!isRemoteMode()) {
        alert('Configura API_URL para administrar usuarios.');
        return;
    }
    setLoading(true);
    try {
        const result = await apiRequest('setUserAccess', { id, active });
        appState.users = appState.users.map(user => user.id === id ? result.user : user);
        renderUsers();
    } catch (err) {
        alert(err.message);
    } finally {
        setLoading(false);
    }
};

const escapeHTML = (value) => {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[char]);
};

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
    addKidBtn.addEventListener('click', () => {
        regFormContainer.style.display = regFormContainer.style.display === 'none' ? 'block' : 'none';
        if (regFormContainer.style.display === 'block') {
            document.getElementById('kid-name').focus();
        }
    });

    cancelAddBtn.addEventListener('click', () => {
        regFormContainer.style.display = 'none';
        addKidForm.reset();
    });

    addKidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setLoading(true);
        
        const kidName = document.getElementById('kid-name').value;
        const parentName = document.getElementById('parent-name').value;
        const parentPhone = document.getElementById('parent-phone').value;
        const timeValStr = document.getElementById('time-select').value;
        
        const [durationMinutes, price] = timeValStr.split('|').map(Number);
        
        const now = Date.now();
        const endTime = now + (durationMinutes * 60 * 1000);
        
        const newRecord = {
            id: 'rec_' + now,
            kidName,
            parentName,
            parentPhone,
            durationMinutes,
            price,
            startTime: now,
            endTime: endTime,
            isActive: true
        };
        
        try {
            if (isRemoteMode()) {
                const result = await apiRequest('createRecord', { record: newRecord });
                appState.records.push(result.record);
            } else {
                appState.records.push(newRecord);
            }
            appState.activePage = 1;
            saveState();
            addKidForm.reset();
            regFormContainer.style.display = 'none';
            renderActiveKids();
            updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
        } catch (err) {
            alert(err.message);
        } finally {
            setLoading(false);
        }
    });

    // Edit Form
    cancelEditBtn.addEventListener('click', () => {
        editModal.style.display = 'none';
        editKidForm.reset();
    });

    editKidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setLoading(true);
        const id = document.getElementById('edit-id').value;
        const recordIndex = appState.records.findIndex(r => r.id === id);
        
        if (recordIndex !== -1) {
            try {
                appState.records[recordIndex].kidName = document.getElementById('edit-kid-name').value;
                appState.records[recordIndex].parentName = document.getElementById('edit-parent-name').value;
                appState.records[recordIndex].parentPhone = document.getElementById('edit-parent-phone').value;
                
                const extraTime = parseInt(document.getElementById('edit-extra-time').value) || 0;
                if (extraTime > 0) {
                    appState.records[recordIndex].durationMinutes += extraTime;
                    appState.records[recordIndex].endTime += (extraTime * 60 * 1000);
                }

                if (isRemoteMode()) {
                    const result = await apiRequest('updateRecord', { record: appState.records[recordIndex] });
                    appState.records[recordIndex] = result.record;
                }
                
                saveState();
                editModal.style.display = 'none';
                renderActiveKids();
                updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
            } catch (err) {
                alert(err.message);
            } finally {
                setLoading(false);
            }
            return;
        }
        setLoading(false);
    });
}

function setupActiveSearch() {
    activeSearchInput.addEventListener('input', () => {
        appState.activeSearchTerm = activeSearchInput.value.trim().toLowerCase();
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
        ? activeRecords.filter(record => {
            return record.kidName.toLowerCase().includes(searchTerm) ||
                   record.parentName.toLowerCase().includes(searchTerm) ||
                   record.parentPhone.toLowerCase().includes(searchTerm);
        })
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
        const card = document.createElement('div');
        const isSelected = appState.selectedExpiredIds.has(record.id);
        card.className = `kid-card ${isTimeUp ? 'time-up' : ''} ${isSelected ? 'selected' : ''}`;
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
                    ${isTimeUp ? `<i class="ph ph-bell-ringing bell-alert"></i> Alerta ${alertIndex}` : 'Activo'}
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

window.finishRecord = function(id) {
    if(confirm('¿Seguro que deseas marcar este tiempo como finalizado?')) {
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
    
    const searchTerm = searchInput.value.toLowerCase();
    
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
        let inSearch = true;
        if (searchTerm) {
            inSearch = r.kidName.toLowerCase().includes(searchTerm) || 
                       r.parentPhone.includes(searchTerm) ||
                       r.parentName.toLowerCase().includes(searchTerm);
        }

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
                <h4>${escapeHTML(r.kidName)} (${r.durationMinutes} min)</h4>
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
    if (!confirm('¿Seguro que deseas eliminar este registro del historial?')) return;
    setLoading(true);
    try {
        if (isRemoteMode()) await apiRequest('deleteRecord', { id });
        appState.records = appState.records.filter(record => record.id !== id);
        saveState();
        renderActiveKids();
        updateAdminDashboard(document.querySelector('.filter-btn.active').getAttribute('data-filter'));
    } catch (err) {
        alert(err.message);
    } finally {
        setLoading(false);
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
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>RECIBO ${escapeHTML(record.id)}</title>
<style>
  @page {
    size: A4;
    margin: 6mm;
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
    font-size: 30px;
    font-weight: 800;
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .recibo {
    width: 100%;
    min-height: 100vh;
    padding: 6mm;
  }

  .center {
    text-align: center;
  }

  .logo {
    max-width: 320px;
    margin: 0 auto 16px;
    display: block;
  }

  .title {
    font-size: 52px;
    font-weight: 900;
    margin-bottom: 6px;
  }

  .subtitle {
    font-size: 30px;
    font-weight: 800;
    margin-bottom: 22px;
  }

  .line {
    border-top: 4px dashed #000;
    margin: 22px 0;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 28px;
    margin: 14px 0;
    font-size: 32px;
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
    padding: 24px;
    margin-top: 26px;
  }

  .total-box .label {
    font-size: 30px;
  }

  .total {
    font-size: 64px;
    font-weight: 900;
    text-align: center;
    margin-top: 10px;
  }

  .footer {
    font-size: 26px;
    font-weight: 800;
    text-align: center;
    margin-top: 26px;
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
    <div class="title">PISCINA DE PELOTAS</div>
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
    <div class="value">${Number(record.durationMinutes || 0)} MIN</div>
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
        '<h1>PISCINA DE PELOTAS</h1><div class="subtitle">Comprobante de servicio</div><div class="dash"></div>' +
        '<div class="field">Factura: ' + escapeHTML(record.id) + '</div><div class="field">Fecha: ' + escapeHTML(started) + '</div><div class="field">Salida estimada: ' + escapeHTML(ended) + '</div><div class="dash"></div>' +
        '<div class="field"><strong>Niño:</strong> ' + escapeHTML(record.kidName) + '</div><div class="field"><strong>Responsable:</strong> ' + escapeHTML(record.parentName) + '</div><div class="field"><strong>Teléfono:</strong> ' + escapeHTML(record.parentPhone) + '</div>' +
        '<div class="dash"></div><div class="row"><span>Servicio (' + Number(record.durationMinutes) + ' min)</span><span>' + formatReceiptCurrency(record.price) + '</span></div>' +
        '<div class="dash"></div><div class="row total"><span>TOTAL</span><span>' + formatReceiptCurrency(record.price) + '</span></div>' +
        '<p class="thanks">¡Gracias por visitarnos!</p><div class="note">Documento informativo</div>' +
        '<script>window.onload=function(){setTimeout(function(){window.print()},120);window.onafterprint=function(){window.close()}}<\/script></body></html>';
}

window.printReceipt = function(id) {
    const record = appState.records.find(item => item.id === id);
    if (!record) return;
    const popup = window.open('', '_blank', 'width=1600,height=1800');
    if (!popup) {
        alert('Permite ventanas emergentes para imprimir el recibo.');
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
        alert('Permite ventanas emergentes para generar el PDF.');
        return;
    }
    const summary = getHistoryExportSummary(records);
    const generatedAt = new Date().toLocaleString('es-CO');
    const rows = records.map((record, index) => {
        const start = new Date(record.startTime).toLocaleString('es-CO');
        const end = new Date(record.endTime).toLocaleString('es-CO');
        return '<tr>' +
            '<td>' + (index + 1) + '</td>' +
            '<td><strong>' + escapeHTML(record.kidName) + '</strong><span>' + escapeHTML(record.id) + '</span></td>' +
            '<td>' + escapeHTML(record.parentName) + '</td>' +
            '<td>' + escapeHTML(record.parentPhone) + '</td>' +
            '<td>' + Number(record.durationMinutes || 0) + ' min</td>' +
            '<td>' + escapeHTML(start) + '</td>' +
            '<td>' + escapeHTML(end) + '</td>' +
            '<td>' + (record.isActive ? 'Activo' : 'Finalizado') + '</td>' +
            '<td class="money">' + formatCurrency(record.price) + '</td>' +
        '</tr>';
    }).join('');

    popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Historial Piscina de Pelotas</title><style>' +
        '@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:12px/1.45 Inter,Arial,sans-serif}' +
        '.page{max-width:1120px;margin:0 auto;padding:24px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:24px;border-radius:24px;color:#fff;background:linear-gradient(135deg,#001f3f,#15537c);box-shadow:0 20px 50px rgba(0,31,63,.18)}' +
        'h1{margin:0;font-size:30px;letter-spacing:-.6px}.meta{opacity:.86;margin-top:6px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.card{padding:14px;border-radius:18px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.08);border:1px solid #e8edf5}.label{font-size:10px;color:#667085;text-transform:uppercase;font-weight:800;letter-spacing:.7px}.value{font-size:22px;font-weight:900;margin-top:4px;color:#001f3f}' +
        'table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 14px 34px rgba(15,23,42,.08)}th{background:#eef4fb;color:#001f3f;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:10px;border-bottom:1px solid #dce7f3}td{padding:10px;border-bottom:1px solid #edf1f6;vertical-align:top}td span{display:block;color:#667085;font-size:10px;margin-top:2px}.money{text-align:right;font-weight:900;color:#001f3f;white-space:nowrap}tr:last-child td{border-bottom:0}.footer{text-align:center;color:#667085;margin-top:16px;font-size:11px}' +
        '@media print{body{background:#fff}.page{padding:0}.hero,.card,table{box-shadow:none}.hero{break-inside:avoid}.cards{break-inside:avoid}}' +
        '</style></head><body><main class="page">' +
        '<section class="hero"><div><h1>PISCINA DE PELOTAS</h1><div class="meta">Historial de registros · ' + escapeHTML(getHistoryFilterLabel(filterType)) + '</div></div><div class="meta">Generado: ' + escapeHTML(generatedAt) + '</div></section>' +
        '<section class="cards"><div class="card"><div class="label">Registros</div><div class="value">' + summary.totalRecords + '</div></div><div class="card"><div class="label">Ingresos</div><div class="value">' + formatCurrency(summary.totalIncome) + '</div></div><div class="card"><div class="label">Activos</div><div class="value">' + summary.activeCount + '</div></div></section>' +
        '<table><thead><tr><th>#</th><th>Niño / Factura</th><th>Responsable</th><th>Teléfono</th><th>Tiempo</th><th>Ingreso</th><th>Salida estimada</th><th>Estado</th><th>Valor</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="footer">Documento informativo generado desde el sistema de Piscina de Pelotas.</div>' +
        '<script>window.onload=function(){setTimeout(function(){window.print()},160)}<\/script></main></body></html>');
    popup.document.close();
}

function exportHistoryPdf() {
    const filterType = getCurrentHistoryFilterType();
    const records = getFilteredHistoryRecords(filterType);
    if (!records.length) {
        alert('No hay registros para exportar con el filtro actual.');
        return;
    }
    openPrintableHistoryReport(records, filterType);
}

function exportHistoryExcel() {
    const filterType = getCurrentHistoryFilterType();
    const records = getFilteredHistoryRecords(filterType);
    if (!records.length) {
        alert('No hay registros para exportar con el filtro actual.');
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
            '<td>' + Number(record.durationMinutes || 0) + '</td>' +
            '<td>' + escapeHTML(new Date(record.startTime).toLocaleString('es-CO')) + '</td>' +
            '<td>' + escapeHTML(new Date(record.endTime).toLocaleString('es-CO')) + '</td>' +
            '<td>' + (record.isActive ? 'Activo' : 'Finalizado') + '</td>' +
            '<td>' + Number(record.price || 0) + '</td>' +
        '</tr>';
    }).join('');
    const html = '<html><head><meta charset="utf-8"><style>' +
        'table{border-collapse:collapse;font-family:Arial,sans-serif}th{background:#001f3f;color:#fff;font-weight:700}td,th{border:1px solid #cfd8e3;padding:8px}tr:nth-child(even){background:#f5f8fc}.money{font-weight:700}' +
        '</style></head><body>' +
        '<table><tr><th colspan="10" style="font-size:18px;background:#001f3f;color:#fff;">PISCINA DE PELOTAS - Historial de registros</th></tr>' +
        '<tr><td colspan="10">Filtro: ' + escapeHTML(getHistoryFilterLabel(filterType)) + ' | Registros: ' + summary.totalRecords + ' | Ingresos: ' + formatCurrency(summary.totalIncome) + '</td></tr>' +
        '<tr><th>#</th><th>Factura</th><th>Niño</th><th>Responsable</th><th>Teléfono</th><th>Minutos</th><th>Ingreso</th><th>Salida estimada</th><th>Estado</th><th>Valor COP</th></tr>' +
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
    form.addEventListener('submit', event => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        addAssistantMessage(question, 'user');
        input.value = '';
        setTimeout(() => addAssistantMessage(answerSystemQuestion(question), 'assistant'), 280);
    });
    addAssistantMessage('Hola. Estoy pendiente de la operación. Puedo resumir ingresos, tiempos activos, vencimientos y ayudarte a imprimir facturas.', 'assistant');
}

function addAssistantMessage(text, role) {
    const messages = document.getElementById('assistant-messages');
    const bubble = document.createElement('div');
    bubble.className = `assistant-message ${role}`;
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
}

function getTodayRecords() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return appState.records.filter(record => Number(record.startTime) >= start.getTime());
}

function runAssistantAction(action) {
    if (action === 'invoice') {
        const latest = [...appState.records].sort((a, b) => b.startTime - a.startTime)[0];
        if (latest) printReceipt(latest.id);
        else addAssistantMessage('Todavía no hay registros disponibles para imprimir.', 'assistant');
        return;
    }
    const prompts = { summary: 'Dame el resumen de hoy', active: '¿Quién está en la piscina?', income: '¿Cuánto hemos vendido hoy?' };
    addAssistantMessage(answerSystemQuestion(prompts[action]), 'assistant');
}

function answerSystemQuestion(question) {
    const q = question.toLowerCase();
    const today = getTodayRecords();
    const active = appState.records.filter(record => record.isActive);
    const expired = active.filter(record => record.endTime <= Date.now());
    const income = today.reduce((sum, record) => sum + Number(record.price || 0), 0);
    if (/ingreso|venta|recaud|dinero|cu[aá]nto/.test(q)) return `Hoy van ${formatCurrency(income)} en ${today.length} ingresos. El promedio por servicio es ${formatCurrency(today.length ? income / today.length : 0)}.`;
    if (/venc|termin|alert/.test(q)) return expired.length ? `Hay ${expired.length} tiempo${expired.length === 1 ? '' : 's'} vencido${expired.length === 1 ? '' : 's'}: ${expired.map(item => item.kidName).join(', ')}.` : 'Todo está al día: no hay tiempos vencidos en este momento.';
    if (/qui[eé]n|piscina|activ|niñ/.test(q)) return active.length ? `Ahora hay ${active.length} niño${active.length === 1 ? '' : 's'} en la piscina: ${active.map(item => item.kidName).join(', ')}.` : 'La piscina está libre en este momento.';
    if (/resumen|hoy|estado/.test(q)) return `Resumen de hoy: ${today.length} servicios, ${formatCurrency(income)} en ingresos, ${active.length} activos y ${expired.length} pendientes de confirmar.`;
    return 'Puedo ayudarte con ingresos de hoy, niños activos, tiempos vencidos, un resumen operativo o la factura del registro más reciente.';
}

// Boot up
document.addEventListener('DOMContentLoaded', init);
