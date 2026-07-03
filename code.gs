const SHEETS = {
  users: 'Users',
  records: 'Records',
  services: 'Services',
  sections: 'Sections',
  settings: 'Settings',
  pushSubscriptions: 'PushSubscriptions'
};

const SESSION_HOURS = 12;
const WEB_PUSH_PUBLIC_KEY = '';
const WEB_PUSH_RELAY_URL = '';
const WEB_PUSH_RELAY_TOKEN = '';
const PUSH_DEDUPE_KEY = 'PISCINA_PUSH_ALERTED_IDS';
let SETUP_READY = false;

function doGet(e) {
  return handleRequest_(e);
}

function doPost(e) {
  return handleRequest_(e);
}

function handleRequest_(e) {
  try {
    const payload = parsePayload_(e);
    const action = payload.action || (e.parameter && e.parameter.action);
    setup_();

    if (action === 'health') return json_({ ok: true, needsSetup: !hasUsers_() });
    if (action === 'login') return json_(login_(payload));

    const user = requireAuth_(payload.token);

    switch (action) {
      case 'bootstrap':
        return json_({ ok: true, needsSetup: false, user: publicUser_(user), records: getRecords_(), users: getUsers_().map(publicUser_), settings: getSettings_(), services: getServices_(), sections: getSections_() });
      case 'createRecord':
        touchUser_(user);
        return json_({ ok: true, record: createRecord_(payload.record) });
      case 'updateRecord':
        touchUser_(user);
        return json_({ ok: true, record: updateRecord_(payload.record) });
      case 'finishRecord':
        touchUser_(user);
        return json_({ ok: true, record: finishRecord_(payload.id) });
      case 'finishRecordsBatch':
        touchUser_(user);
        return json_({ ok: true, ...finishRecordsBatch_(payload.items || []) });
      case 'deleteRecord':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, id: deleteRecord_(payload.id) });
      case 'listUsers':
        requireAdmin_(user);
        return json_({ ok: true, users: getUsers_().map(publicUser_) });
      case 'createUser':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, user: publicUser_(createUser_(payload.user)) });
      case 'setUserAccess':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, user: publicUser_(setUserAccess_(payload.id, payload.active)) });
      case 'deleteUser':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, id: deleteUser_(payload.id, user) });
      case 'resetUserPassword':
        requireAdmin_(user);
        touchUser_(user);
        return json_(resetUserPassword_(payload.id, user, payload.tempPassword));
      case 'changeOwnPassword':
        touchUser_(user);
        return json_({ ok: true, user: publicUser_(changeOwnPassword_(user, payload.currentPassword, payload.newPassword)) });
      case 'saveSettings':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, settings: saveSettings_(payload.settings || {}) });
      case 'saveService':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, services: getServicesAfterSave_(payload.service || {}) });
      case 'deleteService':
        requireAdmin_(user);
        touchUser_(user);
        deleteService_(payload.id);
        return json_({ ok: true, services: getServices_() });
      case 'saveSection':
        requireAdmin_(user);
        touchUser_(user);
        return json_({ ok: true, sections: getSectionsAfterSave_(payload.section || {}) });
      case 'deleteSection':
        requireAdmin_(user);
        touchUser_(user);
        deleteSection_(payload.id);
        return json_({ ok: true, sections: getSections_() });
      case 'verifySectionPassword':
        touchUser_(user);
        return json_({ ok: true, valid: verifySectionPassword_(payload.id, payload.password) });
      case 'savePushSubscription':
        touchUser_(user);
        return json_({ ok: true, subscription: savePushSubscription_(payload.subscription, user) });
      case 'getPushConfig':
        touchUser_(user);
        return json_(getPushConfig_());
      case 'sendExpiredPushAlerts':
        touchUser_(user);
        return json_(sendExpiredPushAlerts_(payload.recordIds || []));
      default:
        throw new Error('Accion no soportada');
    }
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

function checkExpiredAndPush() {
  setup_();
  return sendExpiredPushAlerts_([]);
}

