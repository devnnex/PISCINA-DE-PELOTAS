const SHEETS = {
  users: 'Users',
  records: 'Records'
};

const SESSION_HOURS = 12;

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

    if (action === 'health') return json_({ ok: true, needsSetup: getUsers_().length === 0 });
    if (action === 'login') return json_(login_(payload));

    const user = requireAuth_(payload.token);

    switch (action) {
      case 'bootstrap':
        return json_({ ok: true, needsSetup: false, user: publicUser_(user), records: getRecords_(), users: getUsers_().map(publicUser_) });
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
      default:
        throw new Error('Accion no soportada');
    }
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

function setup_() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, SHEETS.users, ['id', 'email', 'passwordHash', 'role', 'active', 'createdAt', 'lastLoginAt', 'token', 'tokenExpiresAt', 'activityCount', 'lastActivityAt']);
  ensureSheet_(ss, SHEETS.records, ['id', 'kidName', 'parentName', 'parentPhone', 'durationMinutes', 'price', 'startTime', 'endTime', 'isActive', 'createdAt', 'updatedAt']);
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

  if (getUsers_().length === 0) {
    const firstAdmin = createUser_({ email, password, role: 'admin' });
    firstAdmin.token = token_();
    firstAdmin.tokenExpiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
    firstAdmin.lastLoginAt = Date.now();
    firstAdmin.activityCount = 1;
    firstAdmin.lastActivityAt = Date.now();
    writeRow_(SHEETS.users, firstAdmin._row, firstAdmin);
    return { ok: true, needsSetup: false, token: firstAdmin.token, user: publicUser_(firstAdmin), records: getRecords_(), users: getUsers_().map(publicUser_) };
  }

  const user = getUsers_().find(u => String(u.email).toLowerCase() === email);
  if (!user || !user.active || user.passwordHash !== hash_(password)) throw new Error('Credenciales invalidas');

  user.token = token_();
  user.tokenExpiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  user.lastLoginAt = Date.now();
  user.activityCount = Number(user.activityCount || 0) + 1;
  user.lastActivityAt = Date.now();
  writeRow_(SHEETS.users, user._row, user);
  return { ok: true, needsSetup: false, token: user.token, user: publicUser_(user), records: getRecords_(), users: getUsers_().map(publicUser_) };
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
  }));
}

function createRecord_(input) {
  const now = Date.now();
  const record = {
    id: input.id || uid_('rec'),
    kidName: String(input.kidName || '').trim(),
    parentName: String(input.parentName || '').trim(),
    parentPhone: String(input.parentPhone || '').trim(),
    durationMinutes: Number(input.durationMinutes || 0),
    price: Number(input.price || 0),
    startTime: Number(input.startTime || now),
    endTime: Number(input.endTime || now),
    isActive: true,
    createdAt: now,
    updatedAt: now
  };
  appendObj_(SHEETS.records, record);
  return record;
}

function updateRecord_(input) {
  const record = rows_(SHEETS.records).find(r => r.id === input.id);
  if (!record) throw new Error('Registro no encontrado');
  ['kidName', 'parentName', 'parentPhone', 'durationMinutes', 'price', 'startTime', 'endTime', 'isActive'].forEach(key => {
    if (input[key] !== undefined) record[key] = input[key];
  });
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
    const records = rows_(SHEETS.records);
    const byId = {};
    records.forEach(record => byId[record.id] = record);
    const succeeded = [];
    const failed = [];
    const now = Date.now();

    items.forEach(item => {
      const id = String(item && item.id || '');
      const record = byId[id];
      if (!record) {
        failed.push({ id, error: 'Registro no encontrado' });
        return;
      }
      // La operación es idempotente: repetirla conserva el registro finalizado.
      record.isActive = false;
      record.updatedAt = now;
      writeRow_(SHEETS.records, record._row, record);
      succeeded.push(id);
    });
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
