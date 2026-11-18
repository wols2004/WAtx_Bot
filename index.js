/* =====================================================
   بوت الواتساب - التحكم في حساب الواتساب عن طريق التليجرام
   Telegram: Telegraf | WhatsApp: @whiskeysockets/baileys
   ملف واحد index.js - الإصدار v2
   ===================================================== */
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    Browsers,
    DisconnectReason,
    proto
} = require('@whiskeysockets/baileys');
const { Telegraf, Markup } = require('telegraf');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

process.env.DEBUG = '';
process.env.NODE_DEBUG = '';
process.env.BAILEYS_LOG_LEVEL = 'fatal';

// ==========================================
// ⚙️ الإعدادات
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN || '9251699043:AAGkmAOtRAiLpUnHX4vXPhPOqo55uYDwHIk';
const ADMIN_ID = String(process.env.ADMIN_ID || '8422032426');
const SOURCE_CHANNEL = '@SourceHouda';
const CHANNEL_URL = 'https://t.me/SourceHouda';
const SIGNATURE = 'TG : Devlopers: @sw_of';
const PORT = 3000;
const START_IMAGE = path.join(__dirname, 'botwatsspp.png'); // الصورة التي يرسلها البوت في /start
const PAIR_TIMEOUT_MS = 3 * 60 * 1000;
const FATAL_CODES = [401, 403, 411];
const MAX_RECONNECT_ATTEMPTS = 10;

// ==========================================
// ⏱️ دوال مساعدة لمنع التجميد
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));

function withTimeout(promise, ms, errMsg = 'انتهت مهلة العملية') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errMsg)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ==========================================
// 🌐 السيرفر (للـ hosting)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('WhatsApp Bot ONLINE\n');
}).listen(PORT, () => console.log(`🌐 السيرفر شغال على بورت ${PORT}`));

// ==========================================
// 📁 المجلدات
// ==========================================
const sessionsDir = path.join(__dirname, 'sessions');
const dataDir = path.join(__dirname, 'data');
const photosRoot = path.join(__dirname, 'photos');
[sessionsDir, dataDir, photosRoot].forEach(d => {
    if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
});

const contactsFile = (num) => path.join(dataDir, `contacts_${num}.json`);
const photosDir = (num) => path.join(photosRoot, num);

function loadContacts(num) {
    try { return JSON.parse(fs.readFileSync(contactsFile(num), 'utf-8')) || []; }
    catch (_) { return []; }
}

function writeContacts(num, arr) {
    try { fs.writeFileSync(contactsFile(num), JSON.stringify(arr || [])); } catch (_) {}
}

// ==========================================
// 🗄️ قاعدة البيانات (SQLite عن طريق sql.js - WASM)
// ==========================================
const initSqlJs = require('sql.js');
const dbFile = path.join(__dirname, 'bot.db');
let db = null;
let dbSaveTimer = null;

async function initDb() {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbFile)) {
        try { db = new SQL.Database(fs.readFileSync(dbFile)); }
        catch (e) { console.error('⚠️ فشل تحميل bot.db، هيتعمل ملف جديد:', e.message); db = new SQL.Database(); }
    } else {
        db = new SQL.Database();
    }
    db.run(`
    CREATE TABLE IF NOT EXISTS users (
        cid TEXT PRIMARY KEY,
        number TEXT UNIQUE,
        linked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_users (
        cid TEXT PRIMARY KEY,
        seen_at TEXT,
        name TEXT,
        username TEXT,
        lang TEXT
    );
    CREATE TABLE IF NOT EXISTS banned (
        cid TEXT PRIMARY KEY,
        name TEXT,
        handle TEXT,
        added_at TEXT
    );
    `);
    // ترقية قاعدة قديمة لو موجودة
    ['name', 'username', 'lang'].forEach(col => {
        try { db.run(`ALTER TABLE bot_users ADD COLUMN ${col} TEXT`); } catch (_) {}
    });
    persistDb();
}

function persistDb() {
    if (dbSaveTimer) return;
    dbSaveTimer = setTimeout(() => {
        dbSaveTimer = null;
        try {
            const data = Buffer.from(db.export());
            fs.promises.writeFile(dbFile, data).catch(e => console.error('❌ خطأ في حفظ قاعدة البيانات:', e.message));
        } catch (e) {
            console.error('❌ خطأ في تصدير قاعدة البيانات:', e.message);
        }
    }, 300);
}

function dbRun(sql, params = []) {
    const stmt = db.prepare(sql);
    try { stmt.bind(params); stmt.step(); } finally { stmt.free(); }
    persistDb();
}
function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : null;
    } finally { stmt.free(); }
}
function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    const rows = [];
    try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
    } finally { stmt.free(); }
    return rows;
}