function getPushConfig_() {
  return {
    ok: true,
    publicKey: getPushPublicKey_(),
    relayReady: !!getPushRelayUrl_()
  };
}

function getPushPublicKey_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_PUSH_PUBLIC_KEY') || WEB_PUSH_PUBLIC_KEY;
}

function getPushRelayUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_PUSH_RELAY_URL') || WEB_PUSH_RELAY_URL;
}

function getPushRelayToken_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_PUSH_RELAY_TOKEN') || WEB_PUSH_RELAY_TOKEN;
}

function setup_() {
  if (SETUP_READY) return;
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  if (props.getProperty('PISCINA_SETUP_SEEDED_V4') === 'true') {
    SETUP_READY = true;
    return;
  }
  ensureSheet_(ss, SHEETS.users, ['id', 'email', 'passwordHash', 'role', 'active', 'createdAt', 'lastLoginAt', 'token', 'tokenExpiresAt', 'activityCount', 'lastActivityAt']);
  ensureSheet_(ss, SHEETS.records, ['id', 'kidName', 'parentName', 'parentPhone', 'durationMinutes', 'price', 'startTime', 'endTime', 'isActive', 'createdAt', 'updatedAt', 'serviceId', 'serviceName', 'sectionId', 'sectionName']);
  ensureSheet_(ss, SHEETS.services, ['id', 'name', 'durationMinutes', 'price', 'active', 'createdAt', 'updatedAt']);
  ensureSheet_(ss, SHEETS.sections, ['id', 'name', 'active', 'passwordHash', 'createdAt', 'updatedAt']);
  ensureSheet_(ss, SHEETS.settings, ['key', 'value', 'updatedAt']);
  ensureSheet_(ss, SHEETS.pushSubscriptions, ['endpoint', 'subscriptionJson', 'userId', 'createdAt', 'updatedAt', 'active']);
  seedDefaults_();
  props.setProperty('PISCINA_SETUP_SEEDED_V4', 'true');
  SETUP_READY = true;
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);

  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeaders = headers.some((h, i) => current[i] !== h);
  if (needsHeaders) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function seedDefaults_() {
  if (getServices_().length === 0) {
    [
      { id: 'svc_15', name: '15 Minutos', durationMinutes: 15, price: 5000, active: true },
      { id: 'svc_30', name: '30 Minutos', durationMinutes: 30, price: 8000, active: true },
      { id: 'svc_60', name: '1 Hora', durationMinutes: 60, price: 15000, active: true }
    ].forEach(service => saveService_(service));
  }
  const settings = getSettings_();
  if (!settings.appName) saveSettings_({ appName: 'PISCINA DE PELOTAS' });
  if (getSections_().length === 0) {
    saveSection_({ id: 'game_pool', name: 'Piscina de pelotas', active: true });
  }
}

function touchUser_(user) {
  user.activityCount = Number(user.activityCount || 0) + 1;
  user.lastActivityAt = Date.now();
  writeRow_(SHEETS.users, user._row, user);
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function rows_(sheetName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.filter(row => row.some(cell => cell !== '')).map((row, index) => {
    const item = { _row: index + 2 };
    headers.forEach((h, i) => item[h] = row[i]);
    return item;
  });
}

function hasUsers_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.users);
  return sheet && sheet.getLastRow() > 1;
}

function writeRow_(sheetName, rowNumber, obj) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([headers.map(h => obj[h] === undefined ? '' : obj[h])]);
}

function appendObj_(sheetName, obj) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(h => obj[h] === undefined ? '' : obj[h]));
}

