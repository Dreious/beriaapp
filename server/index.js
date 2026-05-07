const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const users = [
  {
    id: 'student-1',
    username: 'ogrenci',
    password: '123456',
    displayName: 'Ogrenci',
    role: 'user',
  },
  {
    id: 'admin-1',
    username: 'admin',
    password: 'admin123',
    displayName: 'Admin',
    role: 'admin',
  },
];

const sessions = new Map();
const messages = [];
const liveLocations = new Map();
const userStatuses = new Map();
const userSettings = new Map();
const pushTokensByUserId = new Map();
const lastPushNotificationByUserId = new Map();
const MESSAGE_NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        process.env.NODE_ENV === 'production' && !DATABASE_URL.includes('localhost')
          ? { rejectUnauthorized: false }
          : false,
    })
  : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|jpg|png|webp|gif)$/.test(file.mimetype));
  },
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

function findUserByToken(token) {
  if (!token) {
    return null;
  }

  const userId = sessions.get(token);
  return users.find((user) => user.id === userId) || null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = findUserByToken(token);

  if (!user) {
    return res.status(401).json({ message: 'Oturum bulunamadi.' });
  }

  req.user = user;
  next();
}

function getValidLocation(rawLocation) {
  const latitude = Number(rawLocation?.latitude);
  const longitude = Number(rawLocation?.longitude);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracy:
      Number.isFinite(Number(rawLocation.accuracy)) ? Number(rawLocation.accuracy) : null,
    updatedAt: new Date().toISOString(),
  };
}

function getPublicBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function scheduleAttachmentDeletion(filename, delay = UPLOAD_TTL_MS) {
  setTimeout(() => {
    fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch(() => null);
  }, delay).unref?.();
}

async function cleanupExpiredUploads() {
  try {
    const files = await fs.promises.readdir(UPLOAD_DIR);
    const now = Date.now();

    await Promise.all(files.map(async (filename) => {
      const filePath = path.join(UPLOAD_DIR, filename);
      const stat = await fs.promises.stat(filePath);
      const age = now - stat.mtimeMs;

      if (age >= UPLOAD_TTL_MS) {
        await fs.promises.unlink(filePath).catch(() => null);
        return;
      }

      scheduleAttachmentDeletion(filename, UPLOAD_TTL_MS - age);
    }));
  } catch (error) {
    // Upload klasoru okunamazsa server akisini bozma.
  }
}

function isValidExpoPushToken(token) {
  return /^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/.test(token);
}

function getPushTokensForUser(userId) {
  return Array.from(pushTokensByUserId.get(userId) || []);
}

