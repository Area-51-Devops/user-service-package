'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule;

const { logger } = require('@area-51-devops/shared');
const { errorMiddleware, createError } = require('../shared/errorMiddleware');
const { requestIdMiddleware } = require('../shared/requestId');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRE = process.env.JWT_EXPIRE || '8h';
const SALT_ROUNDS = 10;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set');
}

let pool;
let redisClient;
let isStarted = false;   // used by /health/startup....


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Exponential backoff connector
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function connectWithRetry(connectFn, name, maxRetries = 10) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await connectFn();
      logger.info({ service: 'user-service' }, `${name} connected`);
      return result;
    } catch (error_) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      logger.warn({ service: 'user-service', attempt, delay, error: error_.message }, `${name} not ready, retrying in ${delay}ms`);
      if (attempt === maxRetries) throw new Error(`${name} failed after ${maxRetries} retries`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function init() {
  // MySQL pool
  pool = await connectWithRetry(async () => {
    const p = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    // Verify connectivity
    const [rows] = await p.execute('SELECT 1');
    if (!rows) throw new Error('DB ping failed');
    return p;
  }, 'MySQL');

  // Redis
  redisClient = await connectWithRetry(async () => {
    const client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
      lazyConnect: true
    });
    await client.connect();
    await client.ping();
    return client;
  }, 'Redis');

  isStarted = true;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Express App
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const app = express();

// Disable X-Powered-By header to prevent disclosing framework version (S5689)
app.disable('x-powered-by');

// Configure CORS: restrict to allowed origins
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
    // Allow requests with no origin (mobile, curl, postman, etc)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy: origin not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(requestIdMiddleware);

// â”€â”€ Health Probes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/health/startup', (req, res) => {
  res.json({ status: isStarted ? 'UP' : 'STARTING', service: 'user-service' });
});

app.get('/health/liveness', async (req, res, next) => {
  try {
    await pool.execute('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'UP', service: 'user-service' });
  } catch (error_) {
    next(createError(503, 'HEALTH_CHECK_FAILED', 'Liveness check failed'));
  }
});

app.get('/health/readiness', async (req, res, next) => {
  try {
    if (!isStarted) throw new Error('Not ready');
    await pool.execute('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'READY', service: 'user-service' });
  } catch (error_) {
    next(createError(503, 'NOT_READY', 'Service not ready'));
  }
});

// Legacy health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'user-service' });
});

// Configure static axios client for internal calls
const internalClient = axios.create({ timeout: 5000 });
axiosRetry(internalClient, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// â”€â”€ Register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/users/register', async (req, res, next) => {
  const log = logger.child({ requestId: req.requestId, endpoint: 'register' });
  let userId;
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return next(createError(400, 'VALIDATION_ERROR', 'username, email and password are required'));
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );
    userId = result.insertId;

    // ADMIN users do not need a bank account
    const [userRows] = await pool.execute('SELECT role FROM users WHERE id = ?', [userId]);
    if (userRows.length > 0 && userRows[0].role !== 'ADMIN') {
      try {
          const accountServiceUrl = process.env.ACCOUNT_SVC_URL;
          if (!accountServiceUrl) throw new Error('ACCOUNT_SVC_URL environment variable must be set');
        await internalClient.post(`${accountServiceUrl}/accounts`, { userId, accountType: 'SAVINGS' });
      } catch (error_) {
        log.error({ err: error_.message, userId }, 'Failed to create initial account, rolling back user registration');
        await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
        return next(createError(500, 'ACCOUNT_CREATION_FAILED', 'Failed to properly set up user account. Please try again later.'));
      }
    }

    log.info({ userId }, 'User registered and account created');
    res.status(201).json({ success: true, userId, username });
  } catch (error_) {
    if (error_.code === 'ER_DUP_ENTRY') {
      return next(createError(409, 'USER_EXISTS', 'Username already exists'));
    }
    next(error_);
  }
});

// â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/users/login', async (req, res, next) => {
  const log = logger.child({ requestId: req.requestId, endpoint: 'login' });
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return next(createError(400, 'VALIDATION_ERROR', 'username and password are required'));
    }

    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      return next(createError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return next(createError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRE }
    );

    // Cache session in Redis
    await redisClient.setex(`session:${user.id}`, 8 * 3600, token);

    log.info({ userId: user.id }, 'User logged in');
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (error_) {
    next(error_);
  }
});

// â”€â”€ Get User â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/users/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, email, role, created_at FROM users WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) {
      return next(createError(404, 'USER_NOT_FOUND', 'User not found'));
    }
    res.json({ success: true, user: rows[0] });
  } catch (error_) {
    next(error_);
  }
});

// â”€â”€ Verify Token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/users/verify-token', (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return next(createError(400, 'MISSING_TOKEN', 'Token is required'));
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, decoded });
  } catch (error_) {
    next(createError(401, 'INVALID_TOKEN', 'Token is invalid or expired'));
  }
});

// â”€â”€ Global Error Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(errorMiddleware);

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = app.listen(PORT, () => logger.info({ port: PORT }, 'user-service listening'));

async function shutdown(signal) {
  logger.info({ signal }, 'Graceful shutdown initiated');
  server.close(async () => {
    try {
      if (pool !== undefined && pool) await pool.end();
      if (redisClient !== undefined && redisClient) await redisClient.quit();
    } catch (error_) {
      logger.error({ err: error_.message }, 'Error during graceful shutdown connections close');
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Force shutdown timeout');
    process.exit(1);
  }, 15000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => { // NOSONAR
  try {
    await init();
  } catch (err) {
    logger.fatal({ err }, 'user-service failed to initialise');
    process.exit(1);
  }
})();