function login_(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  if (!email || !password) throw new Error('Correo y contrasena son requeridos');

  const users = getUsers_();
  if (users.length === 0) {
    const now = Date.now();
    const firstAdmin = {
      id: uid_('usr'),
      email,
      passwordHash: hash_(password),
      role: 'admin',
      active: true,
      createdAt: now,
      lastLoginAt: now,
      token: token_(),
      tokenExpiresAt: now + SESSION_HOURS * 60 * 60 * 1000,
      activityCount: 1,
      lastActivityAt: now
    };
    appendObj_(SHEETS.users, firstAdmin);
    if (payload.fast === true) {
      return { ok: true, needsSetup: false, token: firstAdmin.token, user: publicUser_(firstAdmin) };
    }
    return { ok: true, needsSetup: false, token: firstAdmin.token, user: publicUser_(firstAdmin), records: getRecords_(), users: getUsers_().map(publicUser_), settings: getSettings_(), services: getServices_(), sections: getSections_() };
  }

  const user = users.find(u => String(u.email).toLowerCase() === email);
  if (!user || !user.active || user.passwordHash !== hash_(password)) throw new Error('Credenciales invalidas');

  user.token = token_();
  user.tokenExpiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  user.lastLoginAt = Date.now();
  user.activityCount = Number(user.activityCount || 0) + 1;
  user.lastActivityAt = Date.now();
  writeRow_(SHEETS.users, user._row, user);
  if (payload.fast === true) {
    return { ok: true, needsSetup: false, token: user.token, user: publicUser_(user) };
  }
  return { ok: true, needsSetup: false, token: user.token, user: publicUser_(user), records: getRecords_(), users: getUsers_().map(publicUser_), settings: getSettings_(), services: getServices_(), sections: getSections_() };
}

function requireAuth_(token) {
  const user = getUsers_().find(u => u.token === token && Number(u.tokenExpiresAt) > Date.now());
  if (!user || !user.active) throw new Error('Sesion no valida');
  return user;
}

function requireAdmin_(user) {
  if (user.role !== 'admin') throw new Error('Solo administradores');
}

function getUsers_() {
  return rows_(SHEETS.users).map(u => ({ ...u, active: u.active === true || u.active === 'TRUE' || u.active === 'true' }));
}

function publicUser_(u) {
  return { id: u.id, email: u.email, role: u.role, active: !!u.active, createdAt: Number(u.createdAt || 0), lastLoginAt: Number(u.lastLoginAt || 0), activityCount: Number(u.activityCount || 0), lastActivityAt: Number(u.lastActivityAt || 0) };
}

function getSettings_() {
  const settings = {};
  rows_(SHEETS.settings).forEach(row => {
    if (row.key) settings[row.key] = row.value;
  });
  return { appName: settings.appName || 'PISCINA DE PELOTAS' };
}

function saveSettings_(input) {
  const appName = String(input.appName || '').trim().slice(0, 48);
  if (!appName) throw new Error('Nombre de app requerido');
  upsertSetting_('appName', appName);
  return getSettings_();
}

function upsertSetting_(key, value) {
  const row = rows_(SHEETS.settings).find(item => item.key === key);
  const entry = { key, value, updatedAt: Date.now() };
  if (row) writeRow_(SHEETS.settings, row._row, entry);
  else appendObj_(SHEETS.settings, entry);
}

function getServices_() {
  return rows_(SHEETS.services).map(service => ({
    id: service.id,
    name: service.name,
    durationMinutes: Number(service.durationMinutes || 0),
    price: Number(service.price || 0),
    active: service.active === true || service.active === 'TRUE' || service.active === 'true',
    createdAt: Number(service.createdAt || 0),
    updatedAt: Number(service.updatedAt || 0)
  })).filter(service => service.id && service.durationMinutes > 0);
}

function getServicesAfterSave_(input) {
  saveService_(input);
  return getServices_();
}

function saveService_(input) {
  const now = Date.now();
  const id = String(input.id || uid_('svc'));
  const service = {
    id,
    name: String(input.name || '').trim(),
    durationMinutes: Number(input.durationMinutes || 0),
    price: Number(input.price || 0),
    active: input.active === undefined ? true : !!input.active,
    createdAt: Number(input.createdAt || now),
    updatedAt: now
  };
  if (!service.name) throw new Error('Nombre de tarifa requerido');
  if (service.durationMinutes <= 0) throw new Error('Duracion invalida');
  if (service.price < 0) throw new Error('Precio invalido');

  const existing = rows_(SHEETS.services).find(item => item.id === id);
  if (existing) {
    service.createdAt = Number(existing.createdAt || service.createdAt);
    writeRow_(SHEETS.services, existing._row, service);
  } else {
    appendObj_(SHEETS.services, service);
  }
  return service;
}

