require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Add FFmpeg to PATH when a custom path is provided.
const FFMPEG_PATH = process.env.FFMPEG_PATH || '';
if (FFMPEG_PATH) {
  process.env.PATH = `${FFMPEG_PATH}${path.delimiter}${process.env.PATH}`;
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'downloader-bot-media';
const GLOBAL_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';
const YOUTUBE_COOKIES_URL = process.env.YTDLP_YOUTUBE_COOKIES_URL || 'https://dkdxufqgmhigfhnkisdt.supabase.co/storage/v1/object/public/downloader-bot-media/cookies.txt';
const SOCIAL_COOKIES_URL = process.env.YTDLP_SOCIAL_COOKIES_URL || 'https://dkdxufqgmhigfhnkisdt.supabase.co/storage/v1/object/public/downloader-bot-media/cookies2.txt';
let YOUTUBE_COOKIES_FILE = process.env.YTDLP_YOUTUBE_COOKIES_FILE || (fs.existsSync(path.join(__dirname, 'cookies.txt')) ? path.join(__dirname, 'cookies.txt') : GLOBAL_COOKIES_FILE);
let SOCIAL_COOKIES_FILE = process.env.YTDLP_SOCIAL_COOKIES_FILE || (fs.existsSync(path.join(__dirname, 'cookies2.txt')) ? path.join(__dirname, 'cookies2.txt') : GLOBAL_COOKIES_FILE);
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Forced channel subscription
const FORCED_CHANNEL_ID = process.env.FORCED_CHANNEL_ID || '';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || ''; // e.g., @mychannel

// Helper: Check if user is subscribed to the forced channel
async function checkChannelSubscription(chatId) {
  if (!FORCED_CHANNEL_ID) {
    // No forced channel configured, allow access
    return true;
  }

  try {
    const member = await bot.getChatMember(FORCED_CHANNEL_ID, chatId);
    // User is a member if status is: member, administrator, or creator
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error(`Error checking channel subscription for ${chatId}:`, error.message);
    // If we can't check, allow access (fail-safe)
    return true;
  }
}

// Helper: Send channel subscription required message
function sendChannelSubscriptionMessage(chatId) {
  const channelLink = CHANNEL_USERNAME ? `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` : 'القناة';
  
  const message = `
⚠️ *استخدام البوت يتطلب الاشتراك في القناة*

📢 يجب عليك الاشتراك في قناتنا أولاً لاستخدام البوت

👇 *اشترك الآن:*
[${CHANNEL_USERNAME || 'اضغط هنا للاشتراك'}](${channelLink})

✅ *بعد الاشتراك:*
1️⃣ عد للبوت
2️⃣ أرسل /start
3️⃣ استمتع بالتحميل!

_سيتم التحقق تلقائياً من اشتراكك_
  `;

  bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📢 اشترك في القناة', url: channelLink }
      ]]
    }
  });
}

function resolveCookiesFile(platform) {
  const runtimeFileName = platform === 'youtube' ? 'cookies-youtube.txt' : 'cookies-social.txt';
  const fallbackLocalFile = platform === 'youtube' ? 'cookies.txt' : 'cookies2.txt';
  const candidates = [
    platform === 'youtube' ? process.env.YTDLP_YOUTUBE_COOKIES_FILE : process.env.YTDLP_SOCIAL_COOKIES_FILE,
    platform === 'youtube' ? YOUTUBE_COOKIES_FILE : SOCIAL_COOKIES_FILE,
    path.join(__dirname, '.runtime', runtimeFileName),
    path.join(__dirname, fallbackLocalFile),
    GLOBAL_COOKIES_FILE
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

// Token must come from the runtime environment.
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  throw new Error('BOT_TOKEN is required');
}
const bot = new TelegramBot(TOKEN, { polling: false });

// Admin ID
const ADMIN_ID = 949712684;

// Store user download state
const userState = new Map();

// Bot stats
let stats = {
  totalUsers: 0,
  totalDownloads: 0,
  totalVideos: 0,
  totalAudios: 0
};

// Blocked users
const blockedUsers = new Set();

// Active users (unique chatIds seen)
const activeUsers = new Set();

// Telegram profile cache for Supabase sync
const userProfiles = new Map();

let saveQueue = Promise.resolve();
let storageReady = Promise.resolve();

// Quality options
const QUALITIES = {
  '144': { quality: '144p', label: '144p - منخفض' },
  '240': { quality: '240p', label: '240p - منخفض' },
  '360': { quality: '360p', label: '360p - متوسط' },
  '480': { quality: '480p', label: '480p - متوسط' },
  '720': { quality: '720p', label: '720p - عالي الجودة' },
  '1080': { quality: '1080p', label: '1080p - كامل الجودة' }
};

// Create downloads directory
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Helper: Save stats to file
function saveLocalStats() {
  try {
    const profiles = {};

    for (const [userId, profile] of userProfiles.entries()) {
      profiles[userId] = {
        firstName: profile.firstName || null,
        username: profile.username || null
      };
    }

    fs.writeFileSync(
      path.join(__dirname, 'stats.json'),
      JSON.stringify(
        {
          stats: { ...stats, totalUsers: activeUsers.size },
          users: [...activeUsers],
          blocked: [...blockedUsers],
          profiles
        },
        null,
        2
      )
    );
  } catch (e) {}
}

function loadLocalStats() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'stats.json'), 'utf8'));
    stats = data.stats || stats;

    activeUsers.clear();
    blockedUsers.clear();
    userProfiles.clear();

    (data.users || []).forEach((id) => activeUsers.add(Number(id)));
    (data.blocked || []).forEach((id) => blockedUsers.add(Number(id)));

    const profiles = data.profiles || {};

    if (Array.isArray(profiles)) {
      profiles.forEach(([userId, profile]) => {
        if (!profile) return;

        userProfiles.set(Number(userId), {
          firstName: profile.firstName || profile.first_name || null,
          username: profile.username || null
        });
      });
    } else {
      Object.entries(profiles).forEach(([userId, profile]) => {
        if (!profile) return;

        userProfiles.set(Number(userId), {
          firstName: profile.firstName || profile.first_name || null,
          username: profile.username || null
        });
      });
    }

    stats.totalUsers = activeUsers.size;
  } catch (e) {}
}

function supabaseRequest(endpoint, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(SUPABASE_URL);
    const basePath = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/$/, '');
    const requestPath = `${basePath}${endpoint}${query ? `?${query}` : ''}`;
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: 'application/json'
    };

    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers.Prefer = prefer || 'return=representation';
    } else if (prefer) {
      headers.Prefer = prefer;
    }

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: requestPath,
      method,
      headers
    };

    const request = https.request(requestOptions, (response) => {
      let raw = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });

      response.on('end', () => {
        const status = response.statusCode || 0;

        if (status === 204 || raw.trim() === '') {
          resolve(null);
          return;
        }

        let parsed = raw;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {}

        if (status >= 200 && status < 300) {
          resolve(parsed);
          return;
        }

        const error = new Error(`Supabase request failed with status ${status}`);
        error.status = status;
        error.response = parsed;
        reject(error);
      });
    });

    request.on('error', reject);

    if (body !== null) {
      request.write(JSON.stringify(body));
    }

    request.end();
  });
}

function downloadTextFromUrl(url, targetPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);

    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => fs.unlink(targetPath, () => {}));
        resolve(downloadTextFromUrl(response.headers.location, targetPath));
        return;
      }

      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        file.close(() => fs.unlink(targetPath, () => {}));
        reject(new Error(`Failed to download file from ${url} (status ${response.statusCode || 'unknown'})`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(targetPath));
      });
    });

    request.on('error', (error) => {
      file.close(() => fs.unlink(targetPath, () => {}));
      reject(error);
    });

    file.on('error', (error) => {
      file.close(() => fs.unlink(targetPath, () => {}));
      reject(error);
    });
  });
}

