const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'planilhas';

let client = null;

function getClient() {
  if (!client && SUPABASE_URL && SUPABASE_KEY) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
}

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function initBucket() {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !error.message.includes('already exists')) {
    console.warn('[supabase] bucket error:', error.message);
  }
}

async function uploadFile(key, bytes, meta) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(key, bytes, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });
  if (error) throw error;
  const current = await loadJson('_files_meta.json') || {};
  current[key] = meta;
  await saveJson('_files_meta.json', current);
}

async function downloadFile(key) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(key);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function getFilesMeta() {
  return (await loadJson('_files_meta.json')) || {};
}

async function deleteAllFiles(keys) {
  const sb = getClient();
  if (!sb) return;
  const toRemove = [...keys, '_files_meta.json'];
  const { error } = await sb.storage.from(BUCKET).remove(toRemove);
  if (error) console.warn('[supabase] delete error:', error.message);
}

async function getMetas(defaults) {
  const stored = await loadJson('_metas.json');
  return stored || defaults;
}

async function saveMetas(metas) {
  await saveJson('_metas.json', metas);
}

async function loadJson(filename) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(filename);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text());
  } catch {
    return null;
  }
}

async function saveJson(filename, obj) {
  const sb = getClient();
  if (!sb) return;
  const buf = Buffer.from(JSON.stringify(obj), 'utf-8');
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(filename, buf, { contentType: 'application/json', upsert: true });
  if (error) console.warn('[supabase] saveJson error:', error.message);
}

async function getStoreMetas() {
  return (await loadJson('_store_metas.json')) || {};
}

async function saveStoreMetas(data) {
  await saveJson('_store_metas.json', data);
}

async function getSellerMetas() {
  return (await loadJson('_seller_metas.json')) || {};
}

async function saveSellerMetas(data) {
  await saveJson('_seller_metas.json', data);
}

module.exports = {
  isConfigured, initBucket,
  uploadFile, downloadFile, getFilesMeta, deleteAllFiles,
  getMetas, saveMetas,
  getStoreMetas, saveStoreMetas,
  getSellerMetas, saveSellerMetas,
};
