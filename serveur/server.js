//'use strict';
/* ==========================================================================
   Clic-One : serveur de la boutique en ligne (Node.js >= 18, aucune dépendance)
   - sert la vitrine (services) (dossier ../boutique)
   - API publique : catalogue, passer une commande, suivre une commande
   - API protégée (clé administrateur) : publier le catalogue, lire/mettre à jour les commandes
   Démarrage :  node serveur/server.js      (PORT, DATA_DIR, ADMIN_KEY facultatifs)
   ========================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

/* ---------- configuration : fichier .env (lecteur intégré, sans dépendance) ---------- */
(function loadEnv() {
  for (const f of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    t.split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || l.trim().startsWith('#')) return;
      let v = m[2]; if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;   // une variable déjà définie (hébergeur) reste prioritaire
    });
  }
})();
const PORT = Number(process.env.PORT) || 8080, ROOT = path.join(__dirname, '..', 'boutique'), DATA = process.env.DATA_DIR || path.join(__dirname, 'data');

/* ---------- stockage : MongoDB Atlas si MONGODB_URI est défini, sinon fichiers JSON locaux ----------
   Interface commune : getConfig/setConfig, getCatalogue/setCatalogue, getCommandes/saveCommande, getBackup/setBackup */
function fileStorage() {
  fs.mkdirSync(DATA, { recursive: true });
  const file = n => path.join(DATA, n), load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return d; } };
  const save = (n, v) => { const t = file(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, file(n)); };
  let cmds = null;
  return {
    kind: 'Fichiers locaux (' + DATA + ')',
    async getConfig() { return load('config.json', null); }, async setConfig(v) { save('config.json', v); },
    async getCatalogue() { return load('catalogue.json', { entreprise: {}, services: [], updatedAt: null }); }, async setCatalogue(c) { save('catalogue.json', c); },
    async savePhotos(numero, items) { save('photos_' + numero + '.json', items); }, async getPhotos(numero) { return load('photos_' + numero + '.json', []); },
    async getCommandes() { cmds = load('commandes.json', []); return cmds; }, async saveCommande(o) { if (!cmds) cmds = load('commandes.json', []); const i = cmds.findIndex(x => x.numero === o.numero); if (i >= 0) cmds[i] = o; else cmds.push(o); save('commandes.json', cmds); },
    async getBackup() { return load('sauvegarde.json', null); }, async setBackup(b) { save('sauvegarde.json', b); },
    async isEmpty() { return true; }, async close() { }
  };
}
async function mongoStorage(uri, dbName) {
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); } catch (e) { throw new Error('Le module « mongodb » n\'est pas installé : exécutez « npm install » à la racine du projet (là où se trouve package.json).'); }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, appName: 'clic-one' });
  await client.connect();
  const db = client.db(dbName), C = { config: db.collection('config'), meta: db.collection('meta'), services: db.collection('services'), commandes: db.collection('commandes'), photos: db.collection('photos'), sauvegardes: db.collection('sauvegardes') };
  await C.commandes.createIndex({ creeLe: 1 }).catch(() => { });
  const strip = ({ _id, ...r }) => r;
  return {
    kind: 'MongoDB Atlas (base « ' + dbName + ' »)',
    async getConfig() { const d = await C.config.findOne({ _id: 'main' }); return d ? d.value : null; },
    async setConfig(v) { await C.config.replaceOne({ _id: 'main' }, { _id: 'main', value: v }, { upsert: true }); },
    async getCatalogue() { const m = await C.meta.findOne({ _id: 'catalogue' }), sv = await C.services.find({}).sort({ nom: 1 }).toArray(); return { entreprise: m ? m.entreprise : {}, services: sv.map(strip), livraison: m ? m.livraison : { actif: false, zones: [] }, updatedAt: m ? m.updatedAt : null }; },
    async setCatalogue(c) {
      await C.meta.replaceOne({ _id: 'catalogue' }, { _id: 'catalogue', entreprise: c.entreprise, livraison: c.livraison, updatedAt: c.updatedAt }, { upsert: true });
      if (c.services.length) await C.services.bulkWrite(c.services.map(s => ({ replaceOne: { filter: { _id: s.id }, replacement: Object.assign({ _id: s.id }, s), upsert: true } })));
      await C.services.deleteMany({ _id: { $nin: c.services.map(s => s.id) } });
    },
    async getCommandes() { return (await C.commandes.find({}).sort({ creeLe: 1 }).toArray()).map(strip); },
    async saveCommande(o) { await C.commandes.replaceOne({ _id: o.numero }, Object.assign({ _id: o.numero }, o), { upsert: true }); },
    // une photo = un document (limite MongoDB de 16 Mo par document : une commande peut contenir 20 photos Full HD)
    async savePhotos(numero, items) { if (items.length) await C.photos.bulkWrite(items.map(p => ({ replaceOne: { filter: { _id: numero + ':' + p.id }, replacement: Object.assign({ _id: numero + ':' + p.id, numero }, p), upsert: true } }))); },
    async getPhotos(numero) { return (await C.photos.find({ numero }).toArray()).map(({ _id, numero: n, ...p }) => p).sort((x, y) => Number(String(x.id).slice(1)) - Number(String(y.id).slice(1))); },
    async getBackup() {
      const docs = await C.sauvegardes.find({}).toArray(); if (!docs.length) return null; const data = {}; let at = null, par = '';
      docs.forEach(d => { if (d._id === '_meta') { at = d.at; par = d.par; } else data[d._id] = d.value; }); return { at, par, data };
    },
    async setBackup(b) {
      const keys = Object.keys(b.data || {});
      const ops = keys.map(k => ({ replaceOne: { filter: { _id: k }, replacement: { _id: k, value: b.data[k] }, upsert: true } }));
      ops.push({ replaceOne: { filter: { _id: '_meta' }, replacement: { _id: '_meta', at: b.at, par: b.par }, upsert: true } });
      await C.sauvegardes.bulkWrite(ops); await C.sauvegardes.deleteMany({ _id: { $nin: keys.concat(['_meta']) } });
    },
    async isEmpty() { return (await C.config.countDocuments({}, { limit: 1 })) === 0 && (await C.commandes.countDocuments({}, { limit: 1 })) === 0 && (await C.meta.countDocuments({}, { limit: 1 })) === 0; },
    async close() { await client.close(); }
  };
}
let store, cfg, catalogue, commandes;   // caches mémoire (une seule instance du serveur) ; chaque écriture est enregistrée dans le stockage