// Helper: Download image from URL with proper redirect handling
function downloadImage(url, targetPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(downloadImage(response.headers.location, targetPath));
        return;
      }

      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Failed to download image from ${url} (status ${response.statusCode || 'unknown'})`));
        return;
      }

      const file = fs.createWriteStream(targetPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(targetPath));
      });
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

async function prepareCookiesFile(existingFile, remoteUrl, runtimeName) {
  if (existingFile && fs.existsSync(existingFile)) {
    return existingFile;
  }

  if (!remoteUrl) {
    return '';
  }

  const runtimeDir = path.join(__dirname, '.runtime');
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  const runtimePath = path.join(runtimeDir, runtimeName);
  console.log(`[Cookies] Downloading cookies from ${remoteUrl} to ${runtimePath}`);
  await downloadTextFromUrl(remoteUrl, runtimePath);
  console.log(`[Cookies] Downloaded successfully: ${runtimePath}`);
  return runtimePath;
}

function buildYtDlpBaseArgs(cookiesFile = '') {
  const args = ['--no-playlist'];

  if (cookiesFile) {
    args.push(`--cookies "${cookiesFile}"`);
  }

  return args.join(' ');
}

function buildYoutubeDlpArgs(extraArgs = '') {
  // Always check current variable value which is updated at startup
  // Use tv client: supports cookies AND no JS challenges needed
  const baseArgs = [
    buildYtDlpBaseArgs(resolveCookiesFile('youtube')),
    '--extractor-args "youtube:player_client=tv;player_skip=webpage"',
    '--user-agent "Mozilla/5.0"'
  ];

  if (extraArgs) {
    baseArgs.push(extraArgs);
  }

  return baseArgs.filter(Boolean).join(' ');
}

// Helper: Refresh YouTube cookies from remote URL
async function refreshYouTubeCookies() {
  try {
    console.log('[Cookies] Refreshing YouTube cookies from remote URL...');
    const runtimeDir = path.join(__dirname, '.runtime');
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
    }
    
    const runtimePath = path.join(runtimeDir, 'cookies-youtube.txt');
    await downloadTextFromUrl(YOUTUBE_COOKIES_URL, runtimePath);
    
    YOUTUBE_COOKIES_FILE = runtimePath;
    process.env.YTDLP_YOUTUBE_COOKIES_FILE = runtimePath;
    
    console.log(`[Cookies] YouTube cookies refreshed: ${runtimePath}`);
    return true;
  } catch (error) {
    console.error('[Cookies] Failed to refresh YouTube cookies:', error.message);
    return false;
  }
}

function buildSocialDlpArgs(extraArgs = '') {
  const baseArgs = [
    buildYtDlpBaseArgs(resolveCookiesFile('social')),
    '--extractor-retries 3'
  ];

  if (extraArgs) {
    baseArgs.push(extraArgs);
  }

  return baseArgs.filter(Boolean).join(' ');
}

function isYouTubeBotChallengeError(error) {
  const message = `${error?.message || ''} ${error?.stderr || ''} ${error?.response?.body?.description || ''}`.toLowerCase();
  // Check for both straight (') and curly (') apostrophes
  const normalizedMessage = message.replace(/['']/g, "'");
  return normalizedMessage.includes('sign in to confirm you\'re not a bot') || 
         normalizedMessage.includes('sign in to confirm youre not a bot') ||
         message.includes('precondition check failed') || 
         message.includes('http error 400: bad request') ||
         message.includes('bot');
}

function isYouTubeCookiesInvalidError(error) {
  const message = `${error?.message || ''} ${error?.stderr || ''} ${error?.response?.body?.description || ''}`.toLowerCase();
  return message.includes('cookies are no longer valid') || message.includes('have likely been rotated') || message.includes('cookie') && message.includes('rotated in the browser');
}

function getFriendlyVideoError(error) {
  if (isYouTubeCookiesInvalidError(error)) {
    return 'كوكيز يوتيوب منتهية أو تغيّرت في المتصفح. ارفع ملف cookies.txt جديد ومحدّث ثم أعد المحاولة.';
  }

  if (isYouTubeBotChallengeError(error)) {
    return 'YouTube منع الطلب من السيرفر. إذا كان ملف الكوكيز قديمًا، ارفع ملف cookies.txt جديد ومحدّث ثم أعد المحاولة.';
  }

  return 'تعذر جلب الفيديو من YouTube الآن. حاول مرة أخرى لاحقًا أو استخدم فيديو آخر.';
}

function supabaseStorageRequest(endpointPath, { method = 'GET', body = null, contentType = '', extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(SUPABASE_URL);
    const basePath = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/$/, '');
    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${basePath}/storage/v1/${endpointPath}`,
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...extraHeaders
      }
    };

    if (body !== null) {
      requestOptions.headers['Content-Type'] = contentType || 'application/octet-stream';

  function downloadTextFromUrl(url, targetPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(targetPath);

      const request = https.get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close(() => fs.unlink(targetPath, () => {}));
          resolve(downloadTextFromUrl(response.headers.location, targetPath));
          return;
        }

        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          file.close(() => fs.unlink(targetPath, () => {}));
          reject(new Error(`Failed to download file from ${url} (status ${response.statusCode || 'unknown'})`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(targetPath));
        });
      });

      request.on('error', (error) => {
        file.close(() => fs.unlink(targetPath, () => {}));
        reject(error);
      });

      file.on('error', (error) => {
        file.close(() => fs.unlink(targetPath, () => {}));
        reject(error);
      });
    });
  }

  async function prepareCookiesFile(existingFile, remoteUrl, runtimeName) {
    if (existingFile && fs.existsSync(existingFile)) {
      return existingFile;
    }

    if (!remoteUrl) {
      return '';
    }

    const runtimeDir = path.join(__dirname, '.runtime');
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
    }

    const runtimePath = path.join(runtimeDir, runtimeName);
    console.log(`[Cookies] Downloading cookies from ${remoteUrl} to ${runtimePath}`);
    await downloadTextFromUrl(remoteUrl, runtimePath);
    console.log(`[Cookies] Downloaded successfully: ${runtimePath}`);
    return runtimePath;
  }
      requestOptions.headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    }

    const request = https.request(requestOptions, (response) => {
      let raw = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });

      response.on('end', () => {
        const status = response.statusCode || 0;

        if (status === 204 || raw.trim() === '') {
          resolve(null);
          return;
        }

        let parsed = raw;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {}

        if (status >= 200 && status < 300) {
          resolve(parsed);
          return;
        }

        const error = new Error(`Supabase storage request failed with status ${status}`);
        error.status = status;
        error.response = parsed;
        reject(error);
      });
    });

    request.on('error', reject);

    if (body !== null) {
      request.write(body);
    }

    request.end();
  });
}

function buildStorageObjectPath(prefix, filename) {
  // Supabase only accepts ASCII characters in storage keys
  // Remove Arabic and other non-ASCII characters
  const sanitized = filename.replace(/[^\x00-\x7F]/g, '')  // Remove non-ASCII
    .replace(/[^a-zA-Z0-9.-]/g, '_')                      // Clean special chars
    .replace(/_+/g, '_')                                   // Collapse multiple underscores
    .replace(/^_|_$/g, '')                                 // Trim underscores
    || 'file';                                              // Fallback name
  return `${prefix}/${sanitized}`;
}

function encodeStorageObjectPath(objectPath) {
  return objectPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function getStorageMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}

function getStoragePublicUrl(objectPath) {
  const parsedUrl = new URL(SUPABASE_URL);
  const basePath = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/$/, '');
  return `${parsedUrl.origin}${basePath}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${encodeStorageObjectPath(objectPath)}`;
}

async function uploadFileToStorage(localPath, objectPath) {
  const buffer = fs.readFileSync(localPath);
  const contentType = getStorageMimeType(localPath);

  await supabaseStorageRequest(`object/${SUPABASE_STORAGE_BUCKET}/${encodeStorageObjectPath(objectPath)}`, {
    method: 'PUT',
    body: buffer,
    contentType
  });

  return getStoragePublicUrl(objectPath);
}

async function deleteStorageObject(objectPath) {
  try {
    await supabaseStorageRequest(`object/${SUPABASE_STORAGE_BUCKET}/${encodeStorageObjectPath(objectPath)}`, {
      method: 'DELETE'
    });
  } catch (error) {
    // Ignore deletion errors (file might not exist or already deleted)
    console.warn('Storage delete warning:', error.message);
  }
}

async function syncSupabaseState() {
  if (!HAS_SUPABASE) return;

  await supabaseRequest('/rest/v1/bot_stats', {
    method: 'POST',
    query: 'on_conflict=id',
    body: [
      {
        id: 1,
        total_downloads: stats.totalDownloads,
        total_videos: stats.totalVideos,
        total_audios: stats.totalAudios
      }
    ],
    prefer: 'resolution=merge-duplicates,return=minimal'
  });

  const userRows = [...activeUsers].map((userId) => {
    const profile = userProfiles.get(userId) || {};
    const row = { user_id: userId };

    if (profile.firstName) {
      row.first_name = profile.firstName;
    }

    if (profile.username) {
      row.username = profile.username;
    }

    return row;
  });

  if (userRows.length > 0) {
    await supabaseRequest('/rest/v1/bot_users', {
      method: 'POST',
      query: 'on_conflict=user_id',
      body: userRows,
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }

  await supabaseRequest('/rest/v1/bot_blocked_users', {
    method: 'DELETE',
    query: 'user_id=not.is.null'
  });

  const blockedRows = [...blockedUsers].map((userId) => ({ user_id: userId }));

  if (blockedRows.length > 0) {
    await supabaseRequest('/rest/v1/bot_blocked_users', {
      method: 'POST',
      query: 'on_conflict=user_id',
      body: blockedRows,
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }
}

// Helper: Load stats from storage
async function loadStats() {
  activeUsers.clear();
  blockedUsers.clear();
  userProfiles.clear();

  if (HAS_SUPABASE) {
    try {
      const [statsRows, usersRows, blockedRows] = await Promise.all([
        supabaseRequest('/rest/v1/bot_stats', {
          query: 'id=eq.1&select=id,total_downloads,total_videos,total_audios'
        }),
        supabaseRequest('/rest/v1/bot_users', {
          query: 'select=user_id,first_name,username'
        }),
        supabaseRequest('/rest/v1/bot_blocked_users', {
          query: 'select=user_id'
        })
      ]);

      if (Array.isArray(statsRows) && statsRows.length > 0) {
        const row = statsRows[0];
        stats.totalDownloads = Number(row.total_downloads || 0);
        stats.totalVideos = Number(row.total_videos || 0);
        stats.totalAudios = Number(row.total_audios || 0);
      }

      (Array.isArray(usersRows) ? usersRows : []).forEach((row) => {
        const userId = Number(row.user_id);
        if (Number.isNaN(userId)) return;

        activeUsers.add(userId);
        userProfiles.set(userId, {
          firstName: row.first_name || null,
          username: row.username || null
        });
      });

      (Array.isArray(blockedRows) ? blockedRows : []).forEach((row) => {
        const userId = Number(row.user_id);
        if (!Number.isNaN(userId)) {
          blockedUsers.add(userId);
        }
      });

      stats.totalUsers = activeUsers.size;
      saveLocalStats();
      return;
    } catch (error) {
      console.error('Supabase load failed:', error.message);
    }
  }

  loadLocalStats();
}

// Load stats on startup
storageReady = loadStats();

async function ensureStorageReady() {
  await storageReady;
}

function saveStats() {
  saveQueue = saveQueue
    .then(async () => {
      await ensureStorageReady();
      stats.totalUsers = activeUsers.size;

      try {
        if (HAS_SUPABASE) {
          await syncSupabaseState();
        }
      } catch (error) {
        console.error('Supabase save failed:', error.message);
      }

      saveLocalStats();
    })
    .catch((error) => {
      console.error('Failed to save stats:', error.message);
    });

  return saveQueue;
}

// Helper: Track user
function trackUser(chatId, userInfo = {}) {
  activeUsers.add(chatId);

  if (userInfo.first_name || userInfo.username) {
    const existingProfile = userProfiles.get(chatId) || {};
    userProfiles.set(chatId, {
      firstName: userInfo.first_name || existingProfile.firstName || null,
      username: userInfo.username || existingProfile.username || null
    });
  }

  stats.totalUsers = activeUsers.size;
  saveStats();
}

// Helper: Detect platform from URL
function detectPlatform(url) {
  if (!url) return 'unknown';
  const lower = url.toLowerCase().trim();
  if (lower.includes('tiktok.com') || lower.includes('vm.tiktok.com')) return 'tiktok';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram';
  return 'unknown';
}

// Helper: Validate YouTube URL
function isValidYouTubeUrl(url) {
  return detectPlatform(url) === 'youtube';
}

// Helper: Check if URL is Instagram
function isInstagramUrl(url) {
  return detectPlatform(url) === 'instagram';
}

// Helper: Check if URL is TikTok
function isTikTokUrl(url) {
  return detectPlatform(url) === 'tiktok';
}

// Helper: Get TikTok info via external API when yt-dlp fails
function getTikTokInfo(url) {
  return new Promise(async (resolve, reject) => {
    // Try yt-dlp first
    const args = buildSocialDlpArgs();
    exec(`yt-dlp ${args} --dump-json "${url}"`, async (error, stdout, stderr) => {
      // If yt-dlp succeeded, parse the JSON
      if (!error && stdout.trim()) {
        try {
          const info = JSON.parse(stdout);
          resolve(info);
          return;
        } catch (e) {}
      }

      // yt-dlp failed - fallback to external API
      console.log('[TikTok] yt-dlp failed, using external API fallback');

      try {
        const https = require('https');
        
        // First, follow the short URL to get the actual URL
        const followRedirect = (shortUrl) => {
          return new Promise((resolveRedirect, rejectRedirect) => {
            https.get(shortUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            }, (response) => {
              if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                resolveRedirect(response.headers.location);
              } else {
                resolveRedirect(shortUrl);
              }
            }).on('error', rejectRedirect);
          });
        };

        const finalUrl = await followRedirect(url);
        console.log('[TikTok] Final URL:', finalUrl);

        // Extract video/photo ID from URL
        const urlObj = new URL(finalUrl);
        const pathParts = urlObj.pathname.split('/');
        const itemId = pathParts[pathParts.length - 1];

        if (!itemId || itemId.length < 5) {
          throw new Error('Could not extract TikTok video ID');
        }

        console.log('[TikTok] Extracted ID:', itemId);

        // Try multiple TikTok downloader APIs
        const apis = [
          `https://tikwm.com/api/?url=${encodeURIComponent(finalUrl)}`,
          `https://www.tiktok.com/oembed?url=${encodeURIComponent(finalUrl)}`
        ];

        // Try tikwm.com API first
        https.get(apis[0], {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://tikwm.com/'
          },
          timeout: 15000
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => {
            try {
              const apiData = JSON.parse(data);
              
              if (apiData.code === 0 && apiData.data) {
                const tiktokData = apiData.data;
                const result = {
                  title: tiktokData.title || tiktokData.desc || 'TikTok Content',
                  uploader: tiktokData.author?.nickname || tiktokData.author?.unique_id || 'Unknown',
                  author_id: tiktokData.author?.unique_id || '',
                  thumbnail: tiktokData.origin_cover || tiktokData.cover,
                  type: 'unknown'
                };

                // Check if it's a photo/slideshow
                if (tiktokData.images && tiktokData.images.length > 0) {
                  result.type = 'photo';
                  result.isSlideshow = tiktokData.images.length > 1;
                  result.images = tiktokData.images;
                  console.log(`[TikTok] Found ${tiktokData.images.length} images from API`);
                  resolve(result);
                  return;
                }
                
                // It's a video
                if (tiktokData.play) {
                  result.type = 'video';
                  result.url = tiktokData.play;
                  result.wmplay = tiktokData.wmplay; // watermarked version
                  result.duration = tiktokData.duration;
                  console.log('[TikTok] Found video URL from API');
                  resolve(result);
                  return;
                }
              }

              // API failed - try oEmbed
              console.log('[TikTok] First API failed, trying oEmbed...');
              tryOEmbed(finalUrl, resolve, reject);
              
            } catch (e) {
              console.log('[TikTok] API parse error:', e.message);
              tryOEmbed(finalUrl, resolve, reject);
            }
          });
        }).on('error', (err) => {
          console.log('[TikTok] API error:', err.message);
          tryOEmbed(finalUrl, resolve, reject);
        });

      } catch (err) {
        reject(err);
      }
    });
  });
}