function deleteService_(id) {
  const service = rows_(SHEETS.services).find(item => item.id === id);
  if (!service) throw new Error('Tarifa no encontrada');
  SpreadsheetApp.getActive().getSheetByName(SHEETS.services).deleteRow(service._row);
  return id;
}

function getSections_() {
  return rows_(SHEETS.sections).map(section => ({
    id: section.id,
    name: section.name,
    active: section.active === true || section.active === 'TRUE' || section.active === 'true',
    hasPassword: !!section.passwordHash,
    createdAt: Number(section.createdAt || 0),
    updatedAt: Number(section.updatedAt || 0)
  })).filter(section => section.id && section.name).slice(0, 5);
}

function getSectionById_(id) {
  return rows_(SHEETS.sections).find(section => section.id === id);
}

function getDefaultSection_() {
  return getSections_()[0] || { id: 'game_pool', name: 'Piscina de pelotas', active: true };
}

function getSectionsAfterSave_(input) {
  saveSection_(input);
  return getSections_();
}

function saveSection_(input) {
  const now = Date.now();
  const existing = input.id ? getSectionById_(input.id) : null;
  if (!existing && getSections_().length >= 5) throw new Error('Maximo 5 secciones');
  const section = {
    id: String(input.id || uid_('game')),
    name: String(input.name || '').trim().slice(0, 36),
    active: input.active === undefined ? true : !!input.active,
    passwordHash: String(input.password ? hash_(input.password) : input.passwordHash || existing && existing.passwordHash || ''),
    createdAt: Number(existing && existing.createdAt || input.createdAt || now),
    updatedAt: now
  };
  if (!section.name) throw new Error('Nombre de seccion requerido');
  if (existing) writeRow_(SHEETS.sections, existing._row, section);
  else appendObj_(SHEETS.sections, section);
  return section;
}

function deleteSection_(id) {
  const sections = getSections_();
  if (sections.length <= 1) throw new Error('Debe existir al menos una seccion');
  if (getRecords_().some(record => record.sectionId === id)) throw new Error('La seccion tiene registros');
  const section = getSectionById_(id);
  if (!section) throw new Error('Seccion no encontrada');
  SpreadsheetApp.getActive().getSheetByName(SHEETS.sections).deleteRow(section._row);
  return id;
}

function verifySectionPassword_(id, password) {
  const section = getSectionById_(id);
  if (!section) throw new Error('Seccion no encontrada');
  const hash = String(section.passwordHash || '');
  if (!hash) return true;
  return hash === hash_(String(password || ''));
}

function createUser_(input) {
  const email = String(input && input.email || '').trim().toLowerCase();
  const password = String(input && input.password || '');
  const role = input && input.role === 'admin' ? 'admin' : 'user';
  if (!email || !password) throw new Error('Correo y contrasena son requeridos');
  if (getUsers_().some(u => String(u.email).toLowerCase() === email)) throw new Error('El usuario ya existe');

  const user = { id: uid_('usr'), email, passwordHash: hash_(password), role, active: true, createdAt: Date.now(), lastLoginAt: '', token: '', tokenExpiresAt: '', activityCount: 0, lastActivityAt: '' };
  appendObj_(SHEETS.users, user);
  return getUsers_().find(u => u.id === user.id) || user;
}

function setUserAccess_(id, active) {
  const user = getUsers_().find(u => u.id === id);
  if (!user) throw new Error('Usuario no encontrado');
  if (user.role === 'admin' && active === false) throw new Error('No puedes desactivar el admin principal');
  user.active = !!active;
  if (!user.active) {
    user.token = '';
    user.tokenExpiresAt = '';
  }
  writeRow_(SHEETS.users, user._row, user);
  return user;
}