const q = {
    getSetting: (key) => dbGet('SELECT value FROM settings WHERE key = ?', [key]),
    setSetting: (key, val) => dbRun(
        `INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, val]),
    delSetting: (key) => dbRun('DELETE FROM settings WHERE key = ?', [key]),
    getUserByCid: (cid) => dbGet('SELECT * FROM users WHERE cid = ?', [cid]),
    getUserByNumber: (num) => dbGet('SELECT * FROM users WHERE number = ?', [num]),
    upsertUser: (cid, num, at) => dbRun(
        `INSERT INTO users(cid, number, linked_at) VALUES(?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET number = excluded.number, linked_at = excluded.linked_at`, [cid, num, at]),
    deleteUserByCid: (cid) => dbRun('DELETE FROM users WHERE cid = ?', [cid]),
    deleteUserByNumber: (num) => dbRun('DELETE FROM users WHERE number = ?', [num]),
    countUsers: () => dbGet('SELECT COUNT(*) c FROM users'),
    allUsers: () => dbAll('SELECT * FROM users'),
    upsertBotUser: (cid, name, username) => dbRun(
        `INSERT INTO bot_users(cid, seen_at, name, username) VALUES(?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET seen_at = excluded.seen_at, name = excluded.name, username = excluded.username`,
        [cid, new Date().toLocaleString('ar-EG'), name || '', username || '']),
    getBotUser: (cid) => dbGet('SELECT * FROM bot_users WHERE cid = ?', [String(cid)]),
    allBotUsers: () => dbAll('SELECT * FROM bot_users'),
    delBotUser: (cid) => dbRun('DELETE FROM bot_users WHERE cid = ?', [String(cid)]),
    setLang: (cid, lang) => dbRun(
        `INSERT INTO bot_users(cid, lang) VALUES(?, ?)
         ON CONFLICT(cid) DO UPDATE SET lang = excluded.lang`, [String(cid), lang]),
    banUser: (cid, name, handle) => dbRun(
        `INSERT INTO banned(cid, name, handle, added_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET name = excluded.name, handle = excluded.handle`,
        [String(cid), name || '', handle || '', new Date().toLocaleString('ar-EG')]),
    unbanUser: (cid) => dbRun('DELETE FROM banned WHERE cid = ?', [String(cid)]),
    getBanned: (cid) => dbGet('SELECT * FROM banned WHERE cid = ?', [String(cid)]),
    allBanned: () => dbAll('SELECT * FROM banned'),
    countBanned: () => dbGet('SELECT COUNT(*) c FROM banned')
};

function getSetting(key, def = null) {
    const row = q.getSetting(key);
    return row ? row.value : def;
}
function setSetting(key, val) { q.setSetting(key, String(val)); }
function delSetting(key) { q.delSetting(key); }

// ─── المستخدمين المربوطين (users) ───
function getUserNumber(cid) {
    const row = q.getUserByCid(String(cid));
    return row ? row.number : null;
}
function getCidByNumber(num) {
    const clean = String(num || '').replace(/\D/g, '');
    const row = q.getUserByNumber(clean);
    return row ? row.cid : null;
}
function setUserNumber(cid, num) {
    const clean = String(num || '').replace(/\D/g, '');
    const cidStr = String(cid);
    const existing = q.getUserByNumber(clean);
    if (existing && existing.cid !== cidStr) q.deleteUserByCid(existing.cid);
    q.upsertUser(cidStr, clean, new Date().toLocaleString('ar-EG'));
}
function removeUser(cid) { q.deleteUserByCid(String(cid)); }
function removeUserByNumber(number) {
    const clean = String(number || '').replace(/\D/g, '');
    q.deleteUserByNumber(clean);
}
function isAdminId(id) { return String(id) === ADMIN_ID; }

// ─── مستخدمي البوت + اللغة ───
function getLang(cid) {
    const row = q.getBotUser(cid);
    return row ? (row.lang || null) : null;
}
function langOf(cid) { return getLang(cid) || 'ar'; }

// ─── الحظر ───
function isBanned(cid) { return !!q.getBanned(String(cid)); }
function banTelegramUser(cid, name, handle) { q.banUser(String(cid), name, handle); }
function unbanTelegramUser(cid) { q.unbanUser(String(cid)); }

// ==========================================
// 🌍 النصوص (عربي / انجليزي)
// ==========================================
const LANGS = {
    ar: {
        need_sub: 'عذرآ عليك الاشتراك في قناة السورس اولا لتتمكن من استخدام البوت',
        btn_channel: 'SourceHouda',
        btn_check: 'تحقق',
        sub_not_yet: 'لم تقم بالاشتراك بعد ، اشترك في القناة ثم اضغط تحقق',
        choose_lang: 'اختر اللغة',
        btn_ar: 'اللغه العربيه',
        btn_en: 'اللغه الانجليزيه',
        welcome: (n) => `مرحبا ${n} بك في بوت الواتساب التحديث الجديد v2 استخدم من الازرار التي بـ الاسفل`,
        btn_link: 'اربط رقمك',
        btn_disc: 'قطع الاتصال',
        btn_cmds: 'الاوامر المتاحة',
        btn_howto: 'ازاي استخدم البوت',
        btn_lang: 'تغير اللغة',
        btn_admin: 'لوحة الادمن',
        btn_back: 'رجوع',
        send_phone: 'ارسل رقمك الان مع كود الدولة بالشكل هاذه +20123456789',
        invalid_number: 'رقم غير صحيح ، ارسل رقمك مع كود الدولة بالشكل هاذه +20123456789',
        preparing: 'جاري تجهيز الرقم وإنشاء كود الربط...',
        pair_code: (c) => `كود الربط : ${c}\n\nافتح واتساب في رقمك\nادخل على ربط الاجهزه\nاختر ربط الرقم بدلا من ذلك\nادخل الكود وسيتصل تلقائيا`,
        pair_fail: 'فشل في إنشاء كود الربط ، حاول مرة أخرى',
        pair_timeout: (n) => `انتهت مهلة كود الربط للرقم +${n}\nتم مسح البيانات ، اطلب كود جديد`,
        pair_failed: (n) => `فشل الربط للرقم +${n}\nتم مسح البيانات ، اطلب كود جديد وجرب تاني`,
        linked_ok: 'تم ربط رقمك بنجاح',
        disconnected: (n) => `تم قطع الرقم +${n} ومسح كل بياناته`,
        pair_cancelled: 'تم الغاء عملية الربط',
        no_number: 'لا يوجد رقم مربوط بحسابك',
        already_linked: (n) => `عندك رقم مربوط بالفعل : +${n}`,
        replace_hint: 'تقدر تقطعه وتربط رقم جديد بضغطة واحدة',
        btn_replace: 'قطعه واربط رقم جديد',
        btn_cancel_pair: 'الغاء الربط',
        btn_try_again: 'حاول تاني',
        number_busy: (n) => `الرقم +${n} بيتربط دلوقتي من حساب تاني ، جرب بعد دقيقتين`,
        number_taken: (n) => `الرقم +${n} مسجل بحساب تاني`,
        session_dead: (n) => `الرقم +${n} جلسته بطلت صالحة\nتم مسح بياناته وتقدر تربطه تاني`,
        left_channel: (n) => `تم قطع رقمك +${n} لأنك خرجت من قناة السورس\nاشترك تاني واربط رقمك من جديد`,
        howto: `طريقة استخدام البوت

1 اضغط على زر ( اربط رقمك )
2 قم رسال رقم هاتفك مع رمز الدولة
3 قم ب الدخول ل الواتساب ( رقمك )
4 ادخل على ربط الاجهزه ( اختر ربط الرقم بدلا من ذالك )
5 قم بتجربة البوت في اي محادثه ب كتابة امر (.الاوامر) لعرض الاوامر الخاصه بك`,
        cmds_header: 'الاوامر المتاحة',
        admin_title: 'لوحة الادمن',
        st_users: 'عدد المستخدمين',
        st_linked: 'عدد الارقام المربوطة',
        st_online: 'الارقام المتصلة الان',
        st_banned: 'المحظورين',
        btn_broadcast: 'الاذاعه',
        btn_ban: 'حظر مستخدم',
        btn_banned: 'المحظورين',
        btn_numbers: 'قائمة الارقام',
        bc_prompt: 'ارسل الرسالة التي تريد نشرها لجميع المستخدمين (نص او صوره او فيديو او ملف)',
        bc_running: 'فيه اذاعة شغالة بالفعل في الخلفية دلوقتي',
        bc_started: 'بدأت الاذاعة في الخلفية بنظام المجموعات والبوت شغال طبيعي',
        bc_stop: 'ايقاف الاذاعه',
        bc_stopped: 'تم ايقاف الاذاعة يدويا',
        bc_done: 'تمت الاذاعة بنجاح',
        bc_sent: 'وصلت بنجاح',
        bc_removed: 'حسابات غير نشطة تم تنظيفها',
        bc_failed: 'فشل',
        bc_total: 'الاجمالي',
        ban_prompt: 'ارسل ايدي المستخدم او يوزر المستخدم لحظره من البوت\nمثال : 123456789 او @username',
        ban_done: (n, h) => `تم حظر المستخدم ${n || ''} ${h}`.trim(),
        ban_notfound: 'لم يتم العثور على المستخدم',
        banned_title: (c) => `قائمة المحظورين (${c})`,
        no_banned: 'لا يوجد محظورين',
        btn_unban: 'الغاء الحظر',
        numbers_title: (c) => `قائمة الارقام (${c})`,
        no_numbers: 'لا توجد ارقام',
        btn_disc_all: 'قطع الكل',
        admin_disc_done: (n) => `تم قطع الرقم +${n} ومسح بياناته`,
        admin_disc_all_done: (c) => `تم قطع ${c} رقم ومسح بياناتهم`,
        err: 'حدث خطأ ، حاول مرة أخرى'
    },
    en: {
        need_sub: 'Sorry, you must subscribe to the source channel first to use the bot',
        btn_channel: 'SourceHouda',
        btn_check: 'Check',
        sub_not_yet: 'You did not subscribe yet, subscribe to the channel then press Check',
        choose_lang: 'Choose language / اختر اللغة',
        btn_ar: 'اللغه العربيه',
        btn_en: 'English',
        welcome: (n) => `Hello ${n}, welcome to the new WhatsApp Bot v2. Use the buttons below`,
        btn_link: 'Link your number',
        btn_disc: 'Disconnect',
        btn_cmds: 'Available commands',
        btn_howto: 'How to use the bot',
        btn_lang: 'Change language',
        btn_admin: 'Admin panel',
        btn_back: 'Back',
        send_phone: 'Send your number now with the country code like this +20123456789',
        invalid_number: 'Invalid number, send your number with the country code like this +20123456789',
        preparing: 'Preparing your number and creating the pairing code...',
        pair_code: (c) => `Pairing code : ${c}\n\nOpen WhatsApp on your phone\nGo to Linked devices\nChoose Link with phone number instead\nEnter the code and it will connect automatically`,
        pair_fail: 'Failed to create the pairing code, try again',
        pair_timeout: (n) => `Pairing code expired for +${n}\nData cleared, request a new code`,
        pair_failed: (n) => `Pairing failed for +${n}\nData cleared, request a new code and try again`,
        linked_ok: 'Your number has been linked successfully',
        disconnected: (n) => `Your number +${n} has been disconnected and all its data cleared`,
        pair_cancelled: 'Pairing cancelled',
        no_number: 'You have no linked number',
        already_linked: (n) => `You already have a linked number : +${n}`,
        replace_hint: 'You can disconnect it and link a new number with one click',
        btn_replace: 'Disconnect and link a new number',
        btn_cancel_pair: 'Cancel pairing',
        btn_try_again: 'Try again',
        number_busy: (n) => `+${n} is being linked from another account, try again in 2 minutes`,
        number_taken: (n) => `+${n} is already linked to another account`,
        session_dead: (n) => `The session of +${n} is no longer valid\nIts data was cleared, you can link it again`,
        left_channel: (n) => `Your number +${n} was disconnected because you left the source channel\nSubscribe again and link your number`,
        howto: `How to use the bot

1 Press the ( Link your number ) button
2 Send your phone number with the country code
3 Open WhatsApp on your number
4 Go to Linked devices ( choose Link with phone number instead )
5 Try the bot in any chat by typing (.الاوامر) to see your commands`,
        cmds_header: 'Available commands',
        admin_title: 'Admin panel',
        st_users: 'Users',
        st_linked: 'Linked numbers',
        st_online: 'Online numbers',
        st_banned: 'Banned',
        btn_broadcast: 'Broadcast',
        btn_ban: 'Ban a user',
        btn_banned: 'Banned users',
        btn_numbers: 'Numbers list',
        bc_prompt: 'Send the message you want to broadcast to all users (text, photo, video or file)',
        bc_running: 'A broadcast is already running in the background',
        bc_started: 'Broadcast started in the background in batches, the bot is working normally',
        bc_stop: 'Stop broadcast',
        bc_stopped: 'Broadcast stopped manually',
        bc_done: 'Broadcast finished successfully',
        bc_sent: 'Sent successfully',
        bc_removed: 'Inactive accounts cleaned',
        bc_failed: 'Failed',
        bc_total: 'Total',
        ban_prompt: 'Send the user ID or the user username to ban them from the bot\nExample : 123456789 or @username',
        ban_done: (n, h) => `User banned: ${n || ''} ${h}`.trim(),
        ban_notfound: 'User not found',
        banned_title: (c) => `Banned users (${c})`,
        no_banned: 'No banned users',
        btn_unban: 'Unban',
        numbers_title: (c) => `Numbers list (${c})`,
        no_numbers: 'No numbers',
        btn_disc_all: 'Disconnect all',
        admin_disc_done: (n) => `+${n} has been disconnected and its data cleared`,
        admin_disc_all_done: (c) => `${c} numbers have been disconnected and their data cleared`,
        err: 'An error occurred, try again'
    }
};
const T = (cid) => LANGS[langOf(cid)] || LANGS.ar;

// ==========================================
// 📜 قائمة الأوامر (تُستخدم في تليجرام وفي واتساب)
// ==========================================
const COMMANDS = [
    ['.الاوامر', 'عرض جميع الاوامر', 'show all commands'],
    ['.معلوماتي', 'معلومات حسابك', 'your account info'],
    ['.رقمي', 'رقم هاتفك مع كود الدولة', 'your phone number with country code'],
    ['.ابعت (العدد) (الرساله)', 'ارسال رسايل متكرره في المحادثه', 'send repeated messages in the chat'],
    ['.رد تلقائي', 'تفعيل الرد التلقائي على الخاص (تقدر تكتب الرسالة بعد الامر مباشرة)', 'enable auto reply for private chats'],
    ['.ايقاف الرد التلقائي', 'ايقاف الرد التلقائي', 'disable auto reply'],
    ['.حذف رسائلي', 'حذف كل رسائلك في المحادثه مع التحقق من الحذف الكامل', 'delete your messages in the chat'],
    ['.حذف جميع الرسائل', 'حذف رسائل المحادثه من الطرفين مع التحقق والاعادة', 'delete chat messages from both sides'],
    ['.اسم (الاسم)', 'تغيير اسم حسابك', 'change your account name'],
    ['.تغيير صورتي', 'تغيير صورة الحساب بالرد على صوره', 'set profile picture by replying to an image'],
    ['.بروفايل', 'صورة ومعلومات بروفايل المحادثه', 'chat profile picture and info'],
    ['تفعيل الوقت', 'ساعة توقيت الجيزة بجانب اسم حسابك تتحدث كل دقيقه', 'live clock next to your account name (Giza time)'],
    ['.الغاء الوقت', 'ايقاف الساعه واسترجاع اسم حسابك', 'stop the clock and restore your name'],
    ['.تغيير صورة تلقائيا (العدد)', 'تغيير صورة البروفايل تلقائيا', 'auto rotate your profile picture'],
    ['.ايقاف تغيير صورة', 'ايقاف تغيير الصوره التلقائي', 'stop auto rotate'],
    ['.حذف مجلد الصور الخاص بي', 'حذف مجلد صور البروفايل', 'delete your profile photos folder'],
    ['.كتم', 'كتم مستخدم في المجموعات بالرد على رسالته', 'mute a user in groups (reply to their message)'],
    ['.المكتومين', 'قائمه المستخدمين المكتومين في المجموعة', 'list muted users in the group'],
    ['.حظر', 'حظر المستخدم في المحادثه', 'block the user in the chat'],
    ['.هل قام بحظري', 'فحص هل قام المستخدم بحظرك', 'check if someone blocked you'],
    ['.استوري', 'قائمه بجميع الحسابات المحفوظ استوريهاتها (الاسم والرقم والعدد)', 'list all accounts with saved stories'],
    ['.سحب استوري (الرقم)', 'سحب استوري مستخدم بالرقم مع الاحصائيات والكابشن', 'download the stories of a number'],
    ['.ريك', 'ارسال المقطع الصوتي كريكورد لرقمك الشخصي', 'send an audio clip as a voice note to your own chat'],
    ['.اونلاين', 'جعل حسابك نشط اونلاين بشكل دائم', 'keep your account always online'],
    ['.ايقاف الاونلاين', 'ايقاف وضع الاونلاين الدائم', 'stop the always online mode'],
    ['.صوره', 'التقاط الصوره المعروضه لمره واحده', 'capture a view-once image'],
    ['.فيد', 'التقاط الفيديو المعروض لمره واحده', 'capture a view-once video'],
    ['.نشر (الرساله)', 'نشر رساله لجميع المحادثات', 'broadcast a message to all chats'],
    ['.نشر للمجموعات (الرساله)', 'نشر رساله لجميع المجموعات', 'broadcast a message to all groups']
];

function commandsText(lang) {
    const idx = lang === 'en' ? 2 : 1;
    const lines = COMMANDS.map((c, i) => `${i + 1} : ${c[0]} - ${c[idx]}`);
    return lines.join('\n') + '\n\n' + SIGNATURE;
}

// ==========================================
// 🔧 أدوات عامة
// ==========================================
const cleanDigits = (n) => String(n || '').replace(/\D/g, '');
function numFromJid(jid) {
    return String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
}
function fmtDate(tsSec) {
    const d = tsSec ? new Date(Number(tsSec) * 1000) : new Date();
    try { return d.toLocaleString('ar-EG'); } catch (_) { return d.toISOString(); }
}
function fmtSize(v) {
    const n = Number(v && v.low !== undefined ? v.low : v) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// رقم هاتف منسق مع رمز الدولة مثل +20 121 462 9001
function fmtPhone(n) {
    const d = cleanDigits(n);
    if (!d) return '(غير معروف)';
    const cc = d.startsWith('20') ? '20' : d.slice(0, 3);
    let rest = d.slice(cc.length);
    const groups = [];
    while (rest.length > 4) { groups.push(rest.slice(0, 3)); rest = rest.slice(3); }
    if (rest) groups.push(rest);
    return `+${cc} ${groups.join(' ')}`;
}
function gizaTime() {
    try {
        const s = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true
        }).format(new Date());
        return s.replace('AM', 'ص').replace('PM', 'م').replace('am', 'ص').replace('pm', 'م');
    } catch (_) {
        return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
}
function unwrapMessage(message) {
    let m = message;
    let viewOnce = false;
    let edited = false;
    const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage', 'editedMessage'];
    for (let i = 0; i < 5 && m; i++) {
        const k = Object.keys(m || {}).find(x => wrappers.includes(x));
        if (!k) break;
        if (k.startsWith('viewOnce')) viewOnce = true;
        if (k === 'editedMessage') edited = true;
        m = m[k] && m[k].message;
    }
    return { msg: m, viewOnce, edited };
}
function extractText(inner) {
    return (inner && (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.buttonsResponseMessage?.selectedDisplayText ||
        inner.listResponseMessage?.title
    )) || '';
}
function mediaKind(inner) {
    if (!inner) return null;
    if (inner.imageMessage) return 'صوره';
    if (inner.videoMessage) return 'فيديو';
    if (inner.stickerMessage) return 'ملصق';
    if (inner.audioMessage) return 'صوت';
    if (inner.documentMessage) return 'ملف';
    return null;
}
function getQuoted(msg) {
    try {
        const m = unwrapMessage(msg.message).msg || {};
        const ct = Object.keys(m).find(k => m[k] && m[k].contextInfo && m[k].contextInfo.quotedMessage);
        if (!ct) return null;
        const info = m[ct].contextInfo;
        const qm = unwrapMessage(info.quotedMessage).msg;
        if (!qm) return null;
        return {
            msg: qm,
            participant: info.participant || null,
            stanzaId: info.stanzaId || null,
            viewOnce: unwrapMessage(info.quotedMessage).viewOnce
        };
    } catch (_) { return null; }
}
async function downloadMedia(inner, preferType) {
    const types = preferType ? [preferType] : ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'];
    for (const t of types) {
        const c = inner && inner[t];
        if (!c) continue;
        const kind = t.replace('Message', '').toLowerCase();
        try {
            const stream = await downloadContentFromMessage(c, kind);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return { buffer: Buffer.concat(chunks), kind, content: c, mimetype: c.mimetype || '', seconds: c.seconds || 0, fileName: c.fileName || '' };
        } catch (_) {}
    }
    return null;
}
async function getBio(sock, jid) {
    try {
        const res = await sock.fetchStatus(jid);
        if (Array.isArray(res)) return res[0]?.status || '';
        if (res && res.status) return String(res.status);
        return '';
    } catch (_) { return ''; }
}

// ==========================================
// 🤖 بوت التليجرام
// ==========================================
const tgAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    timeout: 30000
});

const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 300000,
    telegram: { agent: tgAgent, attachmentAgent: tgAgent }
});

const connectLock = new Set();
const userStates = new Map(); // cid -> { type }

// زر بلون (Bot API 9.4 : primary / success / danger) بدون أي ايموجي
function cbtn(text, data, style) {
    const b = Markup.button.callback(text, data);
    if (style) b.style = style;
    return b;
}
function ubtn(text, url, style) {
    const b = Markup.button.url(text, url);
    if (style) b.style = style;
    return b;
}

async function safeAnswerCb(ctx, text) {
    try { await ctx.answerCbQuery(text); } catch (_) {}
}

async function safeEdit(ctx, text, extra = {}) {
    try {
        await ctx.editMessageText(text, { disable_web_page_preview: true, ...extra });
    } catch (e) {
        if (String(e?.description || '').includes('message is not modified')) return;
        try { await ctx.reply(text, { disable_web_page_preview: true, ...extra }); } catch (_) {}
    }
}

function mainMenuKb(lang, is_admin) {
    const L = LANGS[lang] || LANGS.ar;
    const rows = [
        [cbtn(L.btn_link, 'connect', 'success')],
        [cbtn(L.btn_disc, 'disconnect', 'danger')],
        [cbtn(L.btn_cmds, 'show_commands', 'primary')],
        [cbtn(L.btn_howto, 'explain_bot', 'primary')],
        [cbtn(L.btn_lang, 'change_lang', 'primary')]
    ];
    if (is_admin) rows.push([cbtn(L.btn_admin, 'admin_info', 'primary')]);
    return Markup.inlineKeyboard(rows);
}

async function sendMainMenu(ctx, lang) {
    const L = LANGS[lang] || LANGS.ar;
    const name = ctx.from?.first_name || (lang === 'ar' ? 'صديقي' : 'friend');
    const caption = L.welcome(name);
    const kb = mainMenuKb(lang, isAdminId(ctx.from?.id));
    if (fs.existsSync(START_IMAGE)) {
        try { return await ctx.replyWithPhoto({ source: START_IMAGE }, { caption, ...kb }); } catch (_) {}
    }
    return ctx.reply(caption, kb).catch(() => {});
}

async function showScreen(ctx, text, kb) {
    try {
        await ctx.editMessageText(text, { disable_web_page_preview: true, ...(kb || {}) });
        return;
    } catch (_) {}
    try { await ctx.reply(text, kb || undefined); } catch (_) {}
}

function langKb() {
    return Markup.inlineKeyboard([
        [cbtn(LANGS.ar.btn_ar, 'lang_ar', 'success')],
        [cbtn(LANGS.en.btn_en, 'lang_en', 'success')]
    ]);
}

function subKb(lang) {
    const L = LANGS[lang] || LANGS.ar;
    return Markup.inlineKeyboard([
        [ubtn(L.btn_channel, CHANNEL_URL, 'danger')],
        [cbtn(L.btn_check, 'check_sub', 'success')]
    ]);
}

const backKb = (style = 'primary') => Markup.inlineKeyboard([[cbtn(LANGS.ar.btn_back, 'back', style)]]);

async function isSubscribed(uid) {
    if (isAdminId(uid)) return true;
    try {
        const m = await withTimeout(bot.telegram.getChatMember(SOURCE_CHANNEL, uid), 8000);
        return !['left', 'kicked'].includes(m.status);
    } catch (_) {
        // البوت مقدرش يتأكد - نسمح عشان البوت ميقعش
        return true;
    }
}

// ─── تسجيل المستخدمين + حجب المحظورين ───
bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
        if (!isAdminId(uid) && isBanned(uid)) return; // محظور - تجاهل تام
        try { q.upsertBotUser(String(uid), ctx.from.first_name || '', ctx.from.username || ''); } catch (_) {}
    }
    return next();
});
bot.catch((err) => console.error('❌ Telegram handler error:', err?.message || err));

// ─── /start : الاشتراك في القناة ← اختيار اللغة ← القائمة الرئيسية ───
bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const lang = langOf(uid);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(uid))) {
        return ctx.reply(L.need_sub, subKb(lang)).catch(() => {});
    }
    if (!getLang(uid)) {
        return ctx.reply(L.choose_lang, langKb()).catch(() => {});
    }
    return sendMainMenu(ctx, lang);
});

bot.action('check_sub', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(ctx.from.id))) {
        return safeEdit(ctx, L.sub_not_yet, subKb(lang));
    }
    try { await ctx.deleteMessage(); } catch (_) {}
    if (!getLang(ctx.from.id)) {
        return ctx.reply(L.choose_lang, langKb()).catch(() => {});
    }
    return sendMainMenu(ctx, lang);
});

bot.action('lang_ar', async (ctx) => {
    await safeAnswerCb(ctx);
    q.setLang(String(ctx.from.id), 'ar');
    try { await ctx.deleteMessage(); } catch (_) {}
    return sendMainMenu(ctx, 'ar');
});

bot.action('lang_en', async (ctx) => {
    await safeAnswerCb(ctx);
    q.setLang(String(ctx.from.id), 'en');
    try { await ctx.deleteMessage(); } catch (_) {}
    return sendMainMenu(ctx, 'en');
});

// ─── تغيير اللغة من القائمة الرئيسية ───
bot.action('change_lang', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    return safeEdit(ctx, L.choose_lang, Markup.inlineKeyboard([
        [cbtn(LANGS.ar.btn_ar, 'lang_ar', 'success')],
        [cbtn(LANGS.en.btn_en, 'lang_en', 'success')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]));
});

bot.action('back', async (ctx) => {
    await safeAnswerCb(ctx);
    try { await ctx.deleteMessage(); } catch (_) {}
    return sendMainMenu(ctx, langOf(ctx.from.id));
});

// ─── الاوامر المتاحة ───
bot.action('show_commands', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    showScreen(ctx, `${L.cmds_header}\n\n${commandsText(lang)}`, backKb());
});

// ─── ازاي استخدم البوت ───
bot.action('explain_bot', async (ctx) => {
    await safeAnswerCb(ctx);
    const L = T(ctx.from.id);
    showScreen(ctx, L.howto, backKb());
});

// ─── ربط رقمك ───
bot.action('connect', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(ctx.from.id))) return safeEdit(ctx, L.need_sub, subKb(lang));
    const cid = ctx.chat.id;
    const num = getUserNumber(cid);
    if (num && sessionState(num) === 'paired') {
        return showScreen(ctx,
            `${L.already_linked(num)}\n${L.replace_hint}`,
            Markup.inlineKeyboard([
                [cbtn(L.btn_replace, 'replace_number', 'danger')],
                [cbtn(L.btn_back, 'back', 'primary')]
            ]));
    }
    await cancelPairingsOfChat(cid);
    userStates.set(cid, { type: 'number' });
    return showScreen(ctx, L.send_phone, Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'danger')]]));
});

bot.action('replace_number', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const cid = ctx.chat.id;
    const num = getUserNumber(cid);
    if (num) await fullDisconnect(num);
    removeUser(cid);
    userStates.set(cid, { type: 'number' });
    return showScreen(ctx, L.send_phone, Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'danger')]]));
});

bot.action('cancel_pair', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);
    const n = await cancelPairingsOfChat(cid);
    const L = T(cid);
    showScreen(ctx, n ? L.pair_cancelled : L.no_number,
        Markup.inlineKeyboard([
            [cbtn(L.btn_link, 'connect', 'success')],
            [cbtn(L.btn_back, 'back', 'primary')]
        ]));
});

// ─── قطع الاتصال ───
bot.action('disconnect', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);
    const L = T(cid);
    const num = getUserNumber(cid);
    const cancelled = await cancelPairingsOfChat(cid);
    if (!num) {
        return showScreen(ctx, cancelled ? L.pair_cancelled : L.no_number,
            Markup.inlineKeyboard([
                [cbtn(L.btn_link, 'connect', 'success')],
                [cbtn(L.btn_back, 'back', 'primary')]
            ]));
    }
    await fullDisconnect(num);
    removeUser(cid);
    showScreen(ctx, L.disconnected(num),
        Markup.inlineKeyboard([
            [cbtn(L.btn_link, 'connect', 'success')],
            [cbtn(L.btn_back, 'back', 'primary')]
        ]));
});

// ==========================================
// 👑 لوحة الادمن
// ==========================================
function adminKb(lang) {
    const L = LANGS[lang] || LANGS.ar;
    return Markup.inlineKeyboard([
        [cbtn(L.btn_broadcast, 'broadcast_start', 'success')],
        [cbtn(L.btn_ban, 'ban_user', 'danger'), cbtn(L.btn_banned, 'banned_list', 'primary')],
        [cbtn(L.btn_numbers, 'admin_list', 'primary')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]);
}

async function adminStatsText(lang) {
    const L = LANGS[lang] || LANGS.ar;
    const sessions = listConnectedSessions();
    return `${L.admin_title}\n\n` +
        `${L.st_users} : ${q.allBotUsers().length}\n` +
        `${L.st_linked} : ${q.countUsers().c}\n` +
        `${L.st_online} : ${sessions.length}\n` +
        `${L.st_banned} : ${q.countBanned().c}`;
}

bot.command('admin', async (ctx) => {
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    return ctx.reply(await adminStatsText(lang), adminKb(lang)).catch(() => {});
});

bot.action('admin_info', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    try { await ctx.deleteMessage(); } catch (_) {}
    return ctx.reply(await adminStatsText(lang), adminKb(lang)).catch(() => {});
});

// ─── قائمة الارقام (ادمن) ───
bot.action('admin_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const nums = listAllNumbers();
    if (!nums.length) return showScreen(ctx, L.no_numbers, backKb());
    let list = `${L.numbers_title(nums.length)}\n\n`;
    nums.forEach((s, i) => {
        const uid = getCidByNumber(s);
        list += `${i + 1}. +${s} | ${uid ? uid : '-'} | ${numberStatus(s)}\n`;
    });
    showScreen(ctx, list, Markup.inlineKeyboard([
        [cbtn(L.btn_disc_all, 'admin_disc_all', 'danger')],
        [cbtn(L.btn_back, 'admin_info', 'primary')]
    ]));
});

bot.action(/admin_disc_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const num = ctx.match[1];
    const owner = getCidByNumber(num);
    await fullDisconnect(num);
    if (owner) removeUser(owner);
    showScreen(ctx, L.admin_disc_done(num), backKb());
});

bot.action('admin_disc_all', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const nums = listAllNumbers();
    setImmediate(async () => {
        for (const n of nums) {
            const owner = getCidByNumber(n);
            await fullDisconnect(n).catch(() => {});
            if (owner) removeUser(owner);
            await yieldLoop();
        }
    });
    showScreen(ctx, L.admin_disc_all_done(nums.length), backKb());
});

// ─── حظر مستخدم ───
bot.action('ban_user', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    userStates.set(ctx.chat.id, { type: 'ban_user' });
    showScreen(ctx, L.ban_prompt, backKb());
});

bot.action('banned_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const all = q.allBanned();
    if (!all.length) return showScreen(ctx, L.no_banned, backKb());
    let txt = `${L.banned_title(all.length)}\n\n`;
    all.forEach((b, i) => {
        txt += `${i + 1}. ${b.name || '-'} | ${b.handle || b.cid}\n`;
    });
    const btns = all.map(b => [cbtn(`${L.btn_unban} (${b.handle || b.cid})`, `unb_${b.cid}`, 'danger')]);
    btns.push([cbtn(L.btn_back, 'admin_info', 'primary')]);
    showScreen(ctx, txt, Markup.inlineKeyboard(btns));
});

bot.action(/unb_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    unbanTelegramUser(ctx.match[1]);
    const all = q.allBanned();
    if (!all.length) return showScreen(ctx, L.no_banned, backKb());
    let txt = `${L.banned_title(all.length)}\n\n`;
    all.forEach((b, i) => {
        txt += `${i + 1}. ${b.name || '-'} | ${b.handle || b.cid}\n`;
    });
    const btns = all.map(b => [cbtn(`${L.btn_unban} (${b.handle || b.cid})`, `unb_${b.cid}`, 'danger')]);
    btns.push([cbtn(L.btn_back, 'admin_info', 'primary')]);
    showScreen(ctx, txt, Markup.inlineKeyboard(btns));
});

// ==========================================
// 📢 الاذاعه (بنظام المجموعات في الخلفية)
// ==========================================
let activeBroadcast = null;

bot.action('broadcast_start', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (activeBroadcast && !activeBroadcast.cancelled) {
        return showScreen(ctx, L.bc_running,
            Markup.inlineKeyboard([
                [cbtn(L.bc_stop, 'broadcast_cancel', 'danger')],
                [cbtn(L.btn_back, 'admin_info', 'primary')]
            ]));
    }
    userStates.set(ctx.chat.id, { type: 'broadcast' });
    showScreen(ctx, L.bc_prompt,
        Markup.inlineKeyboard([[cbtn(L.btn_back, 'admin_info', 'primary')]]));
});

bot.action('broadcast_cancel', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    if (activeBroadcast) activeBroadcast.cancelled = true;
});

async function sendCopyToUserSmart(targetCid, fromChatId, messageId, state) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (state.cancelled) return 'cancelled';
        try {
            await withTimeout(bot.telegram.copyMessage(targetCid, fromChatId, messageId), 10000);
            return 'sent';
        } catch (err) {
            const code = err?.response?.error_code;
            const desc = (err?.response?.description || err?.message || '').toLowerCase();
            const retryAfter = err?.response?.parameters?.retry_after;
            if (code === 429 && retryAfter && attempt === 1) {
                await sleep((Number(retryAfter) + 1) * 1000);
                continue;
            }
            if (code === 403 || desc.includes('blocked') || desc.includes('deactivated') || desc.includes('chat not found') || desc.includes('user not found')) {
                q.delBotUser(targetCid);
                return 'removed';
            }
            return 'failed';
        }
    }
    return 'failed';
}

function buildProgressBar(done, total) {
    if (!total) return '---------- 100%';
    const pct = Math.min(100, Math.round((done / total) * 100));
    const filled = Math.round(pct / 10);
    return '='.repeat(filled) + '-'.repeat(10 - filled) + ` ${pct}%`;
}

async function runBroadcastInBatches(adminChatId, message, statusMsgId) {
    const lang = langOf(adminChatId);
    const L = LANGS[lang] || LANGS.ar;
    const users = q.allBotUsers();
    const total = users.length;
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(total / BATCH_SIZE) || 1;
    const state = { cancelled: false };
    activeBroadcast = state;
    let sentTg = 0, removedTg = 0, failedTg = 0, processed = 0;
    let lastUiUpdate = Date.now();

    try {
        for (let b = 0; b < totalBatches; b++) {
            if (state.cancelled) break;
            const batch = users.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(u => sendCopyToUserSmart(u.cid, adminChatId, message.message_id, state))
            );
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    if (r.value === 'sent') sentTg++;
                    else if (r.value === 'removed') removedTg++;
                    else failedTg++;
                } else failedTg++;
            }
            processed += batch.length;

            const now = Date.now();
            if (now - lastUiUpdate >= 3000 && processed < total && !state.cancelled) {
                lastUiUpdate = now;
                const progressTxt =
                    `${L.bc_started}\n\n` +
                    `${buildProgressBar(processed, total)}\n` +
                    `${L.bc_sent} : ${sentTg}\n` +
                    `${L.bc_removed} : ${removedTg}\n` +
                    `${L.bc_failed} : ${failedTg}\n` +
                    `${L.bc_total} : ${processed} / ${total}`;
                bot.telegram.editMessageText(adminChatId, statusMsgId, null, progressTxt, {
                    ...Markup.inlineKeyboard([[cbtn(L.bc_stop, 'broadcast_cancel', 'danger')]])
                }).catch(() => {});
            }
            await yieldLoop();
            if (b + 1 < totalBatches && !state.cancelled) await sleep(900);
        }

        const finalHeader = state.cancelled ? L.bc_stopped : L.bc_done;
        const finalTxt =
            `${finalHeader}\n\n` +
            `${buildProgressBar(processed, total)}\n` +
            `${L.bc_sent} : ${sentTg}\n` +
            `${L.bc_removed} : ${removedTg}\n` +
            `${L.bc_failed} : ${failedTg}\n` +
            `${L.bc_total} : ${processed} / ${total}`;
        await bot.telegram.editMessageText(adminChatId, statusMsgId, null, finalTxt, {
            ...Markup.inlineKeyboard([[cbtn(L.btn_back, 'admin_info', 'primary')]])
        }).catch(() => {});
    } finally {
        activeBroadcast = null;
    }
}

// ─── استقبال الرسايل حسب الحالة ───
bot.on('message', async (ctx) => {
    const cid = ctx.chat?.id;
    if (!cid) return;
    const state = userStates.get(cid);
    if (!state) return;

    // الاذاعه (ادمن فقط)
    if (state.type === 'broadcast') {
        if (!isAdminId(ctx.from.id)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const wait = await ctx.reply(L.bc_started, {
            ...Markup.inlineKeyboard([[cbtn(L.bc_stop, 'broadcast_cancel', 'danger')]])
        }).catch(() => null);
        setImmediate(() => {
            if (wait) runBroadcastInBatches(cid, ctx.message, wait.message_id).catch(err => console.error('❌ خطأ أثناء الإذاعة:', err?.message || err));
        });
        return;
    }

    if (!ctx.message?.text) return;
    const text = ctx.message.text.trim();

    // حظر مستخدم (ادمن فقط)
    if (state.type === 'ban_user') {
        if (!isAdminId(ctx.from.id)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const input = text.trim();
        let row = null;
        if (/^\d+$/.test(input)) {
            row = q.getBotUser(input) || { cid: input, name: '', username: '' };
            row.cid = String(input);
        } else {
            const uname = input.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').trim();
            row = q.allBotUsers().find(u => (u.username || '').toLowerCase() === uname.toLowerCase());
            if (!row) return ctx.reply(L.ban_notfound).catch(() => {});
        }
        if (isAdminId(row.cid)) return ctx.reply(L.err).catch(() => {});
        const handle = row.username ? `@${row.username}` : (row.cid ? row.cid : input);
        const phone = getUserNumber(row.cid);
        banTelegramUser(row.cid, row.name || '', phone ? `+${phone}` : handle);
        const num = getUserNumber(row.cid);
        if (num) {
            await fullDisconnect(num).catch(() => {});
            removeUser(row.cid);
        }
        return ctx.reply(L.ban_done(row.name || '', phone ? `+${phone}` : handle)).catch(() => {});
    }

    // ادخال الرقم للربط
    if (state.type === 'number') {
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const number = text.replace(/\D/g, '');
        if (!number || number.length < 7 || number.length > 15) {
            return ctx.reply(L.invalid_number).catch(() => {});
        }
        const me = String(cid);
        if (connectLock.has(number)) return ctx.reply(L.preparing).catch(() => {});

        const mine = getUserNumber(cid);
        if (mine && mine !== number) {
            if (sessionState(mine) === 'paired') {
                userStates.delete(cid);
                return ctx.reply(`${L.already_linked(mine)}\n${L.replace_hint}`, {
                    ...Markup.inlineKeyboard([[cbtn(L.btn_replace, 'replace_number', 'danger')]])
                }).catch(() => {});
            }
            await fullDisconnect(mine);
        }

        const owner = getCidByNumber(number);
        const st = sessionState(number);
        const pend = pendingPairs.get(number);

        if (pend && String(pend.cid) !== me) {
            userStates.delete(cid);
            return ctx.reply(L.number_busy(number)).catch(() => {});
        }
        if (st === 'paired' && !pend && owner !== me) {
            userStates.delete(cid);
            return ctx.reply(L.number_taken(number)).catch(() => {});
        }

        userStates.delete(cid);
        const wait = await ctx.reply(L.preparing).catch(() => null);
        connectLock.add(number);

        setImmediate(async () => {
            try {
                await cancelPairingsOfChat(cid);
                if (st !== 'none' || owner) await fullDisconnect(number);

                const code = await startWhatsApp(number, { cid });
                const p = pendingPairs.get(number);
                if (p) p.msgId = wait ? wait.message_id : null;

                if (wait) {
                    await ctx.telegram.editMessageText(cid, wait.message_id, null,
                        code ? L.pair_code(code) : L.no_number,
                        { disable_web_page_preview: true,
                          ...Markup.inlineKeyboard([
                              [cbtn(L.btn_cancel_pair, 'cancel_pair', 'danger')],
                              [cbtn(L.btn_back, 'back', 'primary')]
                          ]) }
                    ).catch(() => {});
                }
            } catch (e) {
                if (e && e.cancelled) return;
                await fullDisconnect(number).catch(() => {});
                if (wait) {
                    await ctx.telegram.editMessageText(cid, wait.message_id, null,
                        `${L.pair_fail}\n${e?.message || ''}`,
                        { ...Markup.inlineKeyboard([
                            [cbtn(L.btn_try_again, 'connect', 'success')],
                            [cbtn(L.btn_back, 'back', 'primary')]
                        ]) }
                    ).catch(() => {});
                }
            } finally {
                connectLock.delete(number);
            }
        });
    }
});

// ─── لو خرج من قناة السورس وهو مربوط نقطع رقمه ───
bot.on('chat_member', async (ctx) => {
    try {
        const upd = ctx.chatMember;
        const chatUsername = ctx.chat?.username ? `@${ctx.chat.username}` : null;
        if (!chatUsername || chatUsername.toLowerCase() !== SOURCE_CHANNEL.toLowerCase()) return;
        if (['left', 'kicked'].includes(upd.new_chat_member.status)) {
            const uid = upd.new_chat_member.user.id;
            if (isAdminId(uid)) return;
            const num = getUserNumber(uid);
            await cancelPairingsOfChat(uid);
            if (num) {
                await fullDisconnect(num);
                removeUser(uid);
                bot.telegram.sendMessage(uid, LANGS.ar.left_channel(num), {}).catch(() => {});
            }
        }
    } catch (_) {}
});

// ==========================================
// 📱 واتساب - الكور الأساسي
// ==========================================
const sockets = {};                    // رقم -> سوكيت نشط
const reconnectAttempts = new Map();
const reconnectTimers = new Map();
const watchdogs = new Map();
const pendingPairs = new Map();        // رقم -> { cid, paired, codeSent, msgId, timer }
const epochs = new Map();
const msgRetryCounterMap = new Map();
const stoppedSessions = new Set();

const getEpoch = (n) => epochs.get(n) || 0;
const bumpEpoch = (n) => { epochs.set(n, getEpoch(n) + 1); return getEpoch(n); };

let cachedWaVersion = null;
let cachedWaVersionAt = 0;
async function getWaVersionSafe() {
    if (cachedWaVersion && Date.now() - cachedWaVersionAt < 60 * 60 * 1000) {
        return cachedWaVersion;
    }
    try {
        const res = await withTimeout(fetchLatestBaileysVersion(), 4000);
        if (res?.version) {
            cachedWaVersion = res.version;
            cachedWaVersionAt = Date.now();
        }
    } catch (_) {}
    return cachedWaVersion;
}

// 🪄 علاج ذاتي للجلسة التالفة (كود 500 متكرر) مع الحفاظ على الربط
function healCorruptedSessionKeys(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    if (!fs.existsSync(sessionPath)) return;
    try {
        const files = fs.readdirSync(sessionPath);
        let cleaned = 0;
        for (const f of files) {
            if (f === 'creds.json' || f.startsWith('app-state-sync-key')) continue;
            if (f.startsWith('session-') || f.startsWith('sender-key-') || f.startsWith('pre-key-')) {
                try { fs.unlinkSync(path.join(sessionPath, f)); cleaned++; } catch (_) {}
            }
        }
        if (cleaned > 0) console.log(`🩺 تنظيف ${cleaned} ملف تشفير معلق للرقم ${cleanNum}`);
    } catch (_) {}
}

function isPairedCreds(creds) {
    return !!(creds && (creds.registered || creds.account || (creds.me?.id && creds.me.name !== '~')));
}
function readSessionCreds(num) {
    try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, num, 'creds.json'), 'utf-8')); }
    catch (_) { return null; }
}
function sessionDirs() {
    try {
        return fs.readdirSync(sessionsDir).filter(f => {
            try { return fs.statSync(path.join(sessionsDir, f)).isDirectory(); } catch (_) { return false; }
        });
    } catch (_) { return []; }
}
function listConnectedSessions() { return sessionDirs().filter(n => isPairedCreds(readSessionCreds(n))); }

function sessionState(num) {
    if (isPairedCreds(readSessionCreds(num))) return 'paired';
    if (pendingPairs.has(num) || sockets[num] || fs.existsSync(path.join(sessionsDir, num))) return 'pending';
    return 'none';
}
function listAllNumbers() {
    return [...new Set([...sessionDirs(), ...pendingPairs.keys(), ...q.allUsers().map(u => u.number)])];
}
function numberStatus(n) {
    const st = sessionState(n);
    if (stoppedSessions.has(n)) return '🛑';
    return st === 'paired' ? '✅' : st === 'pending' ? '⏳' : '⚠️';
}

// ─── تجاهل أخطاء التشفير المعروفة في بايليز ───
const ignoreErrors = ['Bad MAC', 'Key used already', 'No session', 'Failed to decrypt'];
process.on('uncaughtException', (err) => {
    if (ignoreErrors.some(e => err?.message?.includes(e))) return;
    console.error('❌ Uncaught:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
    if (ignoreErrors.some(e => String(err?.message || '').includes(e))) return;
    console.error('❌ Unhandled:', err?.message || err);
});

// ─── إشعارات تليجرام لعملية الربط ───
function tgUpdatePairMsg(p, text, kb) {
    const extra = { disable_web_page_preview: true, ...(kb || {}) };
    const send = () => bot.telegram.sendMessage(p.cid, text, extra).catch(() => {});
    if (p.msgId) bot.telegram.editMessageText(p.cid, p.msgId, null, text, extra).catch(send);
    else send();
}
const retryKb = () => Markup.inlineKeyboard([[cbtn(LANGS.ar.btn_try_again, 'connect', 'success'), cbtn(LANGS.ar.btn_back, 'back', 'primary')]]);

function detachSocket(num) {
    const sock = sockets[num];
    delete sockets[num];
    clearWatchdog(num);
    const t = reconnectTimers.get(num);
    if (t) { clearTimeout(t); reconnectTimers.delete(num); }
    reconnectAttempts.delete(num);
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.ev.removeAllListeners('messages.update');
            sock.ev.removeAllListeners('creds.update');
        } catch (_) {}
    }
    return sock;
}

async function fullDisconnect(numRaw) {
    const num = cleanDigits(numRaw);
    if (!num) return;
    stoppedSessions.delete(num);
    bumpEpoch(num);
    const p = pendingPairs.get(num);
    if (p?.timer) clearTimeout(p.timer);
    pendingPairs.delete(num);

    // إيقاع كل شيء خاص بالحساب (ساعة البايو + تغيير الصور)
    stopClock(num);
    stopRotation(num);
    delete acct[num];

    const sock = detachSocket(num);
    if (sock) {
        if (isPairedCreds(sock.authState?.creds)) {
            try { await Promise.race([sock.logout(), sleep(4000)]); } catch (_) {}
        }
        try { sock.end(undefined); } catch (_) {}
    }
    wipeSessionData(num);
}

async function abortPairing(num, text) {
    const p = pendingPairs.get(num);
    await fullDisconnect(num);
    if (p && p.codeSent && text) tgUpdatePairMsg(p, text, retryKb());
}
async function expirePairing(num) {
    const p = pendingPairs.get(num);
    if (!p || p.paired) return;
    const L = LANGS[langOf(p.cid)] || LANGS.ar;
    await abortPairing(num, L.pair_timeout(num));
}
async function cancelPairingsOfChat(cid) {
    let n = 0;
    for (const [num, p] of [...pendingPairs.entries()]) {
        if (String(p.cid) === String(cid)) { await fullDisconnect(num); n++; }
    }
    return n;
}

function markPaired(num, p) {
    p.paired = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    try { setUserNumber(p.cid, num); } catch (_) {}
}

function scheduleReconnect(cleanNum, delay) {
    const old = reconnectTimers.get(cleanNum);
    if (old) clearTimeout(old);
    const t = setTimeout(async () => {
        reconnectTimers.delete(cleanNum);
        if (sockets[cleanNum]) return;
        if (!fs.existsSync(path.join(sessionsDir, cleanNum))) return;
        try {
            await startWhatsApp(cleanNum);
        } catch (e) {
            console.error(`❌ فشل إعادة اتصال ${cleanNum}:`, e.message);
            if (!sockets[cleanNum] && fs.existsSync(path.join(sessionsDir, cleanNum))) {
                const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
                reconnectAttempts.set(cleanNum, attempt);
                scheduleReconnect(cleanNum, Math.min(30000, 2000 * attempt));
            }
        }
    }, delay);
    reconnectTimers.set(cleanNum, t);
}

// انتظار جاهزية الاتصال قبل طلب كود الربط
// وصول qr يعني ان العميل مسجل عند سيرفرات واتساب وجاهز لاستقبال كود الربط
// احتياط: ws مفتوح + creds.registered = true
function waitForPairingReady(sock, stale, timeoutMs = 60000) {
    return new Promise((resolve) => {
        let done = false;
        let poll = null;
        let hard = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.ev.off('connection.update', onUpdate); } catch (_) {}
            if (poll) clearInterval(poll);
            if (hard) clearTimeout(hard);
            resolve(ok);
        };
        const onUpdate = (u) => {
            if (stale && stale()) return finish(false);
            if (u && u.qr) return finish(true);
            if (u && u.connection === 'open') return finish(true);
            if (u && u.connection === 'close') return finish(false);
        };
        sock.ev.on('connection.update', onUpdate);
        const checkNow = () => {
            if (stale && stale()) return finish(false);
            try {
                const wsReady = sock.ws && sock.ws.readyState === 1;
                const registered = sock.authState && sock.authState.creds && sock.authState.creds.registered;
                if (wsReady && registered) finish(true);
            } catch (_) {}
        };
        hard = setTimeout(() => finish(false), timeoutMs);
        poll = setInterval(checkNow, 1000);
        checkNow();
    });
}

async function startWhatsApp(phoneNumber, pairInfo = null) {
    const cleanNum = cleanDigits(phoneNumber);
    if (!cleanNum) return null;
    const sessionPath = path.join(sessionsDir, cleanNum);

    if (sockets[cleanNum]) return null;

    const myEpoch = getEpoch(cleanNum);
    const stale = () => getEpoch(cleanNum) !== myEpoch;
    const cancelledErr = () => { const e = new Error('تم إلغاء عملية الربط.'); e.cancelled = true; return e; };
    const dropOrphanDir = () => {
        if (!pendingPairs.has(cleanNum) && !sockets[cleanNum]) {
            try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
        }
    };

    if (!pairInfo && !fs.existsSync(sessionPath)) return null;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const paired = isPairedCreds(state.creds);

    let credsQueue = Promise.resolve();
    const safeSaveCreds = () => {
        credsQueue = credsQueue.then(() => saveCreds()).catch(() => {});
        return credsQueue;
    };

    if (!paired && !pairInfo) {
        if (!stale()) await abortPairing(cleanNum, `⚠️ الربط ماكملش للرقم +${cleanNum}\nتم مسح البيانات ، اطلب كود جديد.`);
        return null;
    }

    const version = await getWaVersionSafe();

    if (stale() || sockets[cleanNum]) {
        if (stale()) { dropOrphanDir(); if (pairInfo) throw cancelledErr(); }
        return null;
    }

    const silentLogger = pino({ level: 'fatal' });
    const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, silentLogger)
                : state.keys
        },
        printQRInTerminal: false,
        logger: silentLogger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        msgRetryCounterMap,
        getMessage: async () => undefined
    });

    sockets[cleanNum] = sock;

    sock.ev.on('creds.update', () => {
        if (sockets[cleanNum] !== sock) return;
        safeSaveCreds();
        const p = pendingPairs.get(cleanNum);
        if (p && !p.paired && isPairedCreds(state.creds)) markPaired(cleanNum, p);
    });

    // ─── استقبال الرسايل + كل الأوامر ───
    sock.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        if (upsertType !== 'notify') return;
        for (const msg of messages) {
            try { await onUpsert(cleanNum, sock, msg); } catch (err) {
                console.error(`❌ خطأ معالجة رسالة ${cleanNum}:`, err?.message || err);
            }
            await yieldLoop();
        }
    });

    // ─── التقاط الحذف والتعديل ───
    sock.ev.on('messages.update', async (updates) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        try { await onUpdate(cleanNum, sock, updates); } catch (err) {
            console.error(`❌ خطأ messages.update ${cleanNum}:`, err?.message || err);
        }
    });

    // ─── إدارة الاتصال ───
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (sockets[cleanNum] !== sock) return;
        if (!connection) return;
        console.log(`📡 ${cleanNum}: ${connection}`);

        if (connection === 'close') {
            delete sockets[cleanNum];
            clearWatchdog(cleanNum);

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const nowPaired = isPairedCreds(state.creds);
            const p = pendingPairs.get(cleanNum);

            if (!nowPaired) {
                if (p && !p.codeSent) return;
                console.log(`🧹 ربط ${cleanNum} ماكملش (code ${statusCode ?? '?'}) - إلغاء ومسح`);
                const L = LANGS[langOf(p?.cid)] || LANGS.ar;
                await abortPairing(cleanNum, L.pair_failed(cleanNum));
                return;
            }

            if (FATAL_CODES.includes(statusCode)) {
                console.log(`⚠️ ${cleanNum} جلسة ميتة (code ${statusCode})`);
                const owner = getCidByNumber(cleanNum);
                await fullDisconnect(cleanNum);
                const msgTxt = LANGS.ar.session_dead(cleanNum);
                bot.telegram.sendMessage(ADMIN_ID, msgTxt, {}).catch(() => {});
                if (owner && String(owner) !== String(ADMIN_ID)) {
                    bot.telegram.sendMessage(owner, msgTxt, {}).catch(() => {});
                }
                return;
            }

            try { await safeSaveCreds(); } catch (_) {}
            if (stale() || sockets[cleanNum]) return;
            const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
            reconnectAttempts.set(cleanNum, attempt);

            if (statusCode === 500 && attempt >= 2) {
                healCorruptedSessionKeys(cleanNum);
            }

            let delay;
            if (statusCode === DisconnectReason.restartRequired) {
                delay = 500;
            } else if (statusCode === 500) {
                delay = Math.min(30000, 3000 * attempt);
            } else if (attempt >= MAX_RECONNECT_ATTEMPTS) {
                delay = 60000;
            } else {
                delay = Math.min(25000, 2000 * attempt);
            }
            console.log(`🔄 إعادة اتصال ${cleanNum} بعد ${delay}ms...`);
            scheduleReconnect(cleanNum, delay);

        } else if (connection === 'open') {
            reconnectAttempts.set(cleanNum, 0);
            console.log(`✅ متصل: ${cleanNum}`);
            startWatchdog(cleanNum);
            onAccountOpen(cleanNum, sock);
            const p = pendingPairs.get(cleanNum);
            if (p) {
                if (!p.paired) markPaired(cleanNum, p);
                if (p.timer) clearTimeout(p.timer);
                pendingPairs.delete(cleanNum);
                const L = LANGS[langOf(p.cid)] || LANGS.ar;
                tgUpdatePairMsg(p, L.linked_ok,
                    Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'primary')]]));
            }
        }
    });

    // ─── كود الربط ───
    let pairingCode = null;
    if (!paired) {
        const pend = { cid: pairInfo.cid, paired: false, codeSent: false, msgId: null, timer: null };
        pendingPairs.set(cleanNum, pend);
        // الاصلاح: بدل انتظار 3 ثواني ثابتة ننتظر جاهزية الاتصال الفعلية
        // لان الاتصال على استضافة مثل Railway ممكن ياخد وقت اطول فيفشل طلب الكود
        const ready = await waitForPairingReady(sock, stale, 60000);
        if (!ready) {
            if (!stale()) await fullDisconnect(cleanNum);
            throw new Error('تعذر تجهيز الاتصال بواتساب لطلب كود الربط ، حاول مرة أخرى.');
        }
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (stale()) throw cancelledErr();
            try {
                const code = await withTimeout(sock.requestPairingCode(cleanNum), 30000, 'انتهت مهلة طلب كود الربط');
                const raw = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                pairingCode = raw.length === 8 ? raw.match(/.{1,4}/g).join('-') : code;
                console.log(`🔑 كود الربط لـ ${cleanNum}: ${pairingCode}`);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                console.error(`⚠️ محاولة ${attempt} لطلب كود الربط لـ ${cleanNum} فشلت:`, e?.message || e);
                if (attempt < 2) await sleep(2000);
            }
        }
        if (lastErr) {
            if (!stale()) await fullDisconnect(cleanNum);
            throw new Error('فشل في إنشاء كود الربط، حاول مرة أخرى.');
        }
        if (stale()) throw cancelledErr();
        pend.codeSent = true;
        pend.timer = setTimeout(() => expirePairing(cleanNum).catch(() => {}), PAIR_TIMEOUT_MS);
    }

    return pairingCode;
}

// ─── مراقبة صحة الاتصال ───
function startWatchdog(cleanNum) {
    clearWatchdog(cleanNum);
    const id = setInterval(async () => {
        const sock = sockets[cleanNum];
        if (!sock) return clearWatchdog(cleanNum);
        const wsState = sock.ws?.readyState ?? (sock.ws?.isClosed ? 3 : 1);
        if (wsState === 2 || wsState === 3) {
            if (sockets[cleanNum] !== sock) return;
            console.log(`♻️ سوكيت ${cleanNum} مقفول، إعادة اتصال هادي`);
            detachSocket(cleanNum);
            try { sock.end(undefined); } catch (_) {}
            scheduleReconnect(cleanNum, 1500);
        }
    }, 60000);
    watchdogs.set(cleanNum, id);
}
function clearWatchdog(cleanNum) {
    const id = watchdogs.get(cleanNum);
    if (id) { clearInterval(id); watchdogs.delete(cleanNum); }
}

function wipeSessionData(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    try { fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    try { fs.rmSync(photosDir(cleanNum), { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    try { fs.rmSync(contactsFile(cleanNum), { force: true }); } catch (_) {}
    [`autoreply:${cleanNum}`, `clock:${cleanNum}`, `autorot:${cleanNum}`, `muted:${cleanNum}`].forEach(k => {
        try { delSetting(k); } catch (_) {}
    });
    removeUserByNumber(cleanNum);
}

// ─── تنضيف الأرقام العالقة ───
async function reconcileSessions() {
    let sessions = 0, rows = 0;
    for (const n of sessionDirs()) {
        if (pendingPairs.has(n)) continue;
        if (!isPairedCreds(readSessionCreds(n))) { await fullDisconnect(n); sessions++; }
    }
    const live = new Set(listConnectedSessions());
    for (const u of q.allUsers()) {
        if (!live.has(u.number) && !pendingPairs.has(u.number)) { q.deleteUserByCid(u.cid); rows++; }
    }
    return { sessions, rows };
}

// ─── استعادة الجلسات عند التشغيل ───
async function restoreAll() {
    await reconcileSessions();
    for (const f of listConnectedSessions()) {
        try { await startWhatsApp(f); } catch (e) { console.error(`❌ فشل استعادة ${f}:`, e.message); }
        await sleep(5000);
    }
}

// ==========================================
// 💬 ذاكرة كل حساب + معالجة الرسايل
// ==========================================
const acct = {}; // رقم -> ذاكرة الحساب

function getAcct(num) {
    if (!acct[num]) {
        const A = {
            num,
            nameCache: new Map(),
            msgCache: new Map(),      // chat -> مصفوفة رسايل
            storyCache: new Map(),    // رقم صاحب الاستوري -> Map(id -> entry)
            pending: null,            // عملية انتظار إدخال من المستخدم
            autoreply: '',
            muted: new Map(),         // groupJid -> Set(ارقام)
            contacts: new Set(),
            clock: null,
            rot: null,
            online: null,            // مؤقت الاونلاين الدائم
            editSeen: new Map(),     // منع تكرار تقارير التعديل
            lastAuto: new Map(),     // كولداون الرد التلقائي لكل محادثه
            _ctimer: null
        };
        try { A.autoreply = String(getSetting(`autoreply:${num}`, '') || ''); } catch (_) {}
        try {
            const m = JSON.parse(getSetting(`muted:${num}`, '{}') || '{}');
            for (const [g, arr] of Object.entries(m || {})) A.muted.set(g, new Set(arr || []));
        } catch (_) {}
        try { for (const j of loadContacts(num)) A.contacts.add(j); } catch (_) {}
        acct[num] = A;
    }
    return acct[num];
}

function saveMuted(num, A) {
    const obj = {};
    for (const [g, set] of A.muted) obj[g] = [...set];
    setSetting(`muted:${num}`, JSON.stringify(obj));
}
function saveAutoreply(num, A) { setSetting(`autoreply:${num}`, A.autoreply || ''); }

function addContact(num, A, jid) {
    if (!jid || !jid.endsWith('@s.whatsapp.net')) return;
    if (jid === selfJidOf(num)) return;
    if (A.contacts.has(jid)) return;
    A.contacts.add(jid);
    clearTimeout(A._ctimer);
    A._ctimer = setTimeout(() => writeContacts(num, [...A.contacts]), 2000);
}

function selfNumber(num) { return num; }
function selfJidOf(num) { return `${num}@s.whatsapp.net`; }

function cacheMessage(A, chat, entry) {
    let arr = A.msgCache.get(chat);
    if (!arr) { arr = []; A.msgCache.set(chat, arr); }
    arr.push(entry);
    if (arr.length > 800) arr.splice(0, arr.length - 800);
    A.msgCache.set(chat, arr);
}
function findCached(A, chat, msgId) {
    const arr = A.msgCache.get(chat);
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].key?.id === msgId) return arr[i];
    }
    return null;
}

// ─── عند فتح الاتصال: استعادة الساعة وتغيير الصور ───
function onAccountOpen(num, sock) {
    const A = getAcct(num);
    const clockOrig = getSetting(`clock:${num}`);
    if (clockOrig !== null && clockOrig !== undefined && !A.clock) startClock(num, sock, String(clockOrig));
    const rotSec = getSetting(`autorot:${num}`);
    if (rotSec && fs.existsSync(photosDir(num)) && !A.rot) {
        startRotation(num, sock, parseInt(rotSec) || 10);
    }
    if (getSetting(`online:${num}`) && !A.online) startOnline(num, sock);
}

// ─── ساعة توقيت الجيزة بجانب اسم الحساب (وليس البايو) ───
function startClock(num, sock, origName) {
    const A = getAcct(num);
    stopClock(num, false);
    setSetting(`clock:${num}`, origName || '');
    const tick = async () => {
        const s = sockets[num];
        if (!s) return;
        const name = (origName || s.user?.name || '').trim();
        const t = gizaTime();
        try { await s.updateProfileName(`${name} ⏰ ${t}`); } catch (_) {}
    };
    A.clock = { orig: origName || '', timer: setInterval(tick, 60000) };
    tick().catch(() => {});
}
function stopClock(num, restore = true) {
    const A = getAcct(num);
    if (!A.clock) return;
    clearInterval(A.clock.timer);
    const orig = A.clock.orig;
    A.clock = null;
    delSetting(`clock:${num}`);
    if (restore && orig) {
        const sock = sockets[num];
        if (sock) sock.updateProfileName(orig).catch(() => {});
    }
}

// ─── تغيير صورة البروفايل ───
async function setProfilePictureSafe(sock, jid, buffer, tmpPath) {
    try { await sock.updateProfilePicture(jid, buffer); return true; } catch (_) {}
    try {
        fs.writeFileSync(tmpPath, buffer);
        await sock.updateProfilePicture(jid, { url: tmpPath });
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        return true;
    } catch (_) {}
    return false;
}

function startRotation(num, sock, sec) {
    const A = getAcct(num);
    stopRotation(num, false);
    setSetting(`autorot:${num}`, sec);
    const dir = photosDir(num);
    const timer = setInterval(async () => {
        if (!sockets[num]) return;
        try {
            const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
            if (!files.length) return;
            const f = files[Math.floor(Math.random() * files.length)];
            const buf = fs.readFileSync(path.join(dir, f));
            await setProfilePictureSafe(sock, selfJidOf(num), buf, path.join(dataDir, `tmp_${num}.jpg`));
        } catch (_) {}
    }, Math.max(2, sec) * 1000);
    A.rot = { timer, dir };
}
function stopRotation(num, delSettingKey = true) {
    const A = getAcct(num);
    if (A.rot) { clearInterval(A.rot.timer); A.rot = null; }
    if (delSettingKey) { try { delSetting(`autorot:${num}`); } catch (_) {} }
}

// ─── التقاط الحذف : نص + ميديا (صوره/فيديو/ستيكر/صوتي/ملف/عرض مره واحده) في نفس المحادثه ───
async function reportDeleted(num, sock, key) {
    if (!key || key.fromMe) return;
    const chat = key.remoteJid;
    if (!chat || chat === 'status@broadcast') return;
    const A = getAcct(num);
    const orig = findCached(A, chat, key.id);
    const senderNum = numFromJid(key.participant || chat);
    const senderName = (orig && orig.senderName) || A.nameCache.get(senderNum) || '';
    const now = fmtDate(Math.floor(Date.now() / 1000));
    const head = `تم حذف رساله\n\n` +
        `اسم المستخدم : ${senderName || '(غير معروف)'}\n` +
        `رقم الهاتف : ${fmtPhone(senderNum)}\n`;
    let sent = false;
    // محاولة ارسال محتوى الرسالة المحذوفة (ميديا + نص) في نفس المحادثه
    if (orig && orig.inner) {
        try {
            const dl = await downloadMedia(orig.inner);
            if (dl) {
                const cap = `${head}\nتاريخ الارسال : ${fmtDate(orig.ts)}\nتاريخ الحذف : ${now}` +
                    (orig.text ? `\nالنص : ${orig.text}` : '');
                if (dl.kind === 'image') await sock.sendMessage(chat, { image: dl.buffer, caption: cap });
                else if (dl.kind === 'video') await sock.sendMessage(chat, { video: dl.buffer, caption: cap });
                else if (dl.kind === 'sticker') {
                    await sock.sendMessage(chat, { sticker: dl.buffer });
                    await sock.sendMessage(chat, { text: cap });
                } else if (dl.kind === 'audio') {
                    await sock.sendMessage(chat, { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
                    await sock.sendMessage(chat, { text: cap });
                } else {
                    await sock.sendMessage(chat, { document: dl.buffer, mimetype: dl.mimetype || 'application/octet-stream', fileName: dl.fileName || 'file' });
                    await sock.sendMessage(chat, { text: cap });
                }
                sent = true;
            }
        } catch (_) {}
    }
    if (!sent) {
        const origText = orig ? (orig.text || (orig.media ? `(${orig.media})` : '(غير متوفرة)')) : '(غير محفوظة في الذاكرة)';
        const tsLine = orig ? `تاريخ الارسال : ${fmtDate(orig.ts)}\n` : '';
        const viewLine = (orig && orig.viewOnce) ? `نوع الرساله : عرض مره واحده\n` : '';
        await sock.sendMessage(chat, { text: `${head}${viewLine}\nالرساله : ${origText}\n${tsLine}تاريخ الحذف : ${now}` }).catch(() => {});
    }
    // شيل الرسالة من الكاش
    const arr = A.msgCache.get(chat);
    if (arr) {
        const idx = arr.findIndex(e => e.key?.id === key.id);
        if (idx >= 0) arr.splice(idx, 1);
    }
}

// ─── التقاط التعديل : قبل/بعد + تاريخ الارسال والتعديل + معلومات الشخص في نفس المحادثه ───
async function reportEdited(num, sock, key, newMsg, editTs) {
    if (!key || key.fromMe) return;
    const chat = key.remoteJid;
    if (!chat || chat === 'status@broadcast') return;
    const A = getAcct(num);
    const orig = findCached(A, chat, key.id);
    const senderNum = numFromJid(key.participant || chat);
    const senderName = (orig && orig.senderName) || A.nameCache.get(senderNum) || '';
    const nowSec = Number(editTs) || Math.floor(Date.now() / 1000);
    const inner = unwrapMessage(newMsg).msg || {};
    const newText = extractText(inner) || (mediaKind(inner) ? `(${mediaKind(inner)})` : '(غير متوفرة)');
    const head = `تم تعديل رساله\n\n` +
        `اسم المستخدم : ${senderName || '(غير معروف)'}\n` +
        `رقم الهاتف : ${fmtPhone(senderNum)}\n`;
    // الرسالة بعد التعديل : لو فيها ميديا نحملها ونرسلها كمان
    let afterExtra = '';
    try {
        const dl = await downloadMedia(inner);
        if (dl) {
            if (dl.kind === 'image') await sock.sendMessage(chat, { image: dl.buffer, caption: 'الرساله بعد التعديل' });
            else if (dl.kind === 'video') await sock.sendMessage(chat, { video: dl.buffer, caption: 'الرساله بعد التعديل' });
            else if (dl.kind === 'sticker') await sock.sendMessage(chat, { sticker: dl.buffer });
            else if (dl.kind === 'audio') await sock.sendMessage(chat, { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
            else await sock.sendMessage(chat, { document: dl.buffer, mimetype: dl.mimetype || 'application/octet-stream', fileName: dl.fileName || 'file' });
            afterExtra = ' (مع الميديا المرسله بعد التعديل)';
        }
    } catch (_) {}
    let text;
    if (orig) {
        text = `${head}\n` +
            `الرساله بعد التعديل${afterExtra} : ${newText}\n` +
            `تاريخ التعديل : ${fmtDate(nowSec)}\n\n` +
            `الرساله قبل التعديل : ${orig.text || (orig.media ? `(${orig.media})` : '(غير متوفرة)')}\n` +
            `تاريخ الارسال : ${fmtDate(orig.ts)}`;
        // حدث الكاش بالمحتوى الجديد
        orig.text = newText;
        orig.inner = inner;
    } else {
        text = `${head}\n` +
            `الرساله بعد التعديل${afterExtra} : ${newText}\n` +
            `تاريخ التعديل : ${fmtDate(nowSec)}\n\n` +
            `الرساله قبل التعديل : (غير محفوظة في الذاكرة)`;
    }
    try { await sock.sendMessage(chat, { text }); } catch (_) {}
}

// ─── منع تكرار تقارير التعديل (التعديل بيصل من مسارين) ───
function isDupEdit(A, id) {
    if (!id) return false;
    const now = Date.now();
    const last = A.editSeen.get(id) || 0;
    A.editSeen.set(id, now);
    if (A.editSeen.size > 500) {
        for (const [k, t] of A.editSeen) if (now - t > 300000) A.editSeen.delete(k);
    }
    return (now - last) < 60000;
}

// ─── messages.update : حذف + تعديل ───
const PM_TYPE = (proto && proto.Message && proto.Message.ProtocolMessage && proto.Message.ProtocolMessage.Type) || {};
const PROTO_REVOKE = (PM_TYPE.REVOKE ?? 0);
const PROTO_EDIT = (PM_TYPE.MESSAGE_EDIT ?? 14);

async function onUpdate(num, sock, updates) {
    for (const item of updates || []) {
        const u = item.update || {};
        const key = item.key || u.key;
        if (!key || !key.remoteJid) continue;
        const chat = key.remoteJid;
        if (chat === 'status@broadcast') continue;

        const protoMsg = u.message?.protocolMessage || u.message?.ephemeralMessage?.message?.protocolMessage;

        // حذف
        const isRevoke = u.messageStubType === 1 ||
                         u.messageStubType === 'REVOKE' ||
                         (protoMsg && (protoMsg.type === PROTO_REVOKE || protoMsg.type === 'REVOKE'));
        if (isRevoke) {
            const delKey = (protoMsg?.key && protoMsg.key.remoteJid) ? protoMsg.key : key;
            await reportDeleted(num, sock, delKey).catch(() => {});
            continue;
        }

        // تعديل (بايليز يرسله مغلفاً بـ editedMessage)
        let newMsg = u.message?.editedMessage?.message || null;
        if (protoMsg && protoMsg.type === PROTO_EDIT && protoMsg.editedMessage?.message) {
            newMsg = protoMsg.editedMessage.message;
        }
        if (!newMsg) continue;
        if (newMsg.protocolMessage || newMsg.reactionMessage || newMsg.pollUpdateMessage) continue;
        const editTs = Number(u.messageTimestamp) || Math.floor(Date.now() / 1000);
        if (isDupEdit(getAcct(num), key.id)) continue;
        await reportEdited(num, sock, key, newMsg, editTs).catch(() => {});
    }
}

// ─── messages.upsert : الكاش + الكتم + الرد التلقائي + الأوامر ───
async function onUpsert(num, sock, msg) {
    if (!msg || !msg.key) return;
    const chat = msg.key.remoteJid;
    if (!chat) return;
    const A = getAcct(num);
    const fromMe = !!msg.key.fromMe;

    // الاستوري (status@broadcast)
    if (chat === 'status@broadcast') {
        if (msg.message && msg.key.participant) cacheStory(num, msg);
        return;
    }
    if (chat.endsWith('@newsletter')) return;

    const isRevokeStub = msg.messageStubType === 1 || msg.messageStubType === 'REVOKE';
    if (isRevokeStub) {
        await reportDeleted(num, sock, msg.key).catch(() => {});
        return;
    }
    if (!msg.message) return;

    // التعديل بيصل احيانا عبر upsert مغلفا بـ editedMessage حسب اصدار بايليز — نصطاده من هنا كمان
    const upWrap = unwrapMessage(msg.message);
    if (upWrap.edited) {
        let newContent = upWrap.msg;
        const upProto = msg.message.protocolMessage || upWrap.msg?.protocolMessage;
        if (upProto && upProto.editedMessage?.message) newContent = upProto.editedMessage.message;
        if (newContent && !newContent.protocolMessage && !newContent.reactionMessage && !newContent.pollUpdateMessage) {
            const ekey = (upProto?.key && upProto.key.remoteJid) ? upProto.key : msg.key;
            const editTs = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
            if (!isDupEdit(A, ekey.id)) {
                await reportEdited(num, sock, ekey, newContent, editTs).catch(() => {});
            }
        }
        return;
    }

    const selfNum = num;
    const senderNum = fromMe ? selfNum : numFromJid(msg.key.participant || chat);
    const senderName = msg.pushName || A.nameCache.get(senderNum) || '';
    if (senderName) A.nameCache.set(senderNum, senderName);

    const inner = unwrapMessage(msg.message).msg || {};
    const mKind = mediaKind(inner);
    const text = extractText(inner);
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

    // كاش الرسايل (للحذف/التعديل وأوامر الحذف) — نخزن المحتوى الكامل عشان الميديا المحذوفة
    cacheMessage(A, chat, {
        key: msg.key,
        chat,
        senderNum,
        senderName,
        fromMe,
        text,
        media: mKind,
        inner,
        viewOnce: unwrapMessage(msg.message).viewOnce || !!inner.imageMessage?.viewOnce || !!inner.videoMessage?.viewOnce,
        ts
    });

    // قائمة المحادثات للنشر
    addContact(num, A, chat);

    // كتم: حذف رسايل المكتومين في المجموعات
    if (!fromMe && chat.endsWith('@g.us')) {
        const set = A.muted.get(chat);
        if (set && set.has(senderNum)) {
            try { await sock.sendMessage(chat, { delete: msg.key }); } catch (_) {}
            return;
        }
    }

    // الرد التلقائي: يقرا رسائل المستخدمين في الخاص ويرد عليهم بالرساله المحفوظه
    if (A.autoreply && !fromMe && chat.endsWith('@s.whatsapp.net')) {
        const last = A.lastAuto.get(chat) || 0;
        if (Date.now() - last > 8000) {
            A.lastAuto.set(chat, Date.now());
            const s = sockets[num];
            if (s) {
                console.log(`🤖 رد تلقائي من ${num} إلى ${senderNum}`);
                setTimeout(() => {
                    try { s.sendMessage(chat, { text: A.autoreply }).catch(() => {}); } catch (_) {}
                }, 1200);
            }
        }
    }

    // الأوامر من صاحب الحساب فقط — الميديا بدون نص تمر كمان (صوره/صوتي عشان عمليات الانتظار)
    if (!fromMe) return;
    const body = (text || '').trim();
    const hasMedia = !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.stickerMessage || inner.documentMessage);
    if (!body && !hasMedia) return;
    await handleOwnerInput(num, sock, msg, chat, body, inner, A).catch(err => {
        console.error(`❌ خطأ أمر ${num}:`, err?.message || err);
    });
}

// ─── كاش الاستوري ───
function cacheStory(num, msg) {
    const A = getAcct(num);
    const participant = numFromJid(msg.key.participant);
    if (!participant) return;
    let store = A.storyCache.get(participant);
    if (!store) { store = new Map(); A.storyCache.set(participant, store); }
    const inner = unwrapMessage(msg.message).msg || {};
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    store.set(msg.key.id, { msg, ts });
    // تنظيف القديم (24 ساعة) والزيادة عن 50
    const now = Math.floor(Date.now() / 1000);
    for (const [id, e] of store) {
        if (now - e.ts > 24 * 60 * 60) store.delete(id);
    }
    if (store.size > 50) {
        const sorted = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < sorted.length - 50; i++) store.delete(sorted[i][0]);
    }
}

// ─── رد سريع في محادثة واتساب ───
function waReply(sock, chat, text) {
    return sock.sendMessage(chat, { text }).catch(() => {});
}

// ─── التعامل مع إدخال صاحب الحساب (عمليات الانتظار + توجيه الأوامر) ───
async function handleOwnerInput(num, sock, msg, chat, body, inner, A) {
    const P = A.pending;
    const hasMedia = !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.stickerMessage || inner.documentMessage);

    // أمر الغاء يشغل في أي وقت
    const isCancel = body === 'الغاء العمليه' || body === '.الغاء العمليه' || body === 'الغاء' || body === '.الغاء';

    if (P && P.chat === chat) {
        if (isCancel) {
            A.pending = null;
            if (P.type === 'photointerval') { /* لا نوقف التغيير هنا، الغاء للانتظار فقط */ }
            if (P.type === 'autoreply') { saveAutoreply(num, A); }
            return waReply(sock, chat, 'تم الغاء العملية');
        }
        if (P.type === 'autoreply') {
            // أوامر النقطة تتنفذ عادي ولا تُحفظ كرسالة رد تلقائي
            if (body.startsWith('.')) {
                // نكمل للتوجيه الطبيعي للأوامر تحت
            } else {
                A.autoreply = body;
                saveAutoreply(num, A);
                A.pending = null;
                return waReply(sock, chat, 'تم تفعيل الرد التلقائي\nالرد على المستخدمين في الخاص فقط وليس للمجموعات\nلايقافه ارسل (.ايقاف الرد التلقائي)');
            }
        }
        if (P.type === 'storypick' && /^\d+$/.test(body)) {
            return pickStory(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'storyuser' && /^\d+$/.test(body)) {
            const idx = parseInt(body);
            if (idx < 1 || idx > P.users.length) return waReply(sock, chat, `اختر رقم من 1 الى ${P.users.length}`);
            return openStoryUser(num, sock, chat, P.users[idx - 1], A);
        }
        if (P.type === 'photocollect' && inner.imageMessage) {
            return collectPhoto(num, sock, chat, inner, A);
        }
        if (P.type === 'photocollect' && hasMedia && !body.startsWith('.')) {
            return waReply(sock, chat, `تأكد انك ارسلت صوره فقط (${P.got}/${P.need} تم استلامها)`);
        }
        if (P.type === 'photointerval' && /^\d+$/.test(body)) {
            return finishPhotoInterval(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'rec' && (inner.audioMessage || inner.documentMessage)) {
            return collectRec(num, sock, chat, inner, A);
        }
        if (P.type === 'rec' && hasMedia && !body.startsWith('.')) {
            return waReply(sock, chat, 'تأكد انك ارسلت مقطع صوتي فقط');
        }
        // ما ينفعش نلغي توجيه الأوامر لو المستخدم كتب أمر مختلف
        if (!body.startsWith('.')) return; // انتظار يستمر
    } else if (isCancel) {
        if (body.includes('العمليه')) return waReply(sock, chat, 'لا توجد عملية شغالة حاليا');
        return;
    }

    // كل الاوامر لازم تبدأ بنقطة — مفيش امر يشتغل بدون النقطة ابدا
    if (!body.startsWith('.')) return;
    const b = body.slice(1).trim();
    if (!b) return;

    // توجيه الأوامر (الأطول أولا)
    if (b.startsWith('نشر للمجموعات')) return cmdBroadcastGroups(num, sock, chat, b.slice('نشر للمجموعات'.length).trim(), A);
    if (b.startsWith('نشر')) return cmdBroadcast(num, sock, chat, b.slice('نشر'.length).trim(), A);
    if (b.startsWith('ابعت')) return cmdSend(num, sock, chat, b.slice('ابعت'.length).trim());
    if (b === 'معلوماتي') return cmdMyInfo(num, sock, chat);
    if (b === 'رقمي') return waReply(sock, chat, `رقمي : ${fmtPhone(num)}`);
    if (b.startsWith('رد تلقائي')) return cmdAutoReplyOn(num, sock, chat, b.slice('رد تلقائي'.length).trim(), A);
    if (b === 'ايقاف الرد التلقائي') {
        A.autoreply = '';
        saveAutoreply(num, A);
        return waReply(sock, chat, 'تم ايقاف الرد التلقائي وحذف رساله الرد التلقائي');
    }
    if (b === 'حذف رسائلي') return cmdDeleteMine(num, sock, chat, A);
    if (b === 'حذف جميع الرسائل') return cmdDeleteAll(num, sock, chat, A);
    if (b.startsWith('اسم')) return cmdSetName(num, sock, chat, b.slice('اسم'.length).trim());
    if (b === 'تغيير صورتي') return cmdSetMyPhoto(num, sock, msg, chat);
    if (b === 'كتم') return cmdMute(num, sock, msg, chat, A);
    if (b === 'المكتومين') return cmdMutedList(num, sock, chat, A);
    if (b.startsWith('هل قام بحظري')) return cmdCheckBlock(num, sock, msg, chat, b.slice('هل قام بحظري'.length).trim(), A);
    if (b === 'حظر') return cmdBlock(num, sock, msg, chat);
    if (b.startsWith('سحب استوري')) return cmdStory(num, sock, msg, chat, b.slice('سحب استوري'.length).trim(), A);
    if (b === 'استوري') return cmdStoryList(num, sock, msg, chat, A);
    if (b === 'ريك') return cmdRec(num, sock, msg, chat, A);
    if (b === 'اونلاين') return cmdOnlineOn(num, sock, chat, A);
    if (b === 'ايقاف الاونلاين') return cmdOnlineOff(num, sock, chat, A);
    if (b === 'صوره') return cmdViewOnce(num, sock, msg, chat, 'image', A);
    if (b === 'فيد') return cmdViewOnce(num, sock, msg, chat, 'video', A);
    if (b === 'الاوامر') return waReply(sock, chat, commandsText('ar'));
    if (b === 'تفعيل الوقت') return cmdClockOn(num, sock, chat, A);
    if (b === 'الغاء الوقت') return cmdClockOff(num, sock, chat, A);
    if (b === 'بروفايل') return cmdProfile(num, sock, msg, chat, '', A);
    if (b.startsWith('بروفايل')) return cmdProfile(num, sock, msg, chat, b.slice('بروفايل'.length).trim(), A);
    if (b.startsWith('تغيير صورة تلقائيا') || b.startsWith('تغيير الصورة تلقائيا')) {
        const arg = b.replace('تغيير الصورة تلقائيا', '').replace('تغيير صورة تلقائيا', '').trim();
        return cmdAutoPhoto(num, sock, chat, arg, A);
    }
    if (b === 'ايقاف تغيير صورة') {
        if (!A.rot) return waReply(sock, chat, 'تغيير الصوره التلقائي غير شغال حاليا');
        stopRotation(num);
        return waReply(sock, chat, 'تم ايقاف تغيير صورة البروفايل');
    }
    if (b === 'حذف مجلد الصور الخاص بي') {
        stopRotation(num);
        try { fs.rmSync(photosDir(num), { recursive: true, force: true }); } catch (_) {}
        return waReply(sock, chat, 'تم حذف مجلد الصور الخاص بي بنجاح');
    }
}

// ==========================================
// 🧰 تنفيذ أوامر الواتساب
// ==========================================

// .ابعت (العدد) (الرساله)
async function cmdSend(num, sock, chat, arg) {
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) return waReply(sock, chat, 'استخدام : .ابعت (العدد) (الرساله)\nمثال : .ابعت 5 مرحبا بالجميع');
    const count = Math.min(100, parseInt(m[1]) || 0);
    const txt = m[2];
    if (count < 1) return waReply(sock, chat, 'استخدام : .ابعت (العدد) (الرساله)');
    for (let i = 0; i < count; i++) {
        try { await sock.sendMessage(chat, { text: txt }); } catch (_) {}
        await sleep(700);
    }
}

// .معلوماتي
async function cmdMyInfo(num, sock, chat) {
    const name = sock.user?.name || '(غير معروف)';
    const bio = await getBio(sock, selfJidOf(num));
    return waReply(sock, chat, `معلوماتك\nرقمي : ${fmtPhone(num)}\nاسمي : ${name}\nالبايو : ${bio || '(لا يوجد)'}`);
}

// .رد تلقائي — يقرا رسائل المستخدمين في الخاص ويرد عليهم تلقائيا
async function cmdAutoReplyOn(num, sock, chat, arg, A) {
    // كتابة الرسالة مباشرة بعد الامر : .رد تلقائي اهلا بكم
    if (arg) {
        A.autoreply = arg;
        saveAutoreply(num, A);
        return waReply(sock, chat, 'تم تفعيل الرد التلقائي\nالبوت هيقرا رسايل المستخدمين في الخاص ويرد عليهم بالرساله دي\nلايقافه ارسل (.ايقاف الرد التلقائي)');
    }
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    A.pending = { type: 'autoreply', chat };
    return waReply(sock, chat, 'ارسل رساله الرد التلقائي لجعل حسابك يرد على جميع محادثات الخاص للمستخدمين بالرساله\nلل الغاء ارسال (الغاء)');
}

// .حذف رسائلي — حذف كل رسائلي في المحادثه + تحقق من الحذف الكامل
async function cmdDeleteMine(num, sock, chat, A) {
    const arr = A.msgCache.get(chat) || [];
    const mine = arr.filter(e => e.fromMe);
    if (!mine.length) return waReply(sock, chat, 'لا توجد رسايل محفوظه للحذف في هذه المحادثه');
    await waReply(sock, chat, `جاري حذف رسائلك (${mine.length} رساله) ...`);
    let ok = 0, fail = 0;
    const failed = [];
    for (const e of mine) {
        let done = false;
        try { await sock.sendMessage(chat, { delete: e.key }); done = true; } catch (_) { await sleep(300); }
        if (done) ok++; else failed.push(e);
        await sleep(300);
    }
    // التحقق النهائي : أي رسالة فشل حذفها نحاول مرة اخيرة
    for (const e of failed) {
        try { await sock.sendMessage(chat, { delete: e.key }); ok++; } catch (_) { fail++; }
        await sleep(250);
    }
    A.msgCache.set(chat, (A.msgCache.get(chat) || []).filter(e => !e.fromMe));
    let txt = `تم حذف ${ok} رساله من رسائلك في هذه المحادثه`;
    if (fail) txt += `\nفشل حذف ${fail} رساله (غالبا رسائل قديمه جدا او محذوفه من قبل)`;
    return waReply(sock, chat, txt);
}

// .حذف جميع الرسائل — رسائلي + رسائل الطرف الآخر في نفس المحادثه مع التحقق
async function cmdDeleteAll(num, sock, chat, A) {
    const arr = A.msgCache.get(chat) || [];
    if (!arr.length) return waReply(sock, chat, 'لا توجد رسايل محفوظه للحذف في هذه المحادثه');
    await waReply(sock, chat, `جاري حذف جميع الرسائل (${arr.length} رساله) من الطرفين ...`);
    const isGroup = chat.endsWith('@g.us');
    let okMine = 0, failMine = 0, okOther = 0, failOther = 0;
    const failedMine = [], failedOther = [];
    for (const e of arr) {
        let done = false;
        try { await sock.sendMessage(chat, { delete: e.key }); done = true; } catch (_) { await sleep(300); }
        if (e.fromMe) { if (done) okMine++; else failedMine.push(e); }
        else { if (done) okOther++; else failedOther.push(e); }
        await sleep(300);
    }
    // التحقق النهائي : أي رسالة فشل حذفها نحاول مرة اخيرة
    for (const e of failedMine) {
        try { await sock.sendMessage(chat, { delete: e.key }); okMine++; } catch (_) { failMine++; }
        await sleep(250);
    }
    for (const e of failedOther) {
        try { await sock.sendMessage(chat, { delete: e.key }); okOther++; } catch (_) { failOther++; }
        await sleep(250);
    }
    A.msgCache.set(chat, []);
    let txt = `نتيجة حذف جميع الرسائل في هذه المحادثه :\n\n` +
        `رسائلك : تم حذف ${okMine}${failMine ? ` | فشل ${failMine}` : ''}\n` +
        `رسائل الطرف الآخر : تم حذف ${okOther}${failOther ? ` | فشل ${failOther}` : ''}`;
    if (!isGroup && failOther) txt += `\n\nملحوظة : رسائل الطرف الآخر في الخاص لا يمكن حذفها للطرفين حسب نظام واتساب — يتم حذف رسائلك فقط`;
    return waReply(sock, chat, txt);
}

// .اسم (الاسم الجديد)
async function cmdSetName(num, sock, chat, arg) {
    if (!arg) return waReply(sock, chat, 'استخدام : .اسم (الاسم الذي يريد المستخدم ان يغيره)\nمثال : .اسم محمود');
    const old = sock.user?.name || '(غير معروف)';
    try {
        await sock.updateProfileName(arg);
        return waReply(sock, chat, `تم تغيير الاسم بنجاح\n\nالاسم قبل التغيير : ${old}\nالاسم الذي تم تغييره : ${arg}`);
    } catch (_) {
        return waReply(sock, chat, 'فشل تغيير الاسم ، حاول مرة أخرى');
    }
}

// .تغيير صورتي (بالرد على صوره)
async function cmdSetMyPhoto(num, sock, msg, chat) {
    const q = getQuoted(msg);
    if (!q) return waReply(sock, chat, 'قم بالرد على الصورة المراد اضافتها كبروفايل ب امر (.تغيير صورتي)');
    const dl = await downloadMedia(q.msg, 'imageMessage') || await downloadMedia(q.msg);
    if (!dl) return waReply(sock, chat, 'تأكد انك قمت بالرد على صوره');
    const ok = await setProfilePictureSafe(sock, selfJidOf(num), dl.buffer, path.join(dataDir, `tmp_${num}.jpg`));
    return waReply(sock, chat, ok ? 'تم تغيير صورة الحساب بنجاح' : 'فشل تغيير صورة الحساب ، حاول مرة أخرى');
}

// .كتم (في المجموعات - بالرد على رسالة المستخدم)
async function cmdMute(num, sock, msg, chat, A) {
    if (!chat.endsWith('@g.us')) return waReply(sock, chat, 'هاذا الامر يعمل فقط في المجموعات');
    let meta;
    try { meta = await sock.groupMetadata(chat); } catch (_) { return waReply(sock, chat, 'خطأ في جلب بيانات المجموعة'); }
    const me = meta.participants.find(p => p.id === selfJidOf(num) || numFromJid(p.id) === num);
    if (!me || (!me.isAdmin && !me.isSuperAdmin)) {
        return waReply(sock, chat, 'يجب ان يكون الحساب ادمن في المجموعة');
    }
    const q = getQuoted(msg);
    if (!q || !q.participant) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم الذي تريد كتمه');
    const targetNum = numFromJid(q.participant);
    if (!targetNum) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم الذي تريد كتمه');
    if (!A.muted.has(chat)) A.muted.set(chat, new Set());
    A.muted.get(chat).add(targetNum);
    saveMuted(num, A);
    // حذف الرسالة المردود عليها لو امكن
    if (q.stanzaId) {
        try {
            await sock.sendMessage(chat, {
                delete: { id: q.stanzaId, remoteJid: chat, fromMe: false, participant: q.participant }
            });
        } catch (_) {}
    }
    return waReply(sock, chat, `تم كتم المستخدم : ${fmtPhone(targetNum)}\nسيتم حذف رسائله في هذه المجموعة تلقائيا`);
}

// .المكتومين
async function cmdMutedList(num, sock, chat, A) {
    if (!chat.endsWith('@g.us')) return waReply(sock, chat, 'هاذا الامر يعمل فقط في المجموعات');
    const set = A.muted.get(chat);
    if (!set || !set.size) return waReply(sock, chat, 'لا يوجد مستخدمين مكتومين في هذه المجموعة');
    const lines = [...set].map((n, i) => {
        const nm = A.nameCache.get(n);
        return `${i + 1} : ${fmtPhone(n)}${nm ? ` (${nm})` : ''}`;
    });
    return waReply(sock, chat, `المكتومين في هذه المجموعة :\n\n${lines.join('\n')}`);
}

// .هل قام بحظري
async function cmdCheckBlock(num, sock, msg, chat, arg, A) {
    let targetJid = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) {
        targetJid = `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        const q = getQuoted(msg);
        if (q && q.participant) targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
        else if (chat.endsWith('@s.whatsapp.net')) targetJid = chat;
    }
    if (!targetJid) return waReply(sock, chat, 'استخدام : .هل قام بحظري (رقم الهاتف)\nاو قم بالرد على رسالة المستخدم');
    const targetNum = numFromJid(targetJid);
    const res = await checkBlocked(sock, targetJid);
    if (res === 'not_on_whatsapp') return waReply(sock, chat, `الرقم ${fmtPhone(targetNum)} غير موجود على واتساب`);
    if (res === 'blocked') return waReply(sock, chat, `لقد قام بحظرك : ${fmtPhone(targetNum)}`);
    return waReply(sock, chat, `لا لم يقم بحظرك : ${fmtPhone(targetNum)}`);
}

// فحص الحظر (فحص متعدد : الصورة + البايو + الحضور)
async function checkBlocked(sock, jid) {
    try {
        const res = await sock.onWhatsApp(numFromJid(jid));
        if (!res || !res[0] || !res[0].exists) return 'not_on_whatsapp';
    } catch (_) {}
    let signals = 0;
    try { await sock.profilePictureUrl(jid, 'image'); signals++; } catch (_) {}
    try {
        const st = await sock.fetchStatus(jid);
        if (st && !Array.isArray(st) && st.status !== undefined) signals++;
        else if (Array.isArray(st) && st.length) signals++;
    } catch (_) {}
    try {
        const got = await new Promise((resolve) => {
            const t = setTimeout(() => { cleanup(); resolve(false); }, 2500);
            const h = (u) => {
                if (numFromJid(u?.jid || '') === numFromJid(jid)) { cleanup(); resolve(true); }
            };
            function cleanup() { clearTimeout(t); try { sock.ev.off('presence.update', h); } catch (_) {} }
            sock.ev.on('presence.update', h);
            sock.presenceSubscribe(jid).catch(() => {});
        });
        if (got) signals++;
    } catch (_) {}
    return signals > 0 ? 'not_blocked' : 'blocked';
}

// .حظر
async function cmdBlock(num, sock, msg, chat) {
    let targetJid = null;
    const q = getQuoted(msg);
    if (chat.endsWith('@g.us')) {
        if (!q || !q.participant) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم لحظره');
        targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
    } else {
        targetJid = chat;
    }
    const targetNum = numFromJid(targetJid);
    try {
        await sock.updateBlockStatus(targetJid, 'block');
        return waReply(sock, chat, `تم حظر المستخدم بنجاح : ${fmtPhone(targetNum)}`);
    } catch (_) {
        return waReply(sock, chat, 'فشل حظر المستخدم ، حاول مرة أخرى');
    }
}

// .استوري : قائمه بجميع الحسابات المحفوظ استوريهاتها (الاسم + الرقم + العدد)
async function cmdStoryList(num, sock, msg, chat, A) {
    const users = [];
    for (const [pnum, store] of A.storyCache) {
        if (store && store.size) {
            let mx = 0;
            for (const e of store.values()) if (e.ts > mx) mx = e.ts;
            users.push({ num: pnum, name: A.nameCache.get(pnum) || '', count: store.size, ts: mx });
        }
    }
    users.sort((a, b) => b.ts - a.ts);
    if (!users.length) {
        return waReply(sock, chat, 'لا توجد استوري محفوظه حاليا\nيتم حفظ جميع الاستوريهات تلقائيا لكل الحسابات فور نشرها والبوت متصل\nجرم ارسل (.استوري) بعد ما حد ينشر استوري');
    }
    const lines = users.map((u, i) =>
        `${i + 1} : ${u.name || '(بدون اسم)'} | ${fmtPhone(u.num)} | ${u.count} استوري`);
    A.pending = { type: 'storyuser', chat, users: users.map(u => u.num) };
    return waReply(sock, chat,
        `قائمه الاستوري المحفوظه (${users.length} حساب)\n\n` +
        `${lines.join('\n')}\n\n` +
        `ارسل رقم الحساب من 1 الى ${users.length} لعرض استوريهاته بالتفصيل\n` +
        `للغاء ارسال (.الغاء)`);
}

// .سحب استوري (الرقم) : عرض استوريهات رقم معين بالتفصيل
async function cmdStory(num, sock, msg, chat, arg, A) {
    let targetNum = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) targetNum = arg.replace(/\D/g, '');
    else {
        const q = getQuoted(msg);
        if (q && q.participant) targetNum = numFromJid(q.participant);
        else if (chat.endsWith('@s.whatsapp.net')) targetNum = numFromJid(chat);
    }
    if (!targetNum) {
        return waReply(sock, chat, 'استخدام : .سحب استوري (رقم هاتف المستخدم)\nمثال : .سحب استوري 20123456789\nاو ارسل (.استوري) لعرض قائمه بجميع الحسابات');
    }
    return openStoryUser(num, sock, chat, targetNum, A);
}

// عرض استوريهات حساب معين بالاحصائيات (نوع + مدة الفيديو + النص) مرقمنه
async function openStoryUser(num, sock, chat, targetNum, A) {
    const store = A.storyCache.get(targetNum);
    if (!store || !store.size) {
        return waReply(sock, chat, `لا توجد استوري محفوظه للرقم ${fmtPhone(targetNum)} حاليا\nملاحظة : يتم حفظ الاستوري بعد ارسالها من صاحب الرقم والبوت متصل`);
    }
    const entries = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
    let images = 0, videos = 0, texts = 0;
    const lines = entries.map(([id, e], i) => {
        const inner = unwrapMessage(e.msg.message).msg || {};
        const cap = (extractText(inner) || '').trim();
        if (inner.imageMessage) {
            images++;
            return `${i + 1} : صوره${cap ? ` | نص : ${cap.slice(0, 40)}` : ' | بدون نص'} | حجم ${fmtSize(inner.imageMessage.fileLength)}`;
        }
        if (inner.videoMessage) {
            videos++;
            return `${i + 1} : فيديو | مدة ${inner.videoMessage.seconds || '?'} ثانيه${cap ? ` | نص : ${cap.slice(0, 40)}` : ''} | حجم ${fmtSize(inner.videoMessage.fileLength)}`;
        }
        texts++;
        return `${i + 1} : نص | ${cap.slice(0, 60) || '(فارغ)'}`;
    });
    const total = entries.length;
    A.pending = { type: 'storypick', chat, list: entries.map(x => x[1]), target: targetNum };
    const name = A.nameCache.get(targetNum) || '';
    return waReply(sock, chat,
        `استوري : ${name || '(بدون اسم)'} | ${fmtPhone(targetNum)}\n\n` +
        `عدد الاستوري : ${total}\n` +
        `الصور : ${images}\n` +
        `الفيديوهات : ${videos}\n` +
        `النصوص : ${texts}\n\n` +
        `${lines.join('\n')}\n\n` +
        `ارسل رقم الاستوري من 1 الى ${total} لتحميله وارساله هنا مع الكابشن الذي عليه\n` +
        `للغاء ارسال (.الغاء)`);
}

async function pickStory(num, sock, chat, idx, A) {
    const P = A.pending;
    if (!P || P.type !== 'storypick') return;
    const i = idx - 1;
    if (!P.list || i < 0 || i >= P.list.length) {
        return waReply(sock, chat, `اختر رقم من 1 الى ${P.list.length}`);
    }
    const entry = P.list[i];
    A.pending = null;
    const inner = unwrapMessage(entry.msg.message).msg || {};
    const storyCap = (extractText(inner) || '').trim();
    const name = A.nameCache.get(P.target) || '';
    const caption = `استوري ${name ? name + ' ' : ''}${fmtPhone(P.target)}${storyCap ? `\n\n${storyCap}` : ''}`;
    if (inner.imageMessage || inner.videoMessage) {
        const dl = await downloadMedia(inner);
        if (!dl) return waReply(sock, chat, 'فشل تحميل الاستوري ، حاول مرة أخرى');
        if (dl.kind === 'image') {
            await sock.sendMessage(chat, { image: dl.buffer, caption }).catch(() => {});
        } else {
            await sock.sendMessage(chat, { video: dl.buffer, mimetype: dl.mimetype || 'video/mp4', caption }).catch(() => {});
        }
        return;
    }
    const t = extractText(inner);
    if (t) {
        await sock.sendMessage(chat, { text: caption }).catch(() => {});
        return;
    }
    return waReply(sock, chat, 'فشل تحميل الاستوري');
}

// .ريك : ارسال المقطع الصوتي كرساله صوتيه (ريكورد) لرقمك الشخصي
async function cmdRec(num, sock, msg, chat, A) {
    const q = getQuoted(msg);
    if (q) {
        const qi = unwrapMessage(q.msg).msg || {};
        if (qi.audioMessage || qi.documentMessage) {
            const dl = await downloadMedia(qi, 'audioMessage') || await downloadMedia(qi);
            if (dl) return sendRec(num, sock, chat, dl);
            return waReply(sock, chat, 'تأكد انك ردت على مقطع صوتي');
        }
        return waReply(sock, chat, 'قم بالرد على مقطع صوتي او ارسل المقطع الصوتي بعد الامر');
    }
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    A.pending = { type: 'rec', chat };
    return waReply(sock, chat, 'ارسل الان المقطع الصوتي وسارسله لرقمك الشخصي كرساله صوتيه (ريكورد)\nللغاء ارسال (.الغاء)');
}
async function collectRec(num, sock, chat, inner, A) {
    A.pending = null;
    const dl = await downloadMedia(inner, 'audioMessage') || await downloadMedia(inner);
    if (!dl) return waReply(sock, chat, 'تأكد انك ارسلت مقطع صوتي');
    return sendRec(num, sock, chat, dl);
}
async function sendRec(num, sock, chat, dl) {
    try {
        await sock.sendMessage(selfJidOf(num), { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
        return waReply(sock, chat, 'تم ارسال الريكورد (المقطع الصوتي) لرقمك الشخصي');
    } catch (_) {
        return waReply(sock, chat, 'فشل ارسال الريكورد ، حاول مرة أخرى');
    }
}

// .اونلاين : الحساب يفضل نشط اونلاين بشكل دائم
function startOnline(num, sock) {
    const A = getAcct(num);
    stopOnline(num, false);
    setSetting(`online:${num}`, '1');
    const tick = async () => {
        const s = sockets[num];
        if (!s) return;
        try { await s.sendPresenceUpdate('available'); } catch (_) {}
    };
    A.online = { timer: setInterval(tick, 50000) };
    tick().catch(() => {});
    console.log(`🟢 اونلاين دائم مفعيل لـ ${num}`);
}
function stopOnline(num, sendOff = true) {
    const A = getAcct(num);
    if (A.online) { clearInterval(A.online.timer); A.online = null; }
    delSetting(`online:${num}`);
    if (sendOff) {
        const s = sockets[num];
        if (s) s.sendPresenceUpdate('unavailable').catch(() => {});
    }
}
async function cmdOnlineOn(num, sock, chat, A) {
    if (A.online) return waReply(sock, chat, 'الاونلاين مفعيل بالفعل\nلايقافه ارسل (.ايقاف الاونلاين)');
    startOnline(num, sock);
    return waReply(sock, chat, 'تم تفعيل الاونلاين\nحسابك هيفضل نشط اونلاين بشكل دائم وبيتم تحديث الحضور كل 50 ثانيه\nلايقافه ارسل (.ايقاف الاونلاين)');
}
async function cmdOnlineOff(num, sock, chat, A) {
    if (!A.online) return waReply(sock, chat, 'الاونلاين غير مفعيل حاليا');
    stopOnline(num);
    return waReply(sock, chat, 'تم ايقاف الاونلاين');
}

// .صوره / .فيد : التقاط عرض مرة واحدة
async function cmdViewOnce(num, sock, msg, chat, kind, A) {
    let dl = null;
    let fromNum = null;
    const q = getQuoted(msg);
    if (q) {
        fromNum = q.participant ? numFromJid(q.participant) : numFromJid(chat);
        dl = await downloadMedia(q.msg, kind === 'image' ? 'imageMessage' : 'videoMessage');
    }
    if (!dl) {
        return waReply(sock, chat, kind === 'image'
            ? 'قم بالرد على الصورة التي تعرض لمره واحده ب امر (.صوره)'
            : 'قم بالرد على الفيديو الذي يعرض لمره واحده ب امر (.فيد)');
    }
    if (kind === 'image') {
        await sock.sendMessage(selfJidOf(num), { image: dl.buffer, caption: `تم التقاط الصوره | من : +${fromNum}` }).catch(() => {});
        return waReply(sock, chat, 'تم التقاط الصوره وارسالها لرقم هاتفك');
    }
    await sock.sendMessage(selfJidOf(num), { video: dl.buffer, mimetype: dl.mimetype || 'video/mp4', caption: `تم التقاط الفيديو | من : +${fromNum}` }).catch(() => {});
    return waReply(sock, chat, 'تم التقاط الفيديو وارساله لرقم هاتفك');
}

// .نشر (الرساله) : لجميع المحادثات وليس المجموعات
async function cmdBroadcast(num, sock, chat, text, A) {
    if (!text) return waReply(sock, chat, 'استخدام : .نشر (الرساله)\nمثال : .نشر مرحبا بالجميع');
    const targets = [...A.contacts].filter(j => j.endsWith('@s.whatsapp.net') && numFromJid(j) !== num);
    if (!targets.length) return waReply(sock, chat, 'لا توجد محادثات محفوظه للنشر\nالمحادثات تتسجل تلقائيا بعد اي رساله جديدة');
    let ok = 0;
    for (const j of targets) {
        try { await sock.sendMessage(j, { text }); ok++; } catch (_) {}
        await sleep(1200);
    }
    return waReply(sock, chat, `تم النشر الى ${ok} محادثه`);
}

// .نشر للمجموعات (الرساله)
async function cmdBroadcastGroups(num, sock, chat, text, A) {
    if (!text) return waReply(sock, chat, 'استخدام : .نشر للمجموعات (الرساله)');
    let groups = [];
    try { groups = await sock.groupFetchAllParticipating(); } catch (_) {}
    const ids = Object.keys(groups || {});
    if (!ids.length) return waReply(sock, chat, 'لا توجد مجموعات');
    let ok = 0;
    for (const id of ids) {
        try { await sock.sendMessage(id, { text }); ok++; } catch (_) {}
        await sleep(1500);
    }
    return waReply(sock, chat, `تم النشر الى ${ok} مجموعه`);
}

// تفعيل الوقت : ساعة توقيت الجيزة بجانب اسم الحساب تتحدث كل دقيقة
async function cmdClockOn(num, sock, chat, A) {
    if (A.clock) return waReply(sock, chat, 'الوقت مفعيل بالفعل\nلايقافه ارسل (.الغاء الوقت)');
    const origName = (sock.user?.name || '').trim();
    startClock(num, sock, origName);
    return waReply(sock, chat, 'تم تفعيل الوقت\nتم وضع ساعة توقيت الجيزة بجانب اسم حسابك وستتحدث كل دقيقه\nلايقافها ارسل (.الغاء الوقت)');
}

// .الغاء الوقت
async function cmdClockOff(num, sock, chat, A) {
    if (!A.clock) return waReply(sock, chat, 'الوقت غير مفعيل حاليا');
    stopClock(num);
    return waReply(sock, chat, 'تم ايقاف الوقت واسترجاع اسم حسابك بدون الساعه');
}

// .بروفايل : صورة ومعلومات الحساب ترسل لرقم المستخدم نفسه
async function cmdProfile(num, sock, msg, chat, arg, A) {
    let targetJid = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) {
        targetJid = `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        const q = getQuoted(msg);
        if (q && q.participant) targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
        else targetJid = chat;
    }
    if (targetJid === 'status@broadcast') return;
    const targetNum = numFromJid(targetJid);
    const name = A.nameCache.get(targetNum) || (targetNum === num ? (sock.user?.name || '') : '') || '(غير معروف)';
    const bio = await getBio(sock, targetJid);
    let pic = null;
    try { pic = await sock.profilePictureUrl(targetJid, 'image'); } catch (_) {}
    const info = `معلومات الحساب\nالاسم : ${name}\nالرقم : ${fmtPhone(targetNum)}\nالبايو : ${bio || '(لا يوجد)'}`;
    if (pic) {
        try {
            const buf = await httpsGetBuffer(pic);
            await sock.sendMessage(selfJidOf(num), { image: buf, caption: info }).catch(() => {});
            return;
        } catch (_) {}
    }
    await sock.sendMessage(selfJidOf(num), { text: info }).catch(() => {});
}

function httpsGetBuffer(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });
}

// .تغيير صورة تلقائيا (عدد الصور)
async function cmdAutoPhoto(num, sock, chat, arg, A) {
    if (A.rot) return waReply(sock, chat, 'تغيير الصوره التلقائي شغال بالفعل\nلايقافه ارسل (.ايقاف تغيير صورة)');
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    const count = parseInt(arg);
    if (!count || count < 1 || count > 20) {
        return waReply(sock, chat, 'استخدام : .تغيير صورة تلقائيا (عدد الصور)\nمثال : .تغيير صورة تلقائيا 5');
    }
    A.pending = { type: 'photocollect', chat, need: count, got: 0 };
    return waReply(sock, chat,
        `ارسل ${count} صوره الان وسيتم حفظها على السيرفر في مجلد باسم رقم هاتفك\n` +
        `بعد اكمال العدد كله سيتم طلب عدد الثواني بين كل تغيير للصوره\n` +
        `يمكنك الغاء العملية ب امر (الغاء العمليه)`);
}

// استلام صور العملية
async function collectPhoto(num, sock, chat, inner, A) {
    const P = A.pending;
    const dl = await downloadMedia(inner, 'imageMessage');
    if (!dl) return waReply(sock, chat, 'تأكد انك ارسلت صوره');
    const dir = photosDir(num);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    P.got++;
    const fp = path.join(dir, `photo_${P.got}_${Date.now()}.jpg`);
    try { fs.writeFileSync(fp, dl.buffer); } catch (_) {}
    if (P.got < P.need) {
        return waReply(sock, chat, `تم استلام (${P.got}/${P.need}) صوره`);
    }
    A.pending = { type: 'photointerval', chat };
    return waReply(sock, chat,
        `تم حفظ جميع الصور (${P.need}) في مجلد باسم رقمك\n` +
        `الان ارسل عدد الثواني بين كل تغيير للصوره\n` +
        `ثانيتين ب حد ادنى و 600 ثانية (10 دقائق) ب حد اقصى\n` +
        `يمكنك الغاء العملية ب امر (الغاء العمليه)`);
}

// اختيار المدة وبدء التغيير العشوائي
async function finishPhotoInterval(num, sock, chat, sec, A) {
    A.pending = null;
    sec = Math.max(2, Math.min(600, sec));
    const dir = photosDir(num);
    try {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        if (!files.length) return waReply(sock, chat, 'لا توجد صور محفوظه');
    } catch (_) { return waReply(sock, chat, 'لا يوجد مجلد صور'); }
    startRotation(num, sock, sec);
    // تغيير أول صورة فورا
    try {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        const f = files[Math.floor(Math.random() * files.length)];
        const buf = fs.readFileSync(path.join(dir, f));
        await setProfilePictureSafe(sock, selfJidOf(num), buf, path.join(dataDir, `tmp_${num}.jpg`));
    } catch (_) {}
    return waReply(sock, chat,
        `تم بدء تغيير صورة البروفايل تلقائيا كل ${sec} ثانية بالصور الموجودة عشوائيا\n` +
        `لايقافه ارسل (.ايقاف تغيير صورة)\n` +
        `ولحذف مجلد الصور ارسل (.حذف مجلد الصور الخاص بي)`);
}

// ==========================================
// 🛡️ مراقب اتصال التليجرام الذاتي
// ==========================================
let tgLaunching = false;
let tgFailCount = 0;

async function startTelegramPolling() {
    if (tgLaunching) return;
    tgLaunching = true;
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        bot.launch({
            allowedUpdates: ['message', 'callback_query', 'chat_member'],
            dropPendingUpdates: false
        }).catch((err) => {
            console.error('⚠️ توقف Polling التليجرام، جاري إعادة التشغيل خلال 5 ثواني:', err?.message || err);
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 5000);
        });
        console.log('✅ بوت التليجرام شغال وجاهز لاستقبال الرسايل!');
    } catch (e) {
        console.error('❌ خطأ في تشغيل التليجرام:', e.message);
        tgLaunching = false;
        setTimeout(() => startTelegramPolling(), 5000);
    }
}

setInterval(async () => {
    try {
        await withTimeout(bot.telegram.getMe(), 15000, 'Telegram ping timeout');
        tgFailCount = 0;
    } catch (e) {
        tgFailCount++;
        console.warn(`⚠️ فشل فحص اتصال التليجرام (${tgFailCount}): ${e.message}`);
        if (tgFailCount >= 3) {
            tgFailCount = 0;
            try { bot.stop('restart'); } catch (_) {}
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 2000);
        }
    }
}, 45000);

// ==========================================
// 🚀 التشغيل
// ==========================================
(async () => {
    console.log('🤖 WhatsApp Bot - Telegram Panel v2');
    await initDb();
    console.log('🗄️ قاعدة البيانات جاهزة');

    // وضع فحص بدون تشغيل (للتجربة فقط)
    if (process.env.START_BOT === '0') {
        console.log('✅ Dry-run OK : الملف سليم وقاعدة البيانات جاهزة');
        process.exit(0);
    }

    await startTelegramPolling();
    restoreAll().catch(e => console.error('❌ خطأ أثناء استعادة الجلسات:', e.message));

    const shutdown = () => {
        try { bot.stop('SIGTERM'); } catch (_) {}
        try { if (db) fs.writeFileSync(dbFile, Buffer.from(db.export())); } catch (_) {}
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
})();