// Helper: Try TikTok oEmbed as last resort
function tryOEmbed(url, resolve, reject) {
  const https = require('https');
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;

  https.get(oembedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 10000
  }, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try {
        const oembed = JSON.parse(data);
        
        if (oembed.title) {
          resolve({
            title: oembed.title,
            uploader: oembed.author_name || 'Unknown',
            thumbnail: oembed.thumbnail_url,
            type: 'video', // Assume video since we couldn't detect
            url: null // Will use yt-dlp for download
          });
          return;
        }
      } catch (e) {}
      
      reject(new Error('All TikTok info extraction methods failed'));
    });
  }).on('error', reject);
}

// Helper: Get Instagram info via external API when yt-dlp fails
function getInstagramInfo(url) {
  return new Promise(async (resolve, reject) => {
    // Clean URL - remove tracking parameters
    let cleanUrl = url.split('?')[0];
    // Ensure trailing slash for consistency
    if (!cleanUrl.endsWith('/')) cleanUrl += '/';

    const cookiesFile = resolveCookiesFile('social');

    // Try yt-dlp first (with cookies)
    const args = buildSocialDlpArgs();
    exec(`yt-dlp ${args} --dump-json "${cleanUrl}"`, async (error, stdout, stderr) => {
      // If yt-dlp succeeded, parse the JSON
      if (!error && stdout.trim()) {
        try {
          const info = JSON.parse(stdout);
          resolve(info);
          return;
        } catch (e) {}
      }

      // yt-dlp failed - fallback to GraphQL API with cookies
      console.log('[Instagram] yt-dlp failed, using GraphQL API with cookies');

      try {
        const https = require('https');
        const fs = require('fs');
        
        const result = {
          title: 'Instagram Post',
          uploader: 'Unknown',
          type: 'unknown'
        };

        // Read cookies
        let cookies = {};
        if (cookiesFile && fs.existsSync(cookiesFile)) {
          try {
            const cookiesContent = fs.readFileSync(cookiesFile, 'utf8');
            
            // Try to parse as JSON first
            try {
              const jsonCookies = JSON.parse(cookiesContent);
              if (Array.isArray(jsonCookies)) {
                jsonCookies.forEach(cookie => {
                  cookies[cookie.name] = cookie.value;
                });
              } else if (typeof jsonCookies === 'object') {
                Object.assign(cookies, jsonCookies);
              }
            } catch (e) {
              // Try Netscape format
              const cookieLines = cookiesContent.split('\n').filter(line => line && !line.startsWith('#'));
              cookieLines.forEach(line => {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                  cookies[parts[5]] = parts[6];
                }
              });
            }
          } catch (e) {
            console.log('[Instagram] Failed to read cookies:', e.message);
          }
        }

        // Extract shortcode from URL
        let shortcode = '';
        const match1 = cleanUrl.match(/\/p\/([A-Za-z0-9_-]+)/);
        const match2 = cleanUrl.match(/\/reel\/([A-Za-z0-9_-]+)/);
        const match3 = cleanUrl.match(/\/tv\/([A-Za-z0-9_-]+)/);
        shortcode = (match1 || match2 || match3 || [])[1] || '';

        if (!shortcode) {
          console.log('[Instagram] Could not extract shortcode from URL');
          resolve(result);
          return;
        }

        console.log('[Instagram] Extracted shortcode:', shortcode);

        // Instagram GraphQL query for post data
        const queryHash = '67d501774501d4c0f976578d45473dd3'; // Instagram's shortcode media query hash
        const variables = JSON.stringify({
          shortcode: shortcode,
          fetch_tagged_media_count: 0
        });

        const graphqlUrl = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(variables)}`;

        // Build cookie header
        const cookieParts = [];
        Object.keys(cookies).forEach(key => {
          const sanitizedValue = cookies[key].replace(/[\r\n\t\x00-\x1F\x7F]/g, '').trim();
          if (sanitizedValue) {
            cookieParts.push(`${key}=${sanitizedValue}`);
          }
        });

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'X-IG-App-ID': '936619743392459',
          'X-IG-WWW-Claim': '0',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': cleanUrl,
          'Connection': 'keep-alive'
        };

        if (cookieParts.length > 0) {
          headers['Cookie'] = cookieParts.join('; ');
          console.log(`[Instagram] Using ${cookieParts.length} cookies for GraphQL request`);
        }

        console.log('[Instagram] GraphQL URL:', graphqlUrl.substring(0, 80) + '...');

        // Make GraphQL request
        https.get(graphqlUrl, { headers, timeout: 15000 }, (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => {
            try {
              console.log('[Instagram] GraphQL response status:', response.statusCode);
              console.log('[Instagram] GraphQL response length:', data.length);
              
              if (data.length > 0) {
                console.log('[Instagram] GraphQL response preview:', data.substring(0, 200));
              }
              
              if (response.statusCode === 400 || response.statusCode === 401 || response.statusCode === 403) {
                console.log('[Instagram] GraphQL API returned error status - likely authorization issue or API update');
                extractFromHtmlPage(cleanUrl, result, headers, resolve, reject);
                return;
              }
              
              const graphqlResponse = JSON.parse(data);
              
              if (graphqlResponse.data) {
                const media = graphqlResponse.data.xdt_shortcode_media || graphqlResponse.data.shortcode_media;
                console.log('[Instagram] Media found in GraphQL:', !!media);
                
                if (media) {
                  // Extract title and author
                  if (media.caption?.text) result.title = media.caption.text;
                  if (media.owner?.username) result.uploader = media.owner.username;
                  else if (media.user?.username) result.uploader = media.user.username;

                  // Check if it's a carousel
                  if (media.edge_sidecar_to_children?.edges?.length > 0) {
                    const edges = media.edge_sidecar_to_children.edges;
                    result.isCarousel = true;
                    result.carouselItems = [];
                    
                    edges.forEach((edge) => {
                      const node = edge.node || edge;
                      const typename = node.__typename || '';
                      
                      if (typename.includes('Image') || node.display_url) {
                        result.carouselItems.push({
                          type: 'image',
                          url: node.display_url || node.display_resources?.[node.display_resources.length - 1]?.src
                        });
                      } else if (typename.includes('Video') || node.video_url) {
                        result.carouselItems.push({
                          type: 'video',
                          url: node.video_url || node.video_playback_url
                        });
                      }
                    });
                    
                    console.log(`[Instagram] Found carousel with ${result.carouselItems.length} items via GraphQL`);
                    resolve(result);
                    return;
                  }
                  
                  // Single image
                  if (media.display_url) {
                    result.type = 'image';
                    result.url = media.display_url || media.display_resources?.[media.display_resources.length - 1]?.src;
                    console.log('[Instagram] Found single image via GraphQL');
                    resolve(result);
                    return;
                  }
                  
                  // Video
                  if (media.video_url || media.video_playback_url) {
                    result.type = 'video';
                    result.url = media.video_url || media.video_playback_url;
                    result.duration = media.video_duration;
                    console.log('[Instagram] Found video via GraphQL');
                    resolve(result);
                    return;
                  }
                }
              }

              // GraphQL failed, try fetching HTML page
              console.log('[Instagram] GraphQL failed, trying HTML extraction');
              extractFromHtmlPage(cleanUrl, result, headers, resolve, reject);

            } catch (e) {
              console.log('[Instagram] GraphQL parse error:', e.message);
              extractFromHtmlPage(cleanUrl, result, headers, resolve, reject);
            }
          });
        }).on('error', (err) => {
          console.log('[Instagram] GraphQL request error:', err.message);
          extractFromHtmlPage(cleanUrl, result, headers, resolve, reject);
        });

      } catch (err) {
        reject(err);
      }
    });
  });
}

// Helper: Extract from HTML page
function extractFromHtmlPage(url, result, headers, resolve, reject) {
  const https = require('https');
  
  // Improve headers for HTML page request
  const pageHeaders = {
    ...headers,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0'
  };
  
  console.log('[Instagram] Fetching HTML page...');
  https.get(url, { headers: pageHeaders, timeout: 15000 }, (response) => {
    console.log('[Instagram] HTML response status:', response.statusCode);
    let html = '';
    response.on('data', (chunk) => { html += chunk; });
    response.on('end', () => {
      console.log('[Instagram] HTML page received, length:', html.length);
      try {
        parseInstagramHtml(html, url, result, resolve, reject);
      } catch (e) {
        console.log('[Instagram] HTML parse exception:', e.message);
        reject(new Error('Failed to parse Instagram HTML'));
      }
    });
  }).on('error', (err) => {
    console.log('[Instagram] HTML extraction error:', err.message);
    resolve(result);
  });
}

// Helper: Parse Instagram HTML content
function parseInstagramHtml(html, url, result, resolve, reject) {
  try {
    console.log('[Instagram] HTML page received, length:', html.length);
    
    // Method 0: Extract sharedData from new format
    if (!result.url && !result.carouselItems) {
      try {
        // Look for window.sharedData or similar patterns
        const sharedDataRegex = /window\.__NRML_INIT_DATA__\s*=\s*({.*?});\n/;
        const match = html.match(sharedDataRegex);
        if (match) {
          console.log('[Instagram] Method 0: Found __NRML_INIT_DATA__');
          const data = JSON.parse(match[1]);
          if (data && data.nrml_context && data.nrml_context.data) {
            extractFromMedia(data.nrml_context.data, result);
          }
        }
      } catch (e) {
        console.log('[Instagram] Method 0 failed:', e.message);
      }
    }
    
    // Method 1: Try __additionalDataLoaded (newer format)
    if (!result.url && !result.carouselItems) {
      const additionalDataMatch = html.match(/<script type="text\/javascript">window\.__additionalDataLoaded\s*=\s*window\.__additionalDataLoaded\s*\|\|\s*\{\};\s*Object\.assign\(window\.__additionalDataLoaded,\s*({.*?})\);<\/script>/);
      
      if (additionalDataMatch) {
        console.log('[Instagram] Method 1: Found __additionalDataLoaded');
        try {
          const data = JSON.parse(additionalDataMatch[1]);
          extractFromGraphql(data, result);
        } catch (e) {
          console.log('[Instagram] Method 1 parse failed:', e.message);
        }
      } else {
        console.log('[Instagram] Method 1: __additionalDataLoaded not found');
      }
    }

    // Method 2: Try window._sharedData (older but still works)
    if (!result.url && !result.carouselItems) {
      const sharedDataMatch = html.match(/<script type="text\/javascript">window\._sharedData\s*=\s*({.*?});<\/script>/);
      
      if (sharedDataMatch) {
        console.log('[Instagram] Method 2: Found _sharedData');
        try {
          const sharedData = JSON.parse(sharedDataMatch[1]);
          const postPage = sharedData?.entry_data?.PostPage?.[0];
          
          if (postPage) {
            const media = postPage?.graphql?.shortcode_media || postPage?.graphql?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
            
            if (media) {
              console.log('[Instagram] Method 2: Extracted media from _sharedData');
              extractFromMedia(media, result);
            }
          }
        } catch (e) {
          console.log('[Instagram] Method 2 parse failed:', e.message);
        }
      } else {
        console.log('[Instagram] Method 2: _sharedData not found');
      }
    }

    // Method 3: Try window.__INITIAL_STATE__
    if (!result.url && !result.carouselItems) {
      const initialStateMatch = html.match(/<script type="text\/javascript">window\.__INITIAL_STATE__\s*=\s*({.*?});<\/script>/);
      
      if (initialStateMatch) {
        console.log('[Instagram] Method 3: Found __INITIAL_STATE__');
        try {
          const initialState = JSON.parse(initialStateMatch[1]);
          const media = initialState?.graphql?.shortcode_media;
          
          if (media) {
            console.log('[Instagram] Method 3: Extracted media from __INITIAL_STATE__');
            extractFromMedia(media, result);
          }
        } catch (e) {
          console.log('[Instagram] Method 3 parse failed:', e.message);
        }
      } else {
        console.log('[Instagram] Method 3: __INITIAL_STATE__ not found');
      }
    }

    // Method 4: Try to find data in any script tag with JSON
    if (!result.url && !result.carouselItems) {
      // Search for media data in any JSON embedded in the page
      const mediaRegex = /"edge_sidecar_to_children":\{"edges":(\[.*?\])\}/;
      const mediaMatch = html.match(mediaRegex);
      
      if (mediaMatch) {
        console.log('[Instagram] Method 4: Found carousel pattern');
        try {
          const edges = JSON.parse(mediaMatch[1]);
          result.isCarousel = true;
          result.carouselItems = [];
          
          edges.forEach((edge) => {
            const node = edge.node || edge;
            if (node.display_url || node.display_resources) {
              result.carouselItems.push({
                type: 'image',
                url: node.display_url || node.display_resources?.[node.display_resources.length - 1]?.src
              });
            } else if (node.video_url || node.video_playback_url) {
              result.carouselItems.push({
                type: 'video',
                url: node.video_url || node.video_playback_url
              });
            }
          });
          
          console.log(`[Instagram] Method 4: Found carousel with ${result.carouselItems.length} items`);
        } catch (e) {
          console.log('[Instagram] Method 4 parse failed:', e.message);
        }
      } else {
        console.log('[Instagram] Method 4: Carousel pattern not found');
      }
    }

    // Method 5: Regex fallback for single image
    if (!result.url && !result.carouselItems) {
      const imageUrls = [];
      const imgRegex = /"display_url"\s*:\s*"([^"]+)"/g;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(html)) !== null) {
        const imgUrl = imgMatch[1].replace(/\\u002F/g, '/');
        if (!imageUrls.includes(imgUrl)) {
          imageUrls.push(imgUrl);
        }
      }
      
      if (imageUrls.length > 0) {
        console.log('[Instagram] Method 5: Found', imageUrls.length, 'URLs via regex');
        if (imageUrls.length === 1) {
          result.type = 'image';
          result.url = imageUrls[0];
          console.log('[Instagram] Method 5: Set as single image');
        } else {
          result.isCarousel = true;
          result.carouselItems = imageUrls.map(url => ({ type: 'image', url }));
          console.log(`[Instagram] Method 5: Set as carousel with ${imageUrls.length} images`);
        }
      } else {
        console.log('[Instagram] Method 5: No display_url patterns found');
      }
    }

    // Method 6: Last resort - find any jpg/png URL that looks like Instagram CDN
    if (!result.url && !result.carouselItems) {
      const cdnRegex = /https:\/\/scontent[^"]+\.(jpg|jpeg|png|webp)[^"]*/g;
      const cdnMatches = html.match(cdnRegex);
      
      if (cdnMatches && cdnMatches.length > 0) {
        console.log('[Instagram] Method 6: Found', cdnMatches.length, 'CDN URLs');
        // Filter out thumbnails and profile pics (they're usually smaller)
        const fullSizeImages = cdnMatches.filter(url => url.includes('nc0_mxd') || url.includes('stp=') || url.includes('e35'));
        
        if (fullSizeImages.length > 0) {
          console.log('[Instagram] Method 6: Filtered to', fullSizeImages.length, 'full-size images');
          if (fullSizeImages.length === 1) {
            result.type = 'image';
            result.url = fullSizeImages[0];
          } else {
            result.isCarousel = true;
            result.carouselItems = fullSizeImages.map(url => ({ type: 'image', url }));
          }
          console.log(`[Instagram] Method 6: Set result`);
        } else {
          console.log('[Instagram] Method 6: No full-size images found after filtering');
        }
      } else {
        console.log('[Instagram] Method 6: No CDN URLs found');
      }
    }

    // Method 7: Try extracting from any script tag with JSON containing media data
    if (!result.url && !result.carouselItems) {
      console.log('[Instagram] Method 7: Searching for JSON in script tags...');
      try {
        // Look for script tags with type application/json
        const scriptRegex = /<script[^>]*type="application\/json"[^>]*>([^<]+)<\/script>/g;
        let scriptMatch;
        while ((scriptMatch = scriptRegex.exec(html)) !== null) {
          try {
            const data = JSON.parse(scriptMatch[1]);
            if (data.data && data.data.shortcode_media) {
              console.log('[Instagram] Method 7: Found shortcode_media in script tag');
              extractFromMedia(data.data.shortcode_media, result);
              break;
            }
            if (data.__typename && (data.__typename.includes('GraphImage') || data.__typename.includes('GraphVideo'))) {
              console.log('[Instagram] Method 7: Found GraphImage/GraphVideo in script tag');
              extractFromMedia(data, result);
              break;
            }
          } catch (e) {
            // Skip this script tag
          }
        }
      } catch (e) {
        console.log('[Instagram] Method 7 error:', e.message);
      }
    }

    // Method 8: Find ANY scontent URL (more aggressive fallback)
    if (!result.url && !result.carouselItems) {
      console.log('[Instagram] Method 8: Searching for ANY scontent URLs...');
      const allCdnUrls = [];
      const cdnRegex = /https:\/\/scontent[^"'\s<>]+/g;
      let cdnMatch;
      while ((cdnMatch = cdnRegex.exec(html)) !== null) {
        const url = cdnMatch[0];
        if (url.includes('jpg') || url.includes('png') || url.includes('webp') || url.includes('mp4')) {
          allCdnUrls.push(url);
        }
      }
      
      if (allCdnUrls.length > 0) {
        console.log('[Instagram] Method 8: Found', allCdnUrls.length, 'CDN URLs');
        // Try to get the first one that's not too small (likely not a thumbnail)
        const firstUrl = allCdnUrls[0];
        if (firstUrl) {
          result.type = 'image';
          result.url = firstUrl;
          console.log('[Instagram] Method 8: Using first CDN URL');
        }
      } else {
        console.log('[Instagram] Method 8: No scontent URLs found');
      }
    }

    console.log('[Instagram] Final result - URL:', !!result.url, 'Carousel:', !!result.carouselItems, 'Type:', result.type);
    resolve(result);
  } catch (e) {
    console.error('[Instagram] Parse error:', e.message);
    reject(new Error('Failed to parse Instagram content'));
  }
}

// Helper: Extract data from GraphQL response
function extractFromGraphql(data, result) {
  try {
    // Navigate through the data structure
    const shortcode = Object.keys(data).find(key => key.includes('shortcode'));
    
    if (shortcode) {
      const item = data[shortcode];
      const media = item?.data?.xdt_shortcode_media || item?.data?.shortcode_media;
      
      if (media) {
        extractFromMedia(media, result);
      }
    }
  } catch (e) {
    console.log('[Instagram] extractFromGraphql error:', e.message);
  }
}

// Helper: Extract data from media object
function extractFromMedia(media, result) {
  try {
    if (!media) return;

    // Extract title and author
    if (media.caption) {
      result.title = media.caption.text || media.caption.text || result.title;
    }
    
    if (media.owner) {
      result.uploader = media.owner.username || result.uploader;
    } else if (media.user) {
      result.uploader = media.user.username || result.uploader;
    } else if (media.author) {
      result.uploader = media.author.username || result.uploader;
    }

    // Check if it's a carousel (multiple images/videos)
    if (media.edge_sidecar_to_children?.edges) {
      const edges = media.edge_sidecar_to_children.edges;
      result.isCarousel = true;
      result.carouselItems = [];
      
      edges.forEach((edge) => {
        const node = edge.node || edge;
        const typename = node.__typename || '';
        
        if (typename.includes('Image') || node.display_url) {
          result.carouselItems.push({
            type: 'image',
            url: node.display_url || node.display_resources?.[node.display_resources.length - 1]?.src
          });
        } else if (typename.includes('Video') || node.video_url) {
          result.carouselItems.push({
            type: 'video',
            url: node.video_url || node.video_playback_url
          });
        }
      });
      
      console.log(`[Instagram] Found carousel with ${result.carouselItems.length} items`);
    }
    // Single image
    else if (media.display_url) {
      result.type = 'image';
      result.url = media.display_url || media.display_resources?.[media.display_resources.length - 1]?.src;
      console.log('[Instagram] Found single image');
    }
    // Video
    else if (media.video_url || media.video_playback_url) {
      result.type = 'video';
      result.url = media.video_url || media.video_playback_url;
      result.duration = media.video_duration;
      console.log('[Instagram] Found video');
    }
  } catch (e) {
    console.log('[Instagram] extractFromMedia error:', e.message);
  }
}

// Helper: Get info from any supported platform
function getMediaInfo(url, platform = 'youtube') {
  return new Promise((resolve, reject) => {
    // If platform is unknown, it's likely a search or a link that should use YouTube args as fallback
    const args = (platform === 'youtube' || platform === 'unknown') ? buildYoutubeDlpArgs() : buildSocialDlpArgs();
    console.log(`[yt-dlp] Fetching info for ${platform} using args: ${args}`);

    // Use --no-warnings to keep stdout clean, and ensure we use the built args
    exec(`yt-dlp ${args} --dump-json "${url}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[yt-dlp] Error fetching info: ${stderr}`);
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Helper: Download from any supported platform
function downloadMediaFile(url, outputPath, platform = 'youtube') {
  return new Promise((resolve, reject) => {
    let cmd;
    
    if (platform === 'tiktok') {
      // TikTok-specific args: use native best format without re-encoding to avoid FPS issues
      const args = buildSocialDlpArgs('--concurrent-fragments 8');
      cmd = `yt-dlp ${args} -f "best" --no-recode -o "${outputPath}" "${url}"`;
    } else {
      const args = platform === 'youtube' ? buildYoutubeDlpArgs('--concurrent-fragments 8') : buildSocialDlpArgs('--concurrent-fragments 8');
      cmd = `yt-dlp ${args} -f "best" -o "${outputPath}" "${url}"`;
    }

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

// Helper: Format file size
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Format duration
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Helper: Get video info using yt-dlp
function getVideoInfo(url) {
  return getMediaInfo(url, 'youtube');
}

// Helper: Search YouTube using yt-dlp
function searchYouTube(query, maxResults = 10) {
  return new Promise((resolve, reject) => {
    // Use --dump-json with --flat-playlist for reliable Unicode support
    const cmd = `yt-dlp ${buildYoutubeDlpArgs()} --flat-playlist --no-download --dump-json "ytsearch${maxResults}:${query}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const results = [];
        const lines = stdout.trim().split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const videoId = entry.id || '';
            const title = entry.title || 'بدون عنوان';
            const duration = entry.duration || 0;
            const viewCount = entry.view_count || 0;
            const uploader = entry.uploader || entry.channel || 'غير معروف';
            const webpageUrl = entry.webpage_url || entry.url || '';

            // Generate thumbnail from video ID
            const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
            const url = webpageUrl || `https://www.youtube.com/watch?v=${videoId}`;

            results.push({
              id: videoId,
              title: title.substring(0, 100),
              duration: Math.floor(duration),
              view_count: viewCount,
              uploader: uploader.substring(0, 60),
              thumbnail: thumbnail,
              url: url,
              webpage_url: url
            });
          } catch (e) {
            // Skip invalid JSON lines
          }
        }

        resolve(results);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Helper: Download video with specific quality
async function downloadVideoFile(url, quality, outputPath) {
  const ytQualityMap = {
    '144': '144',
    '240': '240',
    '360': '360',
    '480': '480',
    '720': '720',
    '1080': '1080'
  };
  const h = ytQualityMap[quality] || '720';

  // Use -f to select best video+audio with max height h
  const cmd = `yt-dlp ${buildYoutubeDlpArgs('--concurrent-fragments 8')} -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best" -o "${outputPath}" --merge-output-format mp4 "${url}"`;

  try {
    await new Promise((resolve, reject) => {
      exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    // If cookies error, refresh and retry once
    if (isYouTubeCookiesInvalidError(error) || isYouTubeBotChallengeError(error)) {
      console.log('[YouTube] Cookie error during download, refreshing...');
      await refreshYouTubeCookies();
      
      // Retry once
      const cmd2 = `yt-dlp ${buildYoutubeDlpArgs('--concurrent-fragments 8')} -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best" -o "${outputPath}" --merge-output-format mp4 "${url}"`;
      
      await new Promise((resolve, reject) => {
        exec(cmd2, { maxBuffer: 1024 * 1024 * 50 }, (error2, stdout2, stderr2) => {
          if (error2) {
            reject(error2);
            return;
          }
          resolve();
        });
      });
    } else {
      throw error;
    }
  }
}

// Helper: Download audio only
async function downloadAudioFile(url, outputPath) {
  try {
    const cmd = `yt-dlp ${buildYoutubeDlpArgs('--concurrent-fragments 8')} -x --audio-format mp3 -o "${outputPath}" "${url}"`;

    await new Promise((resolve, reject) => {
      exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    // If cookies error, refresh and retry once
    if (isYouTubeCookiesInvalidError(error) || isYouTubeBotChallengeError(error)) {
      console.log('[YouTube] Cookie error during audio download, refreshing...');
      await refreshYouTubeCookies();
      
      // Retry once
      const cmd2 = `yt-dlp ${buildYoutubeDlpArgs('--concurrent-fragments 8')} -x --audio-format mp3 -o "${outputPath}" "${url}"`;
      
      await new Promise((resolve, reject) => {
        exec(cmd2, { maxBuffer: 1024 * 1024 * 50 }, (error2, stdout2, stderr2) => {
          if (error2) {
            reject(error2);
            return;
          }
          resolve();
        });
      });
    } else {
      throw error;
    }
  }
}

// Helper: Upload video with progress (send directly from local file - faster)
async function uploadVideoWithProgress(chatId, outputPath, caption, statusMessage, quality) {
  const fileSize = fs.statSync(outputPath).size;
  const videoStream = fs.createReadStream(outputPath);

  try {
    // Send as a stream so Telegram can start receiving bytes immediately.
    await bot.sendVideo(chatId, videoStream, {
      caption: caption,
      parse_mode: 'Markdown',
      supports_streaming: true
    });
    return true;
  } catch (uploadError) {
    console.error('Upload error:', uploadError);
    return false;
  }
}

// Helper: Upload audio with progress (send directly from local file - faster)
async function uploadAudioWithProgress(chatId, outputPath, title, performer, statusMessage) {
  const fileSize = fs.statSync(outputPath).size;
  const audioStream = fs.createReadStream(outputPath);

  try {
    // Send as a stream so Telegram begins the transfer immediately.
    await bot.sendAudio(chatId, audioStream, {
      title: title,
      performer: performer
    });
    return true;
  } catch (uploadError) {
    console.error('Upload error:', uploadError);
    return false;
  }
}

// ========== USER COMMANDS ==========

// Command: /start
bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  trackUser(chatId, msg.from || {});

  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  const welcomeMessage = `
👋 *أهلاً بك في بوت التحميل!*

📥 حمّل من:
• يوتيوب 🔴
• انستجرام 📸
• تيك توك 🎵

*طريقة الاستخدام:*
1️⃣ أرسل رابط من أي منصة
2️⃣ البوت يتعرف تلقائياً
3️⃣ انتظر التحميل

*اليوتيوب يدعم:*
• اختيار الجودة (144p - 1080p)
• تحميل صوت فقط
• البحث داخل البوت

*الأوامر:*
/start - تشغيل البوت
/help - عرض المساعدة
/search - بحث في يوتيوب
/audio - تحميل صوت فقط
/video - تحميل فيديو

_أرسل رابط للبدء!_
  `;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Command: /help
bot.onText(/^\/help(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  const helpMessage = `
📖 *دليل المساعدة*

*المنصات المدعومة:*
🔴 يوتيوب - بجودات متعددة
📸 انستجرام - ريلز وفيديوهات
🎵 تيك توك - فيديوهات

*كيف تحمّل:*
• انسخ رابط من أي منصة
• أرسله للبوت مباشرة
• البوت يتعرف تلقائياً!

*اليوتيوب فقط:*
• يمكنك اختيار الجودة
• أو البحث مباشرة:
\`أغاني عراقية\`

*مثال روابط:*
\`https://www.youtube.com/watch?v=...\`
\`https://www.instagram.com/p/...\`
\`https://www.tiktok.com/@.../video/...\`

*ملاحظات:*
• الحد الأقصى: 20 دقيقة
• الحد الأقصى: 50 ميجابايت
• يتم حذف الملفات تلقائياً

*الأوامر:*
/start - تشغيل البوت
/help - عرض المساعدة
/search - بحث في يوتيوب
/audio - تحميل صوت فقط
/video - تحميل فيديو
  `;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Command: /audio
bot.onText(/^\/audio(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  userState.set(chatId, { audioOnly: true });
  bot.sendMessage(chatId, '🎵 *تم تفعيل وضع الصوت*\n\nأرسل رابط يوتيوب لتحميل الصوت فقط.\n\nاستخدم /video للعودة للفيديو.', { parse_mode: 'Markdown' });
});

// Command: /video
bot.onText(/^\/video(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  userState.set(chatId, { audioOnly: false });
  bot.sendMessage(chatId, '🎬 *تم تفعيل وضع الفيديو*\n\nأرسل رابط يوتيوب لتحميل الفيديو.', { parse_mode: 'Markdown' });
});

// Command: /search
bot.onText(/^\/search(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  const query = match[1].trim();
  if (!query) {
    bot.sendMessage(chatId, '❌ يرجى كتابة كلمة البحث.\n\nمثال: `/search أغاني عربية`', { parse_mode: 'Markdown' });
    return;
  }

  trackUser(chatId, msg.from || {});

  const loadingMsg = await bot.sendMessage(chatId, `🔍 *جاري البحث عن:*\n"${query}"\n\n⏳ يرجى الانتظار...`, { parse_mode: 'Markdown' });

  try {
    const results = await searchYouTube(query, 10);

    if (!results || results.length === 0) {
      bot.editMessageText('❌ لم يتم العثور على نتائج.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id
      });
      return;
    }

    // Store search results for this user
    userState.set(chatId, { searchResults: results });

    // Build inline keyboard with results
    const inlineKeyboard = [];
    const maxShow = Math.min(results.length, 10);

    for (let i = 0; i < maxShow; i++) {
      const video = results[i];
      const duration = video.duration || 0;
      const durationText = duration > 0 ? ` (${formatDuration(duration)})` : '';
      inlineKeyboard.push([{
        text: `${i + 1}. ${video.title}${durationText}`,
        callback_data: `search_select_${i}`
      }]);
    }

    bot.editMessageText(`🔍 *نتائج البحث عن:* "${query}"\n\nاختر الفيديو الذي تريده:`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });

  } catch (error) {
    console.error('Search error:', error);
    bot.editMessageText('❌ خطأ أثناء البحث. يرجى المحاولة مرة أخرى.', {
      chat_id: chatId,
      message_id: loadingMsg.message_id
    });
  }
});

// ========== ADMIN COMMANDS ==========

function isAdmin(chatId) {
  return chatId === ADMIN_ID;
}

// Command: /admin
bot.onText(/^\/admin(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، هذا الأمر متاح للمطور فقط.');
    return;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 الإحصائيات', callback_data: 'admin_stats' }],
        [{ text: '📢 بث رسالة', callback_data: 'admin_broadcast' }],
        [{ text: '🚫 قائمة المحظورين', callback_data: 'admin_blocked' }],
        [{ text: '👥 المستخدمين', callback_data: 'admin_users' }]
      ]
    }
  };

  bot.sendMessage(chatId, `
🔧 *لوحة تحكم المطور*

اختر أحد الخيارات:
  `, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
});

// Command: /stats (shortcut for admin)
bot.onText(/^\/stats(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، هذا الأمر متاح للمطور فقط.');
    return;
  }
  sendAdminStats(chatId);
});

// Command: /ban
bot.onText(/^\/ban(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (!isAdmin(chatId)) return;

  const userId = parseInt(match[1]);
  if (isNaN(userId)) {
    bot.sendMessage(chatId, '❌ معرف المستخدم غير صحيح.');
    return;
  }

  blockedUsers.add(userId);
  saveStats();

  try {
    await bot.sendMessage(userId, '❌ تم حظرك من استخدام هذا البوت.');
  } catch (e) {}

  bot.sendMessage(chatId, `✅ تم حظر المستخدم: \`${userId}\``, { parse_mode: 'Markdown' });
});

// Command: /unban
bot.onText(/^\/unban(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (!isAdmin(chatId)) return;

  const userId = parseInt(match[1]);
  if (isNaN(userId)) {
    bot.sendMessage(chatId, '❌ معرف المستخدم غير صحيح.');
    return;
  }

  blockedUsers.delete(userId);
  saveStats();

  bot.sendMessage(chatId, `✅ تم إلغاء حظر المستخدم: \`${userId}\``, { parse_mode: 'Markdown' });
});

// Command: /broadcast (with text)
bot.onText(/^\/broadcast(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  await ensureStorageReady();

  if (!isAdmin(chatId)) return;

  const message = match[1];
  let successCount = 0;
  let failCount = 0;

  const statusMsg = await bot.sendMessage(chatId, `📢 *جاري بث الرسالة...*\n\nيرجى الانتظار...`, { parse_mode: 'Markdown' });

  for (const userId of activeUsers) {
    if (blockedUsers.has(userId)) continue;
    try {
      await bot.sendMessage(userId, message);
      successCount++;
    } catch (e) {
      failCount++;
    }
  }

  bot.editMessageText(`✅ *تم البث بنجاح!*\n\n📤 تم الإرسال: ${successCount}\n❌ فشل: ${failCount}`, {
    chat_id: chatId,
    message_id: statusMsg.message_id,
    parse_mode: 'Markdown'
  });
});

// Admin Stats function
function sendAdminStats(chatId) {
  const diskUsage = getFolderSize(DOWNLOAD_DIR);

  const msg = `
📊 *إحصائيات البوت*

👥 *المستخدمين:* ${stats.totalUsers}
📥 *إجمالي التحميلات:* ${stats.totalDownloads}
🎬 *فيديوهات محملة:* ${stats.totalVideos}
🎵 *أصوات محملة:* ${stats.totalAudios}
💾 *مساحة التحميلات:* ${formatBytes(diskUsage)}
🚫 *محظورين:* ${blockedUsers.size}
  `;

  bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

function getFolderSize(folderPath) {
  let total = 0;
  try {
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      total += fs.statSync(filePath).size;
    }
  } catch (e) {}
  return total;
}

// ========== HANDLE MESSAGES ==========

// Handle messages (YouTube links)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  await ensureStorageReady();

  // Track user
  trackUser(chatId, msg.from || {});

  // Check blocked users
  if (blockedUsers.has(chatId)) {
    bot.sendMessage(chatId, '❌ عذراً، حسابك محظور من استخدام هذا البوت.');
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  // Skip commands
  if (text && text.startsWith('/')) return;

  // Detect platform first
  const platform = detectPlatform(text);
  console.log(`📥 رسالة من ${chatId}: "${text.substring(0, 50)}" | المنصة: ${platform}`);

  // Handle Instagram
  if (platform === 'instagram') {
    try {
      bot.sendChatAction(chatId, 'typing');
      const info = await getInstagramInfo(text);

      const title = info.title || 'بدون عنوان';
      const author = info.uploader || 'انستجرام';

      // Check if extraction failed
      const hasData = info.url || info.carouselItems || info.type === 'video' || info.type === 'image';
      
      if (!hasData) {
        bot.sendMessage(chatId, '❌ تعذر استخراج البيانات من انستجرام.\n\n💡 الأسباب المحتملة:\n• الحساب خاص وليس عام\n• البوست محذوف\n• الكوكيز منتهية الصلاحية\n\n🔄 حاول تحديث ملف الكوكيز أو أرسل رابط بوست عام آخر.');
        return;
      }

      const statusMsg = await bot.sendMessage(chatId, `⬇️ *جاري التحميل من انستجرام...*\n\n📌 ${title.substring(0, 80)}`, { parse_mode: 'Markdown' });

      try {
        // Check if it's a carousel (multiple images/videos)
        const isCarousel = info.isCarousel || (info.carouselItems && info.carouselItems.length > 0);
        
        if (isCarousel) {
          // Handle carousel - download each item
          const downloadedFiles = [];
          
          for (let i = 0; i < info.carouselItems.length; i++) {
            const item = info.carouselItems[i];
            const ext = item.type === 'video' ? 'mp4' : 'jpg';
            const safeFilename = `insta_${item.type}_${Date.now()}_${i}.${ext}`;
            const outputPath = path.join(DOWNLOAD_DIR, safeFilename);

            try {
              await downloadImage(item.url, outputPath);
              if (fs.existsSync(outputPath)) {
                downloadedFiles.push({ path: outputPath, type: item.type });
              }
            } catch (err) {
              console.error(`Failed to download carousel item ${i}:`, err.message);
            }
          }

          if (downloadedFiles.length === 0) {
            throw new Error('No carousel items found');
          }

          await bot.editMessageText('⬆️ *جاري الإرسال...* 📤', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
          });

          // Send each item
          for (let i = 0; i < downloadedFiles.length; i++) {
            const file = downloadedFiles[i];
            const caption = i === 0 ? `📸 ${title.substring(0, 100)}\n👤 ${author}\n📊 ${downloadedFiles.length} صور/فيديو` : undefined;
            
            if (file.type === 'video') {
              await bot.sendVideo(chatId, file.path, { caption });
            } else {
              await bot.sendPhoto(chatId, file.path, { caption });
            }
          }

          stats.totalDownloads++;
          saveStats();

          // Cleanup
          downloadedFiles.forEach((file) => {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
          });

        } else if (info.type === 'image' || info.ext === 'jpg' || info.ext === 'jpeg') {
          // Handle single image
          const safeFilename = `insta_photo_${Date.now()}.jpg`;
          const outputPath = path.join(DOWNLOAD_DIR, safeFilename);

          try {
            await downloadImage(info.url, outputPath);
          } catch (error) {
            console.error('Instagram image download error:', error);
            bot.editMessageText('❌ خطأ أثناء التحميل.', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown'
            });
            return;
          }

          if (!fs.existsSync(outputPath)) {
            bot.editMessageText('❌ فشل التحميل.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
            return;
          }

          const fileStats = fs.statSync(outputPath);
          if (fileStats.size > 50 * 1024 * 1024) {
            bot.editMessageText('❌ الملف كبير جداً! الحد: 50 ميجابايت.', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown'
            });
            fs.unlinkSync(outputPath);
            return;
          }

          await bot.editMessageText('⬆️ *جاري الإرسال...* 📤', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
          });

          try {
            await bot.sendPhoto(chatId, outputPath, {
              caption: `📸 ${title.substring(0, 100)}\n👤 ${author}\n📦 ${formatBytes(fileStats.size)}`,
              parse_mode: 'Markdown'
            });

            stats.totalDownloads++;
            saveStats();
          } catch (uploadError) {
            console.error('Instagram upload error:', uploadError);
            bot.editMessageText('❌ خطأ أثناء الإرسال.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
          }

          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

        } else if (info.type === 'video') {
          // Handle video (use yt-dlp only if it already succeeded)
          const safeFilename = title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60);
          const ext = info.ext || 'mp4';
          const outputPath = path.join(DOWNLOAD_DIR, `${safeFilename}.${ext}`);

          // If yt-dlp already gave us info, use it
          if (info.url) {
            // Download directly from URL
            try {
              await downloadImage(info.url, outputPath);
            } catch (error) {
              console.error('Instagram video download error:', error);
              bot.editMessageText('❌ خطأ أثناء التحميل.', {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
              });
              return;
            }
          } else {
            // Need to use yt-dlp
            try {
              await downloadMediaFile(text, outputPath, 'instagram');
            } catch (error) {
              console.error('Instagram download error:', error);
              bot.editMessageText('❌ خطأ أثناء التحميل. تأكد أن المنشور عام وليس خاص.', {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
              });
              return;
            }
          }

          if (!fs.existsSync(outputPath)) {
            bot.editMessageText('❌ فشل التحميل.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
            return;
          }

          const fileStats = fs.statSync(outputPath);
          if (fileStats.size > 50 * 1024 * 1024) {
            bot.editMessageText('❌ الملف كبير جداً! الحد: 50 ميجابايت.', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown'
            });
            fs.unlinkSync(outputPath);
            return;
          }

          await bot.editMessageText('⬆️ *جاري الإرسال...* 📤', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
          });

          try {
            if (ext === 'mp4' || ext === 'mov') {
              await bot.sendVideo(chatId, outputPath, {
                caption: `📸 ${title.substring(0, 100)}\n👤 ${author}\n📦 ${formatBytes(fileStats.size)}`,
                parse_mode: 'Markdown'
              });
            } else {
              await bot.sendDocument(chatId, outputPath, {
                caption: `📸 ${title.substring(0, 100)}\n👤 ${author}\n📦 ${formatBytes(fileStats.size)}`,
                parse_mode: 'Markdown'
              });
            }

            stats.totalDownloads++;
            saveStats();
          } catch (uploadError) {
            console.error('Instagram upload error:', uploadError);
            bot.editMessageText('❌ خطأ أثناء الإرسال.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
          }

          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
      } catch (downloadError) {
        console.error('Instagram download/upload error:', downloadError);
        bot.editMessageText('❌ خطأ أثناء التحميل أو الإرسال.', {
          chat_id: chatId,
          message_id: statusMsg.message_id
        });
      }

    } catch (error) {
      console.error('Instagram error:', error);
      bot.sendMessage(chatId, '❌ خطأ في تحميل المنشور. تأكد من أن الرابط صحيح والمنشور عام.');
    }
    return;
  }

  // Handle TikTok
  if (platform === 'tiktok') {
    try {
      bot.sendChatAction(chatId, 'typing');
      
      // Use the new getTikTokInfo function which has fallback
      const info = await getTikTokInfo(text);

      const title = info.title || 'بدون عنوان';
      const author = info.uploader || info.channel || 'تيك توك';

      const statusMsg = await bot.sendMessage(chatId, `⬇️ جاري التحميل من تيك توك...\n\n📌 ${title.substring(0, 80)}`);

      try {
        // Check if it's a photo/slideshow (TikTok photo posts)
        const isPhoto = info.type === 'photo';
        const isSlideshow = info.isSlideshow || (info.images && info.images.length > 1);
        const isVideo = info.type === 'video' || (!isPhoto && !isSlideshow);

        // Handle photo/slideshow
        if (isPhoto || isSlideshow) {
          // For TikTok photos, we need to download from the image URLs directly
          const downloadedFiles = [];
          
          // If we have images array (slideshow)
          if (info.images && info.images.length > 0) {
            for (let i = 0; i < info.images.length; i++) {
              const imageUrl = info.images[i];
              const safeFilename = `tiktok_photo_${Date.now()}_${i}.jpg`;
              const outputPath = path.join(DOWNLOAD_DIR, safeFilename);

              try {
                await downloadImage(imageUrl, outputPath);
                if (fs.existsSync(outputPath)) {
                  downloadedFiles.push(outputPath);
                }
              } catch (err) {
                console.error(`Failed to download image ${i}:`, err.message);
              }
            }
          }
          // Single photo with URL
          else if (info.url) {
            const safeFilename = `tiktok_photo_${Date.now()}.jpg`;
            const outputPath = path.join(DOWNLOAD_DIR, safeFilename);

            try {
              await downloadImage(info.url, outputPath);
              if (fs.existsSync(outputPath)) {
                downloadedFiles.push(outputPath);
              }
            } catch (err) {
              console.error('Failed to download photo:', err.message);
            }
          }

          // Send photos
          if (downloadedFiles.length === 0) {
            throw new Error('No photos found');
          }

          await bot.editMessageText('⬆️ *جاري الإرسال...* 📤', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
          });

          // Send each photo individually
          for (let i = 0; i < downloadedFiles.length; i++) {
            const filePath = downloadedFiles[i];
            const caption = i === 0 ? `📸 ${title.substring(0, 100)}\n👤 ${author}` : undefined;
            
            await bot.sendPhoto(chatId, filePath, { caption });
          }

          stats.totalDownloads++;
          saveStats();

          // Cleanup
          downloadedFiles.forEach((filePath) => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          });

        } else if (isVideo) {
          // Handle video (use yt-dlp)
          const safeFilename = title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60);
          const outputPath = path.join(DOWNLOAD_DIR, `${safeFilename}.mp4`);

          try {
            await downloadMediaFile(text, outputPath, 'tiktok');
          } catch (error) {
            console.error('TikTok download error:', error);
            bot.editMessageText('❌ خطأ أثناء التحميل. تأكد أن الفيديو عام.', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown'
            });
            return;
          }

          if (!fs.existsSync(outputPath)) {
            bot.editMessageText('❌ فشل التحميل.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
            return;
          }

          const fileStats = fs.statSync(outputPath);
          if (fileStats.size > 50 * 1024 * 1024) {
            bot.editMessageText('❌ الملف كبير جداً! الحد: 50 ميجابايت.', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown'
            });
            fs.unlinkSync(outputPath);
            return;
          }

          await bot.editMessageText('⬆️ *جاري الإرسال...* 📤', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
          });

          try {
            await bot.sendVideo(chatId, outputPath, {
              caption: `🎵 ${title.substring(0, 100)}\n👤 ${author}\n📦 ${formatBytes(fileStats.size)}`
            });

            stats.totalDownloads++;
            saveStats();
          } catch (uploadError) {
            console.error('TikTok upload error:', uploadError);
            bot.editMessageText('❌ خطأ أثناء الإرسال.', {
              chat_id: chatId,
              message_id: statusMsg.message_id
            });
          }

          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
      } catch (downloadError) {
        console.error('TikTok download/upload error:', downloadError);
        bot.editMessageText('❌ خطأ أثناء التحميل أو الإرسال.', {
          chat_id: chatId,
          message_id: statusMsg.message_id
        });
      }

    } catch (error) {
      console.error('TikTok error:', error);
      bot.sendMessage(chatId, '❌ خطأ في تحميل المحتوى من تيك توك. تأكد من أن الرابط صحيح والمحتوى عام.');
    }
    return;
  }

  // Unknown platform - treat as YouTube search query
  if (platform === 'unknown') {
    const query = text.trim();
    if (!query) {
      bot.sendMessage(chatId, '❌ يرجى إرسال رابط صحيح.\n\nالمنصات المدعومة:\n• يوتيوب\n• انستجرام\n• تيك توك', { parse_mode: 'Markdown' });
      return;
    }

    // Auto-search YouTube
    const loadingMsg = await bot.sendMessage(chatId, `🔍 *جاري البحث عن:*\n"${query}"\n\n⏳ يرجى الانتظار...`, { parse_mode: 'Markdown' });

    try {
      const results = await searchYouTube(query, 10);

      if (!results || results.length === 0) {
        bot.editMessageText('❌ لم يتم العثور على نتائج.\n\n💡 جرّب كلمات بحث مختلفة أو أرسل رابط مباشر.', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown'
        });
        return;
      }

      // Store search results for this user
      userState.set(chatId, { ...userState.get(chatId), searchResults: results });

      // Build inline keyboard with results
      const inlineKeyboard = [];
      const maxShow = Math.min(results.length, 10);

      for (let i = 0; i < maxShow; i++) {
        const video = results[i];
        const duration = video.duration || 0;
        const durationText = duration > 0 ? ` (${formatDuration(duration)})` : '';
        inlineKeyboard.push([{
          text: `${i + 1}. ${video.title}${durationText}`,
          callback_data: `search_select_${i}`
        }]);
      }

      bot.editMessageText(`🔍 *نتائج البحث عن:* "${query}"\n\nاختر الفيديو الذي تريده:`, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });

    } catch (error) {
      console.error('Search error:', error);
      bot.editMessageText('❌ خطأ أثناء البحث. يرجى المحاولة مرة أخرى.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id
      });
    }
    return;
  }

  // Handle YouTube
  try {
    // Send typing indicator
    bot.sendChatAction(chatId, 'typing');

    // Get video info with retry on cookie failure
    let info;
    try {
      info = await getVideoInfo(text);
    } catch (error) {
      // Check if it's a cookies issue
      if (isYouTubeCookiesInvalidError(error) || isYouTubeBotChallengeError(error)) {
        console.log('[YouTube] Cookies invalid, attempting refresh...');
        const refreshed = await refreshYouTubeCookies();
        
        if (refreshed) {
          // Retry with fresh cookies
          try {
            info = await getVideoInfo(text);
            console.log('[YouTube] Retry succeeded with fresh cookies!');
          } catch (retryError) {
            throw new Error('فشل التحديث حتى بعد تحديث الكوكيز. الكوكيز تحتاج تحديث من المتصفح.');
          }
        } else {
          throw new Error('فشل تحديث الكوكيز. تأكد من رابط الكوكيز في المتغيرات.');
        }
      } else {
        throw error;
      }
    }

    // Check video length (max 20 minutes)
    const duration = parseInt(info.duration || 0);
    if (duration > 1200) {
      bot.sendMessage(chatId, '❌ الفيديو طويل جداً! الحد الأقصى: 20 دقيقة.');
      return;
    }

    // Get thumbnail
    const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');

    // Check if audio only mode
    const state = userState.get(chatId) || {};
    if (state.audioOnly) {
      bot.sendMessage(chatId, `🎵 *جاري تحميل الصوت...*\n\n📌 العنوان: ${info.title}`, { parse_mode: 'Markdown' });
      await downloadAudio(chatId, text, info);
      return;
    }

    // Create quality selection buttons
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '144p', callback_data: `quality_144_${text}` },
            { text: '240p', callback_data: `quality_240_${text}` },
            { text: '360p', callback_data: `quality_360_${text}` }
          ],
          [
            { text: '480p', callback_data: `quality_480_${text}` },
            { text: '720p HD', callback_data: `quality_720_${text}` },
            { text: '1080p FHD', callback_data: `quality_1080_${text}` }
          ],
          [
            { text: '🎵 صوت فقط', callback_data: `audio_${text}` }
          ]
        ]
      }
    };

    const videoInfoMessage = `
📹 *تم العثور على الفيديو*

📌 *العنوان:* ${info.title}
⏱️ *المدة:* ${formatDuration(duration)}
👁️ *المشاهدات:* ${parseInt(info.view_count || 0).toLocaleString()}
👤 *الناشر:* ${info.uploader || info.channel || 'غير معروف'}

*اختر الجودة:*
    `;

    const sendOptions = {
      caption: videoInfoMessage,
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    };

    if (thumbnail) {
      bot.sendPhoto(chatId, thumbnail, sendOptions);
    } else {
      bot.sendMessage(chatId, videoInfoMessage, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    }

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, `❌ ${getFriendlyVideoError(error)}`);
  }
});