function deleteUser_(id, currentUser) {
  const user = getUsers_().find(u => u.id === id);
  if (!user) throw new Error('Usuario no encontrado');
  if (user.id === currentUser.id) throw new Error('No puedes eliminar tu propia sesion');
  if (user.role === 'admin') throw new Error('No puedes eliminar administradores');
  SpreadsheetApp.getActive().getSheetByName(SHEETS.users).deleteRow(user._row);
  return id;
}

function resetUserPassword_(id, currentUser, requestedPassword) {
  const user = getUsers_().find(u => u.id === id);
  if (!user) throw new Error('Usuario no encontrado');
  if (user.id === currentUser.id) throw new Error('Usa cambiar clave para tu propia cuenta');
  if (user.role === 'admin') throw new Error('No puedes recuperar claves de administradores');
  const tempPassword = normalizeTempPassword_(requestedPassword) || tempPassword_();
  user.passwordHash = hash_(tempPassword);
  user.token = '';
  user.tokenExpiresAt = '';
  writeRow_(SHEETS.users, user._row, user);
  return { ok: true, user: publicUser_(user), tempPassword };
}

function changeOwnPassword_(user, currentPassword, newPassword) {
  const current = String(currentPassword || '');
  const next = String(newPassword || '');
  if (!current || !next) throw new Error('Clave actual y clave nueva son requeridas');
  if (next.length < 4) throw new Error('La clave nueva debe tener minimo 4 caracteres');
  const freshUser = getUsers_().find(u => u.id === user.id);
  if (!freshUser || freshUser.passwordHash !== hash_(current)) throw new Error('La clave actual no coincide');
  freshUser.passwordHash = hash_(next);
  writeRow_(SHEETS.users, freshUser._row, freshUser);
  return freshUser;
}

function getRecords_() {
  return rows_(SHEETS.records).map(r => ({
    id: r.id,
    kidName: r.kidName,
    parentName: r.parentName,
    parentPhone: String(r.parentPhone || ''),
    durationMinutes: Number(r.durationMinutes || 0),
    price: Number(r.price || 0),
    startTime: Number(r.startTime || 0),
    endTime: Number(r.endTime || 0),
    isActive: r.isActive === true || r.isActive === 'TRUE' || r.isActive === 'true',
    createdAt: Number(r.createdAt || 0),
    updatedAt: Number(r.updatedAt || 0)
    ,
    serviceId: r.serviceId || '',
    serviceName: r.serviceName || '',
    sectionId: r.sectionId || 'game_pool',
    sectionName: r.sectionName || 'Piscina de pelotas'
  }));
}

function createRecord_(input) {
  const now = Date.now();
  const service = input.serviceId ? getServices_().find(item => item.id === input.serviceId && item.active) : null;
  const section = input.sectionId ? getSections_().find(item => item.id === input.sectionId && item.active) : getDefaultSection_();
  if (input.sectionId && !section) throw new Error('Seccion no valida');
  const record = {
    id: input.id || uid_('rec'),
    kidName: String(input.kidName || '').trim(),
    parentName: String(input.parentName || '').trim(),
    parentPhone: String(input.parentPhone || '').trim(),
    durationMinutes: service ? service.durationMinutes : Number(input.durationMinutes || 0),
    price: service ? service.price : Number(input.price || 0),
    startTime: Number(input.startTime || now),
    endTime: Number(input.endTime || now),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    serviceId: service ? service.id : String(input.serviceId || ''),
    serviceName: service ? service.name : String(input.serviceName || '').trim(),
    sectionId: section ? section.id : 'game_pool',
    sectionName: section ? section.name : 'Piscina de pelotas'
  };
  record.endTime = record.startTime + (record.durationMinutes * 60 * 1000);
  appendObj_(SHEETS.records, record);
  return record;
}

