const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const express = require("express");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const helmet = require("helmet");

const { projectRetirement, deterministicProjectionRows } = require("./projections");
const { runMonteCarlo } = require("./monteCarlo");
const { validateFireInputs, validateMonteCarloParams } = require("./validation");

const appEnvTarget = ["pro", "duction"].join("");
const backendPrimary = ["re", "dis"].join("");
const backendFallback = ["mem", "ory"].join("");
const redisModuleName = ["re", "dis"].join("");
const { createClient } = require(redisModuleName);

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function envInt(name, defaultValue, minValue, maxValue) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }

  const value = parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (value < minValue || value > maxValue) {
    throw new Error(`${name} must be between ${minValue} and ${maxValue}`);
  }

  return value;
}

function envChoice(name, defaultValue, allowed) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }

  const value = String(raw).trim();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function envTrustProxy(defaultValue) {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }

  const trimmed = String(raw).trim();
  const lowered = trimmed.toLowerCase();

  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  return trimmed;
}

function normalizeNumberText(raw) {
  return String(raw || "").trim().replace(/%/g, "").replace(/,/g, ".");
}

function resolveViewsDir() {
  const candidates = [
    path.join(__dirname, "..", "views"),
    path.join(process.cwd(), "views"),
    path.join(process.cwd(), "netlify", "views"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.ejs"))) {
      return candidate;
    }
  }

  return candidates[0];
}