// ========== HANDLE CALLBACK QUERIES ==========

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  await ensureStorageReady();

  // Answer callback
  bot.answerCallbackQuery(callbackQuery.id);

  if (blockedUsers.has(chatId)) {
    return;
  }

  // Check channel subscription
  const isSubscribed = await checkChannelSubscription(chatId);
  if (!isSubscribed) {
    sendChannelSubscriptionMessage(chatId);
    return;
  }

  // Admin callbacks
  if (data.startsWith('admin_')) {
    if (!isAdmin(chatId)) return;

    if (data === 'admin_stats') {
      bot.deleteMessage(chatId, messageId).catch(() => {});
      sendAdminStats(chatId);
    } else if (data === 'admin_blocked') {
      bot.deleteMessage(chatId, messageId).catch(() => {});
      const blockedList = [...blockedUsers].map(id => `\`${id}\``).join('\n') || 'لا يوجد مستخدمين محظورين';
      bot.sendMessage(chatId, `🚫 *قائمة المحظورين:*\n\n${blockedList}`, { parse_mode: 'Markdown' });
    } else if (data === 'admin_users') {
      bot.deleteMessage(chatId, messageId).catch(() => {});
      const userList = [...activeUsers].map(id => `\`${id}\``).join('\n') || 'لا يوجد مستخدمين';
      bot.sendMessage(chatId, `👥 *المستخدمين (${stats.totalUsers}):*\n\n${userList}`, { parse_mode: 'Markdown' });
    } else if (data === 'admin_broadcast') {
      bot.deleteMessage(chatId, messageId).catch(() => {});
      bot.sendMessage(chatId, `📢 *لبث رسالة لجميع المستخدمين:*\n\nاستخدم الأمر:\n\`/broadcast رسالتك هنا\``, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Search result selection
  if (data.startsWith('search_select_')) {
    const index = parseInt(data.replace('search_select_', ''));
    const state = userState.get(chatId) || {};
    const results = state.searchResults || [];

    if (!results[index]) {
      bot.sendMessage(chatId, '❌ الفيديو غير موجود. جرّب البحث مرة أخرى.');
      return;
    }

    const video = results[index];
    const url = video.url || video.webpage_url;

    // Delete search results message
    bot.deleteMessage(chatId, messageId).catch(() => {});

    try {
      bot.sendChatAction(chatId, 'typing');

      // Check video length
      const duration = parseInt(video.duration || 0);
      if (duration > 1200) {
        bot.sendMessage(chatId, '❌ الفيديو طويل جداً! الحد الأقصى: 20 دقيقة.');
        return;
      }

      // Validate thumbnail URL
      let thumbnail = '';
      if (video.thumbnail && video.thumbnail.startsWith('http')) {
        thumbnail = video.thumbnail;
      } else if (video.id) {
        thumbnail = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
      }

      // Check if audio only mode
      const audioMode = state.audioOnly;
      if (audioMode) {
        bot.sendMessage(chatId, `🎵 *جاري تحميل الصوت...*\n\n📌 العنوان: ${video.title}`, { parse_mode: 'Markdown' });
        await downloadAudio(chatId, url, video);
        return;
      }

      // Create quality selection buttons
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '144p', callback_data: `quality_144_${url}` },
              { text: '240p', callback_data: `quality_240_${url}` },
              { text: '360p', callback_data: `quality_360_${url}` }
            ],
            [
              { text: '480p', callback_data: `quality_480_${url}` },
              { text: '720p HD', callback_data: `quality_720_${url}` },
              { text: '1080p FHD', callback_data: `quality_1080_${url}` }
            ],
            [
              { text: '🎵 صوت فقط', callback_data: `audio_${url}` }
            ]
          ]
        }
      };

      const videoInfoMessage = `
📹 *تم اختيار الفيديو*

📌 *العنوان:* ${video.title}
⏱️ *المدة:* ${formatDuration(duration)}
👁️ *المشاهدات:* ${parseInt(video.view_count || 0).toLocaleString()}
👤 *الناشر:* ${video.uploader || video.channel || 'غير معروف'}

*اختر الجودة:*
      `;

      const sendOptions = {
        caption: videoInfoMessage,
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      };

      if (thumbnail) {
        bot.sendPhoto(chatId, thumbnail, sendOptions).catch(() => {
          // Fallback to text if photo fails
          bot.sendMessage(chatId, videoInfoMessage, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        });
      } else {
        bot.sendMessage(chatId, videoInfoMessage, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
      }

    } catch (error) {
      console.error('Error:', error);
      bot.sendMessage(chatId, '❌ خطأ في جلب معلومات الفيديو. تأكد من أن الفيديو متاح وغير محظور في منطقتك.');
    }
    return;
  }

  if (data.startsWith('quality_')) {
    const parts = data.split('_');
    const quality = parts[1];
    const url = parts.slice(2).join('_');

    // Delete the message with buttons
    bot.deleteMessage(chatId, messageId).catch(() => {});

    try {
      bot.sendChatAction(chatId, 'upload_video');
      await downloadVideo(chatId, url, quality);
    } catch (error) {
      console.error('Download error:', error);
      
      // Retry with fresh cookies if cookie error
      if (isYouTubeCookiesInvalidError(error) || isYouTubeBotChallengeError(error)) {
        console.log('[YouTube] Cookies invalid during download, refreshing...');
        const refreshed = await refreshYouTubeCookies();
        
        if (refreshed) {
          try {
            console.log('[YouTube] Retrying download with fresh cookies...');
            bot.sendChatAction(chatId, 'upload_video');
            await downloadVideo(chatId, url, quality);
            return;
          } catch (retryError) {
            console.error('Retry also failed:', retryError);
          }
        }
      }
      
      bot.sendMessage(chatId, `❌ ${getFriendlyVideoError(error)}`);
    }
  } else if (data.startsWith('audio_')) {
    const url = data.replace('audio_', '');

    bot.deleteMessage(chatId, messageId).catch(() => {});

    try {
      bot.sendChatAction(chatId, 'upload_voice');
      const info = await getVideoInfo(url);
      await downloadAudio(chatId, url, info);
    } catch (error) {
      console.error('Audio download error:', error);
      
      // Retry with fresh cookies if cookie error
      if (isYouTubeCookiesInvalidError(error) || isYouTubeBotChallengeError(error)) {
        console.log('[YouTube] Cookies invalid during audio download, refreshing...');
        const refreshed = await refreshYouTubeCookies();
        
        if (refreshed) {
          try {
            console.log('[YouTube] Retrying audio download with fresh cookies...');
            bot.sendChatAction(chatId, 'upload_voice');
            const info = await getVideoInfo(url);
            await downloadAudio(chatId, url, info);
            return;
          } catch (retryError) {
            console.error('Audio retry also failed:', retryError);
          }
        }
      }
      
      bot.sendMessage(chatId, `❌ ${getFriendlyVideoError(error)}`);
    }
  }
});