function updateRecord_(input) {
  const record = rows_(SHEETS.records).find(r => r.id === input.id);
  if (!record) throw new Error('Registro no encontrado');
  ['kidName', 'parentName', 'parentPhone', 'durationMinutes', 'startTime', 'endTime', 'isActive', 'sectionId', 'sectionName'].forEach(key => {
    if (input[key] !== undefined) record[key] = input[key];
  });
  if (input.sectionId && input.sectionId !== record.sectionId) {
    const section = getSections_().find(item => item.id === input.sectionId && item.active);
    if (!section) throw new Error('Seccion no valida');
    record.sectionId = section.id;
    record.sectionName = section.name;
  }
  if (input.serviceId && input.serviceId !== record.serviceId) {
    const service = getServices_().find(item => item.id === input.serviceId && item.active);
    if (!service) throw new Error('Tarifa no valida');
    record.serviceId = service.id;
    record.serviceName = service.name;
    record.durationMinutes = service.durationMinutes;
    record.price = service.price;
    record.endTime = Number(record.startTime || Date.now()) + (service.durationMinutes * 60 * 1000);
  }
  record.updatedAt = Date.now();
  writeRow_(SHEETS.records, record._row, record);
  return record;
}

function finishRecord_(id) {
  const record = rows_(SHEETS.records).find(r => r.id === id);
  if (!record) throw new Error('Registro no encontrado');
  record.isActive = false;
  record.updatedAt = Date.now();
  writeRow_(SHEETS.records, record._row, record);
  return record;
}

function finishRecordsBatch_(items) {
  if (!Array.isArray(items) || !items.length) return { succeeded: [], failed: [] };
  if (items.length > 100) throw new Error('El lote supera el máximo de 100 registros');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.records);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const idCol = headers.indexOf('id');
    const activeCol = headers.indexOf('isActive');
    const updatedCol = headers.indexOf('updatedAt');
    if (idCol < 0 || activeCol < 0 || updatedCol < 0) throw new Error('Estructura de registros invalida');
    const rowById = {};
    for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
      const id = values[rowIndex][idCol];
      if (id) rowById[id] = rowIndex;
    }
    const succeeded = [];
    const failed = [];
    const now = Date.now();

    items.forEach(item => {
      const id = String(item && item.id || '');
      const rowIndex = rowById[id];
      if (!rowIndex) {
        failed.push({ id, error: 'Registro no encontrado' });
        return;
      }
      // La operación es idempotente: repetirla conserva el registro finalizado.
      values[rowIndex][activeCol] = false;
      values[rowIndex][updatedCol] = now;
      succeeded.push(id);
    });
    if (succeeded.length) {
      sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    }
    return { succeeded, failed };
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord_(id) {
  const record = rows_(SHEETS.records).find(r => r.id === id);
  if (!record) throw new Error('Registro no encontrado');
  SpreadsheetApp.getActive().getSheetByName(SHEETS.records).deleteRow(record._row);
  return id;
}

function savePushSubscription_(subscription, user) {
  if (!subscription || !subscription.endpoint) throw new Error('Suscripcion push invalida');
  ensureSheet_(SpreadsheetApp.getActive(), SHEETS.pushSubscriptions, ['endpoint', 'subscriptionJson', 'userId', 'createdAt', 'updatedAt', 'active']);
  const now = Date.now();
  const endpoint = String(subscription.endpoint);
  const entry = {
    endpoint,
    subscriptionJson: JSON.stringify(subscription),
    userId: user.id,
    createdAt: now,
    updatedAt: now,
    active: true
  };
  const existing = rows_(SHEETS.pushSubscriptions).find(item => item.endpoint === endpoint);
  if (existing) {
    entry.createdAt = Number(existing.createdAt || now);
    writeRow_(SHEETS.pushSubscriptions, existing._row, entry);
  } else {
    appendObj_(SHEETS.pushSubscriptions, entry);
  }
  return { endpoint, active: true };
}