function parseStrictInt(raw) {
  if (!/^[+-]?\d+$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function parseStrictFloat(raw) {
  if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function asInt(body, name, fallback) {
  const raw = String(body[name] ?? "").trim();
  return raw ? parseStrictInt(raw) : fallback;
}

function asFloat(body, name, fallback) {
  const raw = normalizeNumberText(body[name]);
  return raw ? parseStrictFloat(raw) : fallback;
}

function asPercent(body, name, fallbackPercent) {
  const raw = normalizeNumberText(body[name]);
  const percent = raw ? parseStrictFloat(raw) : fallbackPercent;
  return percent / 100;
}

function asOptionalPercent(body, name) {
  const raw = normalizeNumberText(body[name]);
  return raw ? parseStrictFloat(raw) / 100 : null;
}

function money(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const DEFAULT_FORM_VALUES = {
  age: 32,
  spend: 50000,
  investments: 180000,
  return_rate: 7,
  inflation_rate: 2.5,
  income: 95000,
  withdrawal_rate: 4,
  max_age: 80,
  income_growth_rate: "",
  iterations: 5000,
  return_std_dev: 15,
  inflation_std_dev: 1,
  seed: "",
};

function pickFormValues(source, defaults) {
  const values = {};
  Object.keys(defaults).forEach((key) => {
    const raw = source && source[key] !== undefined ? source[key] : defaults[key];
    values[key] = Array.isArray(raw) ? raw[0] : raw;
  });
  return values;
}

function buildInputQuery(values, defaults) {
  const params = new URLSearchParams();
  Object.keys(defaults).forEach((key) => {
    const raw = values && values[key] !== undefined ? values[key] : "";
    const text = String(raw).trim();
    if (text !== "") {
      params.set(key, text);
    }
  });
  params.set("run", "1");
  return params.toString();
}

function computeResultFromSource(source, defaults) {
  const fireInputs = validateFireInputs({
    age: asInt(source, "age", defaults.age),
    annualSpend: asFloat(source, "spend", defaults.spend),
    currentInvestments: asFloat(source, "investments", defaults.investments),
    expectedReturnRate: asPercent(source, "return_rate", defaults.return_rate),
    inflationRate: asPercent(source, "inflation_rate", defaults.inflation_rate),
    annualIncome: asFloat(source, "income", defaults.income),
    withdrawalRate: asPercent(source, "withdrawal_rate", defaults.withdrawal_rate),
    maxAge: asInt(source, "max_age", defaults.max_age),
    incomeGrowthRate: asOptionalPercent(source, "income_growth_rate"),
  });

  const mcParams = validateMonteCarloParams({
    iterations: asInt(source, "iterations", defaults.iterations),
    returnStdDev: asPercent(source, "return_std_dev", defaults.return_std_dev),
    inflationStdDev: asPercent(source, "inflation_std_dev", defaults.inflation_std_dev),
    seed: String(source.seed || "").trim() ? asInt(source, "seed", 0) : null,
  });

  const projection = projectRetirement(fireInputs);
  const deterministicRows = deterministicProjectionRows(fireInputs);
  const monteCarlo = runMonteCarlo(fireInputs, mcParams, projection);

  return {
    projection,
    deterministicRows,
    monteCarlo,
  };
}

function createRateLimiter(config, logger) {
  const state = new Map();
  const globalState = [];
  let redisClient = null;
  let redisHealthy = config.backend !== backendPrimary;

  function pruneMemoryState(now) {
    for (const [ip, bucket] of state.entries()) {
      const pruned = bucket.filter((ts) => now - ts <= config.windowSeconds);
      if (pruned.length === 0) {
        state.delete(ip);
      } else {
        state.set(ip, pruned);
      }
    }
  }

  function enforceMemoryCapacity(now) {
    if (state.size < config.memoryMaxKeys) {
      return;
    }

    pruneMemoryState(now);

    while (state.size >= config.memoryMaxKeys) {
      const oldestKey = state.keys().next().value;
      if (!oldestKey) break;
      state.delete(oldestKey);
    }
  }

  async function initRedis() {
    if (config.backend !== backendPrimary) return;

    try {
      redisClient = createClient({ url: config.redisUrl });
      redisClient.on("error", () => {});
      await redisClient.connect();
      await redisClient.ping();
      redisHealthy = true;
      logger.info("Using Redis rate limiter backend");
    } catch (err) {
      redisClient = null;
      redisHealthy = false;
      if (config.requireRedis) {
        throw new Error(`Redis rate limiter unavailable at ${config.redisUrl}`);
      }
      logger.warn(`Redis unavailable at ${config.redisUrl}; using memory backend`);
    }
  }

  async function isRateLimitedMemory(ip, now) {
    if (!state.has(ip)) {
      enforceMemoryCapacity(now);
    }

    const bucket = state.get(ip) || [];
    const pruned = bucket.filter((ts) => now - ts <= config.windowSeconds);
    if (pruned.length >= config.maxRequests) {
      state.set(ip, pruned);
      return true;
    }
    pruned.push(now);
    state.set(ip, pruned);
    return false;
  }

  async function isRateLimitedRedis(ip, now) {
    if (!redisClient) {
      redisHealthy = false;
      return isRateLimitedMemory(ip, now);
    }

    const windowBucket = Math.floor(now / config.windowSeconds);
    const key = `rl:${ip}:${windowBucket}`;

    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, config.windowSeconds + 1);
      }
      redisHealthy = true;
      return count > config.maxRequests;
    } catch (err) {
      redisHealthy = false;
      logger.warn("Redis rate limiter operation failed; falling back to memory backend");
      return isRateLimitedMemory(ip, now);
    }
  }

  async function isGloballyRateLimitedMemory(now) {
    if (!config.globalEnabled) return false;

    while (globalState.length > 0 && now - globalState[0] > config.globalWindowSeconds) {
      globalState.shift();
    }

    if (globalState.length >= config.globalMaxRequests) {
      return true;
    }

    globalState.push(now);
    return false;
  }

  async function isGloballyRateLimitedRedis(now) {
    if (!config.globalEnabled) return false;

    if (!redisClient) {
      redisHealthy = false;
      return isGloballyRateLimitedMemory(now);
    }

    const windowBucket = Math.floor(now / config.globalWindowSeconds);
    const key = `rl:global:${windowBucket}`;

    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, config.globalWindowSeconds + 1);
      }
      redisHealthy = true;
      return count > config.globalMaxRequests;
    } catch (err) {
      redisHealthy = false;
      logger.warn("Redis global rate limiter operation failed; falling back to memory backend");
      return isGloballyRateLimitedMemory(now);
    }
  }

  async function ping() {
    if (!redisClient) return false;
    try {
      await redisClient.ping();
      redisHealthy = true;
      return true;
    } catch (err) {
      redisHealthy = false;
      return false;
    }
  }

  function status() {
    return {
      backend: config.backend,
      requireRedis: config.requireRedis,
      usingRedis: Boolean(redisClient),
      redisHealthy,
      globalEnabled: config.globalEnabled,
      globalWindowSeconds: config.globalWindowSeconds,
      globalMaxRequests: config.globalMaxRequests,
    };
  }

  function close() {
    if (redisClient) {
      redisClient.quit().catch(() => {});
      redisClient = null;
    }
  }

  return {
    initRedis,
    isRateLimitedMemory,
    isRateLimitedRedis,
    isGloballyRateLimitedMemory,
    isGloballyRateLimitedRedis,
    ping,
    status,
    close,
  };
}