async function sendExpoPushNotifications(tokens, message) {
  if (tokens.length === 0) {
    return;
  }

  const payload = tokens.map((to) => ({
    to,
    sound: 'default',
    title: `${message.sender.displayName} mesaj atti`,
    body: message.text,
    data: {
      messageId: message.id,
      type: 'chat-message',
    },
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Push servisi ulasilamazsa chat akisina dokunma.
  }
}

function shouldNotifyUser(userId) {
  const status = userStatuses.get(userId);

  if (status?.appState === 'active' && status?.isOnline) {
    return false;
  }

  const lastNotificationAt = lastPushNotificationByUserId.get(userId) || 0;
  return Date.now() - lastNotificationAt >= MESSAGE_NOTIFICATION_COOLDOWN_MS;
}

function rowToMessage(row) {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    sender: row.sender,
    readBy: row.read_by || [],
    location: row.location,
    attachment: row.attachment,
  };
}

async function initDatabase() {
  if (!dbPool) {
    console.log('DATABASE_URL yok; mesajlar RAM uzerinde gecici tutulacak.');
    return;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      sender JSONB NOT NULL,
      read_by JSONB NOT NULL DEFAULT '[]'::jsonb,
      location JSONB,
      attachment JSONB
    )
  `);

  await dbPool.query('ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment JSONB');

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      face_scan_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await dbPool.query(
    'SELECT id, text, created_at, sender, read_by, location, attachment FROM chat_messages ORDER BY created_at ASC',
  );
  messages.splice(0, messages.length, ...result.rows.map(rowToMessage));

  const settingsResult = await dbPool.query(
    'SELECT user_id, face_scan_enabled FROM user_settings',
  );
  for (const row of settingsResult.rows) {
    userSettings.set(row.user_id, {
      faceScanEnabled: row.face_scan_enabled,
    });
  }

  console.log(`Postgres hazir; ${messages.length} mesaj ve ${userSettings.size} ayar yuklendi.`);
}

async function saveMessage(message) {
  if (!dbPool) {
    return;
  }

  await dbPool.query(
    `
      INSERT INTO chat_messages (id, text, created_at, sender, read_by, location, attachment)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
    `,
    [
      message.id,
      message.text,
      message.createdAt,
      JSON.stringify(message.sender),
      JSON.stringify(message.readBy || []),
      message.location ? JSON.stringify(message.location) : null,
      message.attachment ? JSON.stringify(message.attachment) : null,
    ],
  );
}

async function updateMessageReadBy(message) {
  if (!dbPool) {
    return;
  }

  await dbPool.query(
    'UPDATE chat_messages SET read_by = $2::jsonb WHERE id = $1',
    [message.id, JSON.stringify(message.readBy || [])],
  );
}

function getUserSettings(userId) {
  return {
    faceScanEnabled: userSettings.get(userId)?.faceScanEnabled ?? true,
  };
}

async function saveUserSettings(userId, settings) {
  const nextSettings = {
    faceScanEnabled: Boolean(settings.faceScanEnabled),
  };

  userSettings.set(userId, nextSettings);

  if (!dbPool) {
    return nextSettings;
  }

  await dbPool.query(
    `
      INSERT INTO user_settings (user_id, face_scan_enabled, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        face_scan_enabled = EXCLUDED.face_scan_enabled,
        updated_at = NOW()
    `,
    [userId, nextSettings.faceScanEnabled],
  );

  return nextSettings;
}


app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="tr">
      <head>
        <meta charset="utf-8" />
        <title>Study Chat API</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
          code { background: #eef2f7; padding: 3px 6px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <h1>Study Chat API calisiyor</h1>
        <p>Mobil/web uygulama adresi: <a href="http://localhost:8082">http://localhost:8082</a></p>
        <p>Backend saglik kontrolu: <code>GET /health</code></p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/auth/login', (req, res) => {
  const { username, password, role } = req.body;
  const user = users.find(
    (candidate) =>
      candidate.username === username &&
      candidate.password === password &&
      candidate.role === role,
  );

  if (!user) {
    return res.status(401).json({ message: 'Kullanici adi veya sifre hatali.' });
  }

  const token = crypto.randomUUID();
  sessions.set(token, user.id);

  res.json({
    token,
    user: publicUser(user),
  });
});

app.get('/messages', requireAuth, (req, res) => {
  res.json({ messages });
});

app.get('/user-settings', requireAuth, (req, res) => {
  res.json({
    settings: getUserSettings(req.user.id),
  });
});

app.post('/user-settings', requireAuth, async (req, res) => {
  try {
    const settings = await saveUserSettings(req.user.id, {
      faceScanEnabled: req.body?.faceScanEnabled,
    });

    res.json({ ok: true, settings });
  } catch (error) {
    res.status(500).json({ message: 'Ayar kaydedilemedi.' });
  }
});

app.post('/push-token', requireAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();

  if (!isValidExpoPushToken(token)) {
    return res.status(400).json({ message: 'Gecersiz push token.' });
  }

  if (!pushTokensByUserId.has(req.user.id)) {
    pushTokensByUserId.set(req.user.id, new Set());
  }

  pushTokensByUserId.get(req.user.id).add(token);
  res.json({ ok: true });
});

app.post('/attachments', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Fotoğraf yuklenemedi.' });
  }

  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  scheduleAttachmentDeletion(req.file.filename);

  res.json({
    attachment: {
      expiresAt,
      filename: req.file.filename,
      mimeType: req.file.mimetype,
      originalName: req.file.originalname,
      type: 'image',
      url: `${getPublicBaseUrl(req)}/uploads/${req.file.filename}`,
    },
  });
});

app.get('/locations', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Sadece admin gorebilir.' });
  }

  res.json({
    locations: Array.from(liveLocations.values()),
  });
});

app.get('/user-statuses', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Sadece admin gorebilir.' });
  }

  res.json({
    statuses: Array.from(userStatuses.values()),
  });
});

app.post('/user-status', requireAuth, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ message: 'Sadece normal kullanici durum gonderebilir.' });
  }

  const appState = req.body?.appState === 'active' ? 'active' : 'background';
  const status = {
    user: publicUser(req.user),
    appState,
    label: appState === 'active' ? 'Uygulamada aktif' : 'Uygulama arka planda',
    isOnline: true,
    lastSeenAt: new Date().toISOString(),
    note:
      appState === 'active'
        ? 'Berivan su an uygulama ekraninda.'
        : 'Berivan uygulamadan ayrildi veya baska uygulamaya gecti.',
  };

  userStatuses.set(req.user.id, status);
  io.to('admins').emit('user-status-updated', status);

  res.json({ ok: true, status });
});

app.post('/location', requireAuth, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ message: 'Sadece normal kullanici konum gonderebilir.' });
  }

  const location = getValidLocation(req.body);

  if (!location) {
    return res.status(400).json({ message: 'Gecersiz konum.' });
  }

  const payload = {
    ...location,
    user: publicUser(req.user),
  };

  liveLocations.set(req.user.id, payload);
  io.to('admins').emit('location-updated', payload);

  res.json({ ok: true, location: payload });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = findUserByToken(token);

  if (!user) {
    return next(new Error('unauthorized'));
  }

  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.join('study-chat');
  if (socket.user.role === 'admin') {
    socket.join('admins');
    socket.emit('user-statuses', Array.from(userStatuses.values()));
  }

  if (socket.user.role === 'user') {
    const status = {
      user: publicUser(socket.user),
      appState: 'active',
      label: 'Uygulamada aktif',
      isOnline: true,
      lastSeenAt: new Date().toISOString(),
      note: 'Berivan su an uygulama ekraninda.',
    };

    userStatuses.set(socket.user.id, status);
    io.to('admins').emit('user-status-updated', status);
  }

  socket.emit('chat-history', messages);

  socket.on('disconnect', () => {
    if (socket.user.role !== 'user') {
      return;
    }

    const currentStatus = userStatuses.get(socket.user.id) || {};
    const status = {
      ...currentStatus,
      user: publicUser(socket.user),
      appState: 'background',
      label: 'Baglanti kesildi',
      isOnline: false,
      lastSeenAt: new Date().toISOString(),
      note: 'Uygulama kapandi, arka planda kaldı veya internet baglantisi kesildi.',
    };

    userStatuses.set(socket.user.id, status);
    io.to('admins').emit('user-status-updated', status);
  });

  socket.on('send-message', async (payload, ack) => {
    const text = String(payload?.text || '').trim();
    const location = getValidLocation(payload?.location);
    const attachment = payload?.attachment?.type === 'image' && payload.attachment.url
      ? {
          expiresAt: String(payload.attachment.expiresAt || ''),
          mimeType: String(payload.attachment.mimeType || 'image/jpeg'),
          type: 'image',
          url: String(payload.attachment.url),
        }
      : null;

    if (!text && !attachment) {
      ack?.({ ok: false, message: 'Mesaj bos olamaz.' });
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      text: text ? text.slice(0, 1000) : 'Fotoğraf',
      createdAt: new Date().toISOString(),
      sender: publicUser(socket.user),
      readBy: [socket.user.id],
      location: socket.user.role === 'user' && location ? location : null,
      attachment,
    };

    try {
      await saveMessage(message);
      messages.push(message);
      io.to('study-chat').emit('message', message);

      const recipients = users.filter((user) => user.id !== socket.user.id);
      for (const recipient of recipients) {
        if (!shouldNotifyUser(recipient.id)) {
          continue;
        }

        lastPushNotificationByUserId.set(recipient.id, Date.now());
        sendExpoPushNotifications(getPushTokensForUser(recipient.id), message);
      }

      ack?.({ ok: true });
    } catch (error) {
      ack?.({ ok: false, message: 'Mesaj kaydedilemedi.' });
    }
  });

  socket.on('typing', (payload) => {
    socket.to('study-chat').emit('typing', {
      user: publicUser(socket.user),
      isTyping: Boolean(payload?.isTyping),
    });
  });

  socket.on('mark-read', async (payload) => {
    const messageIds = Array.isArray(payload?.messageIds) ? payload.messageIds : [];
    const updatedIds = [];
    const updatedMessages = [];

    for (const message of messages) {
      message.readBy = message.readBy || [];

      if (
        messageIds.includes(message.id) &&
        message.sender.id !== socket.user.id &&
        !message.readBy.includes(socket.user.id)
      ) {
        message.readBy.push(socket.user.id);
        updatedIds.push(message.id);
        updatedMessages.push(message);
      }
    }

    if (updatedIds.length > 0) {
      try {
        await Promise.all(updatedMessages.map(updateMessageReadBy));
      } catch (error) {
        // Okundu bilgisi yazilamazsa canli chat akisini bozma.
      }

      io.to('study-chat').emit('messages-read', {
        messageIds: updatedIds,
        readerId: socket.user.id,
      });
    }
  });
});

initDatabase()
  .then(() => {
    cleanupExpiredUploads();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database baslatilamadi:', error);
    process.exit(1);
  });