function sendExpiredPushAlerts_(recordIds) {
  const expired = getPushEligibleExpiredRecords_(recordIds || []);
  if (!expired.length) return { ok: true, sent: 0, reason: 'sin vencidos nuevos' };

  const subscriptions = getActivePushSubscriptions_();
  if (!subscriptions.length) return { ok: true, sent: 0, pending: expired.length, reason: 'sin suscripciones push' };

  const payload = {
    title: expired.length === 1 ? 'Tiempo terminado' : 'Tiempos terminados',
    body: buildExpiredPushBody_(expired),
    tag: 'piscina-alert-' + expired.map(record => record.id).join('-').slice(0, 80),
    url: './index.html'
  };

  const result = deliverPushThroughRelay_(subscriptions, payload);
  if (result.ok) rememberPushedRecords_(expired.map(record => record.id));
  return { ok: true, sent: result.sent || 0, failed: result.failed || 0, pending: expired.length, relayReady: result.ok };
}

function getPushEligibleExpiredRecords_(recordIds) {
  const now = Date.now();
  const selected = (recordIds || []).filter(Boolean).map(String);
  const selectedSet = selected.length ? selected.reduce((acc, id) => (acc[id] = true, acc), {}) : null;
  const pushed = getPushedRecordMap_();
  return getRecords_().filter(record => {
    if (!record.isActive || Number(record.endTime || 0) > now) return false;
    if (selectedSet && !selectedSet[record.id]) return false;
    return !pushed[record.id];
  });
}

function getActivePushSubscriptions_() {
  ensureSheet_(SpreadsheetApp.getActive(), SHEETS.pushSubscriptions, ['endpoint', 'subscriptionJson', 'userId', 'createdAt', 'updatedAt', 'active']);
  return rows_(SHEETS.pushSubscriptions)
    .filter(row => row.active === true || row.active === 'TRUE' || row.active === 'true')
    .map(row => {
      try {
        return JSON.parse(row.subscriptionJson || '{}');
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function buildExpiredPushBody_(records) {
  const names = records.slice(0, 3).map(record => record.kidName || 'Cliente').join(', ');
  const extra = records.length > 3 ? ' y ' + (records.length - 3) + ' mas' : '';
  return names + extra + (records.length === 1 ? ' ya finalizo su tiempo.' : ' ya finalizaron su tiempo.');
}

function deliverPushThroughRelay_(subscriptions, payload) {
  const relayUrl = getPushRelayUrl_();
  const relayToken = getPushRelayToken_();
  if (!relayUrl) return { ok: false, sent: 0, failed: 0, reason: 'relay no configurado' };
  const response = UrlFetchApp.fetch(relayUrl, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: relayToken ? { Authorization: 'Bearer ' + relayToken } : {},
    payload: JSON.stringify({ subscriptions, notification: payload })
  });
  const code = response.getResponseCode();
  let body = {};
  try {
    body = JSON.parse(response.getContentText() || '{}');
  } catch (error) {}
  return {
    ok: code >= 200 && code < 300,
    sent: Number(body.sent || subscriptions.length || 0),
    failed: Number(body.failed || 0),
    status: code
  };
}

function getPushedRecordMap_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PUSH_DEDUPE_KEY) || '[]';
  let ids = [];
  try {
    ids = JSON.parse(raw);
  } catch (error) {}
  return ids.reduce((acc, id) => (acc[id] = true, acc), {});
}

function rememberPushedRecords_(ids) {
  const pushed = getPushedRecordMap_();
  ids.forEach(id => pushed[id] = true);
  const compact = Object.keys(pushed).slice(-500);
  PropertiesService.getScriptProperties().setProperty(PUSH_DEDUPE_KEY, JSON.stringify(compact));
}

function hash_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function uid_(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function token_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

function tempPassword_() {
  const digits = [];
  while (digits.length < 3) {
    const digit = Math.floor(Math.random() * 10);
    if (digits.indexOf(digit) === -1) digits.push(digit);
  }
  return 'Sansil' + digits.join('');
}

function normalizeTempPassword_(value) {
  const password = String(value || '').trim();
  if (!/^Sansil(\d)(\d)(\d)$/.test(password)) return '';
  const digits = password.slice(-3).split('');
  if (digits[0] === digits[1] || digits[0] === digits[2] || digits[1] === digits[2]) return '';
  return password;
}