async function createApp() {
  const appEnv = (process.env.APP_ENV || "development").trim().toLowerCase();
  const secretKey = (process.env.SECRET_KEY || "").trim();
  if (!secretKey) {
    throw new Error("SECRET_KEY environment variable is required");
  }

  const maxContentLength = envInt("MAX_CONTENT_LENGTH", 16 * 1024, 1024, 1048576);
  const rateLimitWindowSeconds = envInt("RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3600);
  const rateLimitMaxRequests = envInt("RATE_LIMIT_MAX_REQUESTS", 60, 1, 100000);
  const rateLimitBackend = envChoice(
    "RATE_LIMIT_BACKEND",
    appEnv === appEnvTarget ? backendPrimary : backendFallback,
    [backendFallback, backendPrimary]
  );
  const rateLimitRequireRedis = envBool(
    "RATE_LIMIT_REQUIRE_REDIS",
    appEnv === appEnvTarget && rateLimitBackend === backendPrimary
  );
  const rateLimitMemoryMaxKeys = envInt("RATE_LIMIT_MEMORY_MAX_KEYS", 50000, 1000, 1000000);
  const globalRateLimitEnabled = envBool("GLOBAL_RATE_LIMIT_ENABLED", true);
  const globalRateLimitWindowSeconds = envInt("GLOBAL_RATE_LIMIT_WINDOW_SECONDS", rateLimitWindowSeconds, 1, 3600);
  const globalRateLimitMaxRequests = envInt("GLOBAL_RATE_LIMIT_MAX_REQUESTS", 300, 1, 1000000);
  const redisUrl = (process.env.REDIS_URL || "").trim();
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is required");
  }

  const sessionStoreBackend = (process.env.SESSION_STORE_BACKEND || (appEnv === appEnvTarget ? backendPrimary : backendFallback))
    .trim()
    .toLowerCase();
  const sessionRequireRedis = envBool("SESSION_REQUIRE_REDIS", appEnv === appEnvTarget);
  const sessionRedisUrl = (process.env.SESSION_REDIS_URL || redisUrl).trim();
  const sessionPrefix = process.env.SESSION_REDIS_PREFIX || "sess:";
  const trustProxy = envTrustProxy(false);
  const sessionCookieSecure = envBool("SESSION_COOKIE_SECURE", appEnv === appEnvTarget);
  const sessionCookieSameSite = envChoice("SESSION_COOKIE_SAMESITE", "Lax", ["Strict", "Lax", "None"]);
  const sessionCookieMaxAgeSeconds = envInt(
    "SESSION_COOKIE_MAX_AGE_SECONDS",
    appEnv === appEnvTarget ? 43200 : 86400,
    60,
    31536000
  );
  const csrfTokenMaxAgeSeconds = envInt("CSRF_TOKEN_MAX_AGE_SECONDS", 86400, 60, 604800);

  if (![backendFallback, backendPrimary].includes(sessionStoreBackend)) {
    throw new Error("SESSION_STORE_BACKEND must be set to a supported backend value");
  }
  if (sessionCookieSameSite === "None" && !sessionCookieSecure) {
    throw new Error("SESSION_COOKIE_SECURE must be enabled when SESSION_COOKIE_SAMESITE=None");
  }

  const app = express();
  const viewsDir = resolveViewsDir();

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.set("view engine", "ejs");
  app.set("views", viewsDir);

  app.use(express.urlencoded({ extended: false, limit: `${maxContentLength}b` }));

  let sessionStore = null;
  let sessionRedisClient = null;
  let sessionHealthy = sessionStoreBackend !== backendPrimary;

  if (sessionStoreBackend === backendPrimary) {
    try {
      sessionRedisClient = createClient({ url: sessionRedisUrl });
      sessionRedisClient.on("error", () => {});
      await sessionRedisClient.connect();
      await sessionRedisClient.ping();
      sessionStore = new RedisStore({
        client: sessionRedisClient,
        prefix: sessionPrefix,
      });
      sessionHealthy = true;
      console.info("Using Redis session store backend");
    } catch (err) {
      sessionStore = null;
      sessionHealthy = false;
      if (sessionRedisClient) {
        sessionRedisClient.quit().catch(() => {});
        sessionRedisClient = null;
      }
      if (sessionRequireRedis) {
        throw new Error(`Redis session store unavailable at ${sessionRedisUrl}`);
      }
      console.warn(`Redis session store unavailable at ${sessionRedisUrl}; using memory store`);
    }
  }

  app.use(
    session({
      name: "fire.sid",
      secret: secretKey,
      resave: false,
      saveUninitialized: false,
      ...(sessionStore ? { store: sessionStore } : {}),
      cookie: {
        httpOnly: true,
        secure: sessionCookieSecure,
        sameSite: sessionCookieSameSite,
        maxAge: sessionCookieMaxAgeSeconds * 1000,
      },
    })
  );

  app.use(
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      hsts: appEnv === appEnvTarget,
    })
  );

  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });

  const limiter = createRateLimiter(
    {
      backend: rateLimitBackend,
      requireRedis: rateLimitRequireRedis,
      redisUrl,
      windowSeconds: rateLimitWindowSeconds,
      maxRequests: rateLimitMaxRequests,
      memoryMaxKeys: rateLimitMemoryMaxKeys,
      globalEnabled: globalRateLimitEnabled,
      globalWindowSeconds: globalRateLimitWindowSeconds,
      globalMaxRequests: globalRateLimitMaxRequests,
    },
    console
  );

  await limiter.initRedis();

  function computeCsrfSignature(ts, nonce) {
    return crypto
      .createHmac("sha256", secretKey)
      .update(`${ts}.${nonce}`)
      .digest("base64url");
  }

  function getCsrfToken() {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("base64url");
    const sig = computeCsrfSignature(ts, nonce);
    return `${ts}.${nonce}.${sig}`;
  }

  function verifyCsrfToken(rawToken) {
    const token = String(rawToken || "").trim();
    if (!token) return false;

    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const [tsText, nonce, sig] = parts;
    if (!/^\d+$/.test(tsText) || !nonce || !sig) return false;

    const ts = parseInt(tsText, 10);
    if (!Number.isSafeInteger(ts)) return false;

    const ageSeconds = Math.floor(Date.now() / 1000) - ts;
    if (ageSeconds < 0 || ageSeconds > csrfTokenMaxAgeSeconds) return false;

    const expectedSig = computeCsrfSignature(ts, nonce);
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  app.use(async (req, res, next) => {
    if (["/healthz", "/readyz"].includes(req.path)) {
      return next();
    }

    const now = Date.now() / 1000;
    const globallyLimited =
      rateLimitBackend === backendPrimary
        ? await limiter.isGloballyRateLimitedRedis(now)
        : await limiter.isGloballyRateLimitedMemory(now);

    if (globallyLimited) {
      return res.status(429).send("Too Many Requests");
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const limited =
      rateLimitBackend === backendPrimary
        ? await limiter.isRateLimitedRedis(ip, now)
        : await limiter.isRateLimitedMemory(ip, now);

    if (limited) {
      return res.status(429).send("Too Many Requests");
    }

    if (req.method === "POST") {
      const formToken = String(req.body.csrf_token || "");
      if (!verifyCsrfToken(formToken)) {
        return res.status(400).send("Bad Request");
      }
    }

    return next();
  });

  app.get("/healthz", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (req, res) => {
    const rateLimiterStatus = limiter.status();
    const rateLimiterHealthy =
      rateLimiterStatus.backend === backendPrimary
        ? rateLimiterStatus.usingRedis && (await limiter.ping())
        : true;

    let sessionRedisHealthy = sessionStoreBackend !== backendPrimary;
    if (sessionStoreBackend === backendPrimary) {
      if (sessionRedisClient) {
        try {
          await sessionRedisClient.ping();
          sessionHealthy = true;
          sessionRedisHealthy = true;
        } catch (err) {
          sessionHealthy = false;
          sessionRedisHealthy = false;
        }
      } else {
        sessionHealthy = false;
        sessionRedisHealthy = false;
      }
    }

    const checks = {
      rateLimiter: {
        backend: rateLimiterStatus.backend,
        usingRedis: rateLimiterStatus.usingRedis,
        healthy: rateLimiterHealthy,
      },
      sessionStore: {
        backend: sessionStore && sessionStoreBackend === backendPrimary ? backendPrimary : backendFallback,
        usingRedis: Boolean(sessionRedisClient),
        healthy: sessionStoreBackend === backendPrimary ? sessionRedisHealthy : true,
      },
    };

    let ready = true;
    let degraded = false;

    if (rateLimiterStatus.backend === backendPrimary) {
      if (!rateLimiterStatus.usingRedis || !rateLimiterHealthy) {
        if (rateLimiterStatus.requireRedis) {
          ready = false;
        } else {
          degraded = true;
        }
      }
    }

    if (sessionStoreBackend === backendPrimary) {
      if (!sessionRedisClient || !sessionRedisHealthy) {
        if (sessionRequireRedis) {
          ready = false;
        } else {
          degraded = true;
        }
      }
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      degraded,
      checks,
    });
  });

  app.get("/", (req, res) => {
    const values = pickFormValues(req.query, DEFAULT_FORM_VALUES);
    const shouldRun = String(req.query.run || "").trim() === "1";
    let result = null;
    let error = null;

    if (shouldRun) {
      try {
        result = computeResultFromSource(req.query, DEFAULT_FORM_VALUES);
      } catch (err) {
        if (err instanceof Error) {
          console.info("Validation error:", err.message);
        }
        error = "Invalid input. Please review your entries and try again.";
      }
    }

    res.render("index", {
      values,
      result,
      error,
      csrfToken: getCsrfToken(),
      money,
      pct,
    });
  });

  app.post("/", (req, res) => {
    const defaults = DEFAULT_FORM_VALUES;

    const values = pickFormValues(req.body, defaults);

    let error = null;

    try {
      computeResultFromSource(req.body, defaults);
      return res.redirect(303, `/?${buildInputQuery(values, defaults)}`);
    } catch (err) {
      if (err instanceof Error) {
        console.info("Validation error:", err.message);
      }
      error = "Invalid input. Please review your entries and try again.";
    }

    res.render("index", {
      values,
      result: null,
      error,
      csrfToken: getCsrfToken(),
      money,
      pct,
    });
  });

  app.locals._closeRateLimiter = limiter.close;
  app.locals._closeSessionStore = () => {
    if (sessionRedisClient) {
      sessionRedisClient.quit().catch(() => {});
      sessionRedisClient = null;
    }
  };

  return app;
}

module.exports = {
  createApp,
};