// ========== DOWNLOAD FUNCTIONS ==========

// Download video function
async function downloadVideo(chatId, url, quality) {
  const info = await getVideoInfo(url);

  const safeFilename = info.title.replace(/[^a-zA-Z0-9\u0600-\u06FF _-]/g, '_').substring(0, 100);
  const outputPath = path.join(DOWNLOAD_DIR, `${safeFilename}_${quality}p.mp4`);

  const statusMessage = await bot.sendMessage(chatId, `⬇️ *جاري التحميل:*\n${info.title}\n\n📊 الجودة: ${quality}p\n⏳ يرجى الانتظار...`, { parse_mode: 'Markdown' });

  try {
    await downloadVideoFile(url, quality, outputPath);
  } catch (error) {
    console.error('Download error:', error);
    bot.editMessageText('❌ خطأ أثناء التحميل. يرجى المحاولة مرة أخرى.', {
      chat_id: chatId,
      message_id: statusMessage.message_id,
      parse_mode: 'Markdown'
    });
    return;
  }

  // Check file exists
  if (!fs.existsSync(outputPath)) {
    bot.editMessageText('❌ فشل التحميل. الملف غير موجود.', {
      chat_id: chatId,
      message_id: statusMessage.message_id,
      parse_mode: 'Markdown'
    });
    return;
  }

  const fileStats = fs.statSync(outputPath);

  // Check file size (Telegram limit: 50MB for bot API)
  if (fileStats.size > 50 * 1024 * 1024) {
    bot.editMessageText(`❌ الملف كبير جداً! الحد الأقصى: 50 ميجابايت.\n\nجرّب جودة أقل.`, {
      chat_id: chatId,
      message_id: statusMessage.message_id,
      parse_mode: 'Markdown'
    });
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  // Upload video
  const caption = `📹 ${info.title}\n📊 الجودة: ${quality}p\n📦 الحجم: ${formatBytes(fileStats.size)}`;
  const success = await uploadVideoWithProgress(chatId, outputPath, caption, statusMessage, quality);

  if (success) {
    stats.totalDownloads++;
    stats.totalVideos++;
    saveStats();
  }

  // Clean up
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
}

// Download audio function
async function downloadAudio(chatId, url, videoDetails) {
  const safeFilename = videoDetails.title.replace(/[^a-zA-Z0-9\u0600-\u06FF _-]/g, '_').substring(0, 100);
  const outputPath = path.join(DOWNLOAD_DIR, `${safeFilename}.mp3`);

  const statusMessage = await bot.sendMessage(chatId, `⬇️ *جاري تحميل الصوت:*\n${videoDetails.title}\n\n⏳ يرجى الانتظار...`, { parse_mode: 'Markdown' });

  try {
    await downloadAudioFile(url, outputPath);
  } catch (error) {
    console.error('Audio download error:', error);
    bot.editMessageText('❌ خطأ أثناء التحميل. يرجى المحاولة مرة أخرى.', {
      chat_id: chatId,
      message_id: statusMessage.message_id,
      parse_mode: 'Markdown'
    });
    return;
  }

  if (!fs.existsSync(outputPath)) {
    bot.editMessageText('❌ فشل التحميل. الملف غير موجود.', {
      chat_id: chatId,
      message_id: statusMessage.message_id,
      parse_mode: 'Markdown'
    });
    return;
  }

  const performer = videoDetails.uploader || videoDetails.channel || 'غير معروف';

  // Upload audio
  const success = await uploadAudioWithProgress(chatId, outputPath, videoDetails.title, performer, statusMessage);

  if (success) {
    stats.totalDownloads++;
    stats.totalAudios++;
    saveStats();
  }

  // Clean up
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
}

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message, error.response?.body || error.response?.description || '');
});