/* ---------- utilitaires ---------- */
const STATUTS = ['Nouvelle', 'Confirmée', 'Prête', 'Terminée', 'Annulée'];
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, '').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const digits = s => String(s || '').replace(/\D/g, '');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const isAdmin = req => { const k = req.headers['x-admin-key']; return typeof k === 'string' && k.length > 0 && crypto.timingSafeEqual(sha(k), sha(cfg.adminKey)); };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Max-Age': '600' };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, CORS)); res.end(b); };
const body = (req, limit) => new Promise((ok, ko) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > limit) { ko(Object.assign(new Error('Requête trop volumineuse'), { code: 413 })); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { ko(Object.assign(new Error('JSON invalide'), { code: 400 })); } });
  req.on('error', ko);
});
// limitation de débit par adresse IP
const hits = new Map();
const limited = (req, key, max, windowMs) => {
  const ip = (req.socket.remoteAddress || '') + '|' + key, now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < windowMs);
  if (a.length >= max) { hits.set(ip, a); return true; } a.push(now); hits.set(ip, a); return false;
};
setInterval(() => { const now = Date.now(); hits.forEach((a, k) => { const f = a.filter(t => now - t < 3600e3); f.length ? hits.set(k, f) : hits.delete(k); }); }, 600e3).unref();

/* ---------- validation du catalogue publié par l'application de gestion ----------
   Un service n'est publié que s'il a un titre, une description et AU MOINS 3 photos. Le prix est facultatif (prixAffiche). */
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, MIN_PHOTOS = 3, MAX_PHOTOS = 8;
function cleanServices(arr) {
  if (!Array.isArray(arr)) throw Object.assign(new Error('Catalogue invalide'), { code: 400 });
  const ignores = [];
  const ok = arr.slice(0, 500).map(x => {
    const prix = num(x && x.prix), nom = str(x && x.nom, 120), desc = str(x && x.description, 2000);
    const images = (Array.isArray(x && x.images) ? x.images : []).filter(i => typeof i === 'string' && i.length < 260000 && IMG.test(i)).slice(0, MAX_PHOTOS);
    if (!x || !str(x.id, 40) || !nom) return null;
    if (!desc || images.length < MIN_PHOTOS) { ignores.push(nom + ' (description et ' + MIN_PHOTOS + ' photos minimum)'); return null; }
    return { id: str(x.id, 40), type: 'service', nom, prix: prix > 0 ? Math.round(prix * 100) / 100 : 0, prixAffiche: !!x.prixAffiche && prix > 0, categorie: str(x.categorie, 60) || 'Services', description: desc, images };
  }).filter(Boolean);
  return { ok, ignores };
}
function cleanEntreprise(e) {
  e = e || {}; return { nom: str(e.nom, 80), slogan: str(e.slogan, 160), apropos: str(e.apropos, 700), adresse: str(e.adresse, 200), email: str(e.email, 120), tel: str(e.tel, 40), logo: typeof e.logo === 'string' && e.logo.length < 400000 && IMG.test(e.logo) ? e.logo : '' };
}