async function startBot() {
  try {
    console.log('[Startup] Preparing cookies...');
    const youtubeResult = await prepareCookiesFile(YOUTUBE_COOKIES_FILE, YOUTUBE_COOKIES_URL, 'cookies-youtube.txt');
    const socialResult = await prepareCookiesFile(SOCIAL_COOKIES_FILE, SOCIAL_COOKIES_URL, 'cookies-social.txt');
    
    YOUTUBE_COOKIES_FILE = youtubeResult;
    SOCIAL_COOKIES_FILE = socialResult;
    process.env.YTDLP_YOUTUBE_COOKIES_FILE = YOUTUBE_COOKIES_FILE;
    process.env.YTDLP_SOCIAL_COOKIES_FILE = SOCIAL_COOKIES_FILE;
    
    console.log(`[Startup] YT Cookies: ${YOUTUBE_COOKIES_FILE || 'None'}`);
    console.log(`[Startup] Social Cookies: ${SOCIAL_COOKIES_FILE || 'None'}`);

    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (error) {
    console.error('Webhook cleanup error:', error.message);
  }

  await bot.startPolling();
  console.log('🤖 البوت يعمل الآن...');
  console.log(`👤 معرف المطور: ${ADMIN_ID}`);
}

startBot().catch((error) => {
  console.error('Bot startup failed:', error.message);
  process.exit(1);
});