function cleanLivraison(l) {
  l = l || {}; const zones = (Array.isArray(l.zones) ? l.zones : []).slice(0, 60).map(z => ({ nom: str(z && z.nom, 60), frais: Math.round(Math.min(Math.max(num(z && z.frais) || 0, 0), 1e7) * 100) / 100 })).filter(z => z.nom);
  return { actif: !!l.actif && zones.length > 0, zones };
}

/* ---------- commandes ---------- */
async function nextNumero() {
  const y = String(new Date().getFullYear()); cfg.seq[y] = (cfg.seq[y] || 0) + 1; await store.setConfig(cfg);
  return 'CMD-WEB-' + y + '-' + String(cfg.seq[y]).padStart(4, '0');
}
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, MAX_PHOTO = 2000000, MAX_PHOTOS_LIGNE = 5, MAX_PHOTOS_COMMANDE = 10;
async function createOrder(b) {
  if (b.website) throw Object.assign(new Error('Requête refusée'), { code: 400 });   // champ piège (anti-robot)
  const c = b.client || {}, nom = str(c.nom, 80), tel = str(c.telephone, 24), email = str(c.email, 120), date = str(b.dateSouhaitee, 10);
  if (nom.length < 2) throw Object.assign(new Error('Veuillez indiquer votre nom.'), { code: 422 });
  if (!/^[+0-9][0-9 ()+.-]{6,23}$/.test(tel) || digits(tel).length < 7) throw Object.assign(new Error('Numéro de téléphone invalide.'), { code: 422 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('Adresse e-mail invalide.'), { code: 422 });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Date souhaitée invalide.'), { code: 422 });
  if (!Array.isArray(b.lignes) || !b.lignes.length || b.lignes.length > 20) throw Object.assign(new Error('Votre panier est vide.'), { code: 422 });
  // livraison : les frais viennent TOUJOURS des zones publiées par l'entreprise
  const lv = b.livraison || {}, mode = lv.mode === 'Livraison' ? 'Livraison' : 'Retrait', adresse = str(lv.adresse, 250); let zone = '', frais = 0;
  if (mode === 'Livraison') {
    if (!catalogue.livraison.actif) throw Object.assign(new Error('La livraison n\'est pas proposée pour le moment : choisissez le retrait.'), { code: 422 });
    const z = catalogue.livraison.zones.find(x => x.nom === str(lv.zone, 60)); if (!z) throw Object.assign(new Error('Veuillez choisir votre zone de livraison.'), { code: 422 });
    if (adresse.length < 5) throw Object.assign(new Error('Veuillez indiquer l\'adresse de livraison.'), { code: 422 });
    zone = z.nom; frais = z.frais;
  }
  const lignes = [], photos = []; let sousTotal = 0, surDevis = false;
  b.lignes.forEach((l, i) => {
    const id = str(l && l.id, 40), qty = Math.floor(num(l && l.qty)), it = catalogue.services.find(x => x.id === id);
    if (!id || !(qty >= 1 && qty <= 999)) throw Object.assign(new Error('Quantité invalide.'), { code: 422 });
    if (!it) throw Object.assign(new Error('Un service de votre panier n\'est plus disponible.'), { code: 409 });
    const ph = (Array.isArray(l.photos) ? l.photos : []).slice(0, MAX_PHOTOS_LIGNE), meta = [];
    ph.forEach(p => {
      if (!p || typeof p.data !== 'string' || p.data.length > MAX_PHOTO || !PHOTO.test(p.data)) throw Object.assign(new Error('Une photo est invalide ou trop lourde.'), { code: 422 });
      if (photos.length >= MAX_PHOTOS_COMMANDE) throw Object.assign(new Error('Maximum ' + MAX_PHOTOS_COMMANDE + ' photos par commande.'), { code: 422 });
      const pid = 'P' + (photos.length + 1); photos.push({ id: pid, ligne: i, nom: str(p.nom, 80) || (pid + '.jpg'), data: p.data }); meta.push({ id: pid, nom: photos[photos.length - 1].nom, taille: Math.round(p.data.length * 0.75) });
    });
    const t = Math.round(it.prix * qty * 100) / 100; sousTotal += t; if (!(it.prix > 0)) surDevis = true;
    lignes.push({ type: 'service', id, nom: it.nom, qty, prix: it.prix, total: t, titre: str(l.titre, 120), besoin: str(l.besoin, 2000), commentaire: str(l.commentaire, 1000), photos: meta });
  });
  const now = new Date().toISOString(), numero = await nextNumero();
  const o = { numero, creeLe: now, statut: 'Nouvelle', client: { nom, telephone: tel, email, adresse: mode === 'Livraison' ? adresse : '' }, mode, livraison: { mode, zone, adresse: mode === 'Livraison' ? adresse : '', frais }, fraisLivraison: frais, dateSouhaitee: date, note: str(b.note, 1000), lignes, sousTotal: Math.round(sousTotal * 100) / 100, total: Math.round((sousTotal + frais) * 100) / 100, surDevis, historique: [{ le: now, statut: 'Nouvelle' }] };
  if (photos.length) await store.savePhotos(numero, photos);
  commandes.push(o); await store.saveCommande(o); return o;
}

/* ---------- routes API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/ping' && m === 'GET') return send(res, 200, { ok: true, boutique: catalogue.entreprise.nom || '', publie: catalogue.updatedAt, stockage: store.kind });
  if (p === '/api/catalogue' && m === 'GET') return send(res, 200, catalogue);
  if (p === '/api/catalogue' && m === 'PUT') {
    //if (!isAdmin(req)) return send(res, 401, { erreur: 'Clé d\'accès invalide.' });
    const b = await body(req, 40 * 1024 * 1024), sv = cleanServices(b.services);
    catalogue = { entreprise: cleanEntreprise(b.entreprise), livraison: cleanLivraison(b.livraison), services: sv.ok, updatedAt: new Date().toISOString() };
    await store.setCatalogue(catalogue); return send(res, 200, { ok: true, services: catalogue.services.length, ignores: sv.ignores, updatedAt: catalogue.updatedAt });
  }
  //if (p === '/api/commandes' && m === 'POST') {
    //if (limited(req, 'order', 8, 3600e3) || limited(req, 'order-fast', 1, 3000)) return send(res, 429, { erreur: 'Trop de commandes en peu de temps. Réessayez dans quelques minutes.' });
    const o = await createOrder(await body(req, 16 * 1024 * 1024)); return send(res, 201, { ok: true, numero: o.numero, total: o.total, fraisLivraison: o.fraisLivraison, statut: o.statut });
  }
  //if (p === '/api/suivi' && m === 'GET') {
   // if (limited(req, 'track', 30, 3600e3)) return send(res, 429, { erreur: 'Trop de recherches. Réessayez plus tard.' });
    const n = str(url.searchParams.get('numero'), 30).toUpperCase(), t = digits(url.searchParams.get('tel')), o = commandes.find(x => x.numero === n);
    if (!o || !t || digits(o.client.telephone) !== t) return send(res, 404, { erreur: 'Commande introuvable : vérifiez le numéro et le téléphone.' });
    return send(res, 200, { numero: o.numero, statut: o.statut, mode: o.mode, total: o.total, surDevis: !!o.surDevis, fraisLivraison: o.fraisLivraison || 0, modeReception: o.mode, creeLe: o.creeLe, lignes: o.lignes.map(l => ({ nom: l.nom, qty: l.qty, total: l.total })), historique: o.historique });
  }
  //if (p === '/api/commandes' && m === 'GET') {
   // if (!isAdmin(req)) return send(res, 401, { erreur: 'Clé d\'accès invalide.' });
    return send(res, 200, { commandes, catalogueMajLe: catalogue.updatedAt });
  }
  //if (p === '/api/gestion/sauvegarde' && (m === 'PUT' || m === 'GET')) {   // sauvegarde cloud des données de l'application de gestion
    //if (!isAdmin(req)) return send(res, 401, { erreur: 'Clé d\'accès invalide.' });
    if (m === 'GET') { const b = await store.getBackup(); return b ? send(res, 200, b) : send(res, 404, { erreur: 'Aucune sauvegarde enregistrée.' }); }
    const b = await body(req, 40 * 1024 * 1024), data = b && b.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 422, { erreur: 'Sauvegarde invalide.' });
    const clean = {}; Object.keys(data).slice(0, 200).forEach(k => { if (/^[A-Za-z0-9_-]{1,60}$/.test(k)) clean[k] = data[k]; });
    await store.setBackup({ at: new Date().toISOString(), par: str(b.par, 80), data: clean }); return send(res, 200, { ok: true, collections: Object.keys(clean).length, at: new Date().toISOString() });
  }
  const mp = p.match(/^\/api\/commandes\/(CMD-WEB-\d{4}-\d{4})\/photos$/);
  //if (mp && m === 'GET') {   // photos d'origine (Full HD) téléchargées par l'administrateur
   // if (!isAdmin(req)) return send(res, 401, { erreur: 'Clé d\'accès invalide.' });
    return send(res, 200, { photos: await store.getPhotos(mp[1]) });
  }
  const mt = p.match(/^\/api\/commandes\/(CMD-WEB-\d{4}-\d{4})$/);
  //if (mt && m === 'PATCH') {
    //if (!isAdmin(req)) return send(res, 401, { erreur: 'Clé d\'accès invalide.' });
    const o = commandes.find(x => x.numero === mt[1]); if (!o) return send(res, 404, { erreur: 'Commande introuvable.' });
    const b = await body(req, 10 * 1024), now = new Date().toISOString();
    if (b.statut !== undefined) {
      if (!STATUTS.includes(b.statut)) return send(res, 422, { erreur: 'Statut invalide.' });
      if (o.statut === 'Annulée' && b.statut !== 'Annulée') return send(res, 409, { erreur: 'Commande annulée : non modifiable.' });
      if (b.statut !== o.statut) { o.statut = b.statut; o.historique.push({ le: now, statut: b.statut }); }
    }
    if (b.factureNo !== undefined) o.factureNo = str(b.factureNo, 40);
    if (b.devisNo !== undefined) o.devisNo = str(b.devisNo, 40);
    await store.saveCommande(o); return send(res, 200, { ok: true, commande: o });
  }
  return send(res, 404, { erreur: 'Ressource introuvable.' });
}

/* ---------- fichiers statiques (vitrine) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
function serve(req, res, url) {
  let rel = decodeURIComponent(url.pathname); if (rel === '/' ) rel = '/index.html';
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT + path.sep) && f !== ROOT) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': path.extname(f) === '.html' ? 'no-cache' : 'public, max-age=300' }, HEAD)); res.end(data);
  });
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serve(req, res, url);
  } catch (e) { if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { erreur: typeof e.code === 'number' ? e.message : 'Erreur interne du serveur.' }); else res.end(); if (typeof e.code !== 'number') console.error(e); }
};
async function main() {
  const uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'clicone';
  store = uri ? await mongoStorage(uri, dbName) : fileStorage();
  // première connexion à MongoDB : reprise automatique des données locales existantes (migration)
  if (uri && await store.isEmpty()) {
    const local = fileStorage(), c = await local.getConfig();
    if (c) {
      console.log('  Migration des données locales vers MongoDB Atlas…');
      await store.setConfig(c); const cat = await local.getCatalogue(); if (cat && (cat.services || []).length) { cat.services = cat.services; await store.setCatalogue({ entreprise: cat.entreprise || {}, services: cat.services, livraison: cat.livraison || { actif: false, zones: [] }, updatedAt: cat.updatedAt }); }
      for (const o of await local.getCommandes()) { await store.saveCommande(o); const ph = await local.getPhotos(o.numero); if (ph.length) await store.savePhotos(o.numero, ph); }
      const bk = await local.getBackup(); if (bk) await store.setBackup(bk); console.log('  Migration terminée.');
    }
  }
  cfg = await store.getConfig();
  if (!cfg) { cfg = { adminKey: crypto.randomBytes(24).toString('hex'), seq: {} }; await store.setConfig(cfg); }
  if (process.env.ADMIN_KEY) cfg.adminKey = process.env.ADMIN_KEY;
  catalogue = await store.getCatalogue(); catalogue.entreprise = catalogue.entreprise || {}; catalogue.services = catalogue.services || []; catalogue.livraison = catalogue.livraison || { actif: false, zones: [] }; delete catalogue.produits;
  commandes = await store.getCommandes();
  http.createServer(handler).listen(PORT, () => {
    console.log('\n  Boutique Clic-One démarrée : http://localhost:' + PORT);
    console.log('  Stockage : ' + store.kind);
    console.log('  Clé d\'accès de l\'application de gestion (à copier dans « Boutique en ligne ») :\n  ' + cfg.adminKey + '\n');
  });
}
main().catch(e => { console.error('\n  Démarrage impossible : ' + e.message + '\n'); process.exit(1); });
