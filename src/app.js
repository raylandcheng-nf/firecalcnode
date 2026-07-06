const crypto = require("crypto");
const path = require("path");

const express = require("express");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const helmet = require("helmet");
const { createClient } = require("redis");

const { projectRetirement, deterministicProjectionRows } = require("./projections");
const { runMonteCarlo } = require("./monteCarlo");
const { validateFireInputs, validateMonteCarloParams } = require("./validation");

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function normalizeNumberText(raw) {
  return String(raw || "").trim().replace(/%/g, "").replace(/,/g, ".");
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

function createRateLimiter(config, logger) {
  const state = new Map();
  let redisClient = null;
  let redisHealthy = config.backend !== "redis";

  async function initRedis() {
    if (config.backend !== "redis") return;

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

  const maxContentLength = parseInt(process.env.MAX_CONTENT_LENGTH || "16384", 10);
  const rateLimitWindowSeconds = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || "60", 10);
  const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10);
  const rateLimitBackend = (process.env.RATE_LIMIT_BACKEND || "memory").trim().toLowerCase();
  const rateLimitRequireRedis = envBool("RATE_LIMIT_REQUIRE_REDIS", false);
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
  const sessionStoreBackend = (process.env.SESSION_STORE_BACKEND || (appEnv === "production" ? "redis" : "memory"))
    .trim()
    .toLowerCase();
  const sessionRequireRedis = envBool("SESSION_REQUIRE_REDIS", appEnv === "production");
  const sessionRedisUrl = process.env.SESSION_REDIS_URL || redisUrl;
  const sessionPrefix = process.env.SESSION_REDIS_PREFIX || "sess:";
  const trustForwardedFor = envBool("TRUST_X_FORWARDED_FOR", false);
  const sessionCookieSecure = envBool("SESSION_COOKIE_SECURE", appEnv === "production");
  const sessionCookieSameSite = process.env.SESSION_COOKIE_SAMESITE || "Lax";

  const app = express();

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  app.use(express.urlencoded({ extended: false, limit: `${maxContentLength}b` }));

  let sessionStore = null;
  let sessionRedisClient = null;
  let sessionHealthy = sessionStoreBackend !== "redis";

  if (sessionStoreBackend === "redis") {
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
      hsts: appEnv === "production",
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
    },
    console
  );

  await limiter.initRedis();

  function clientIp(req) {
    if (trustForwardedFor) {
      const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
      if (forwarded) return forwarded.split(",")[0].trim();
    }
    return req.ip || req.socket.remoteAddress || "unknown";
  }

  function getCsrfToken(req) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
    }
    return req.session.csrfToken;
  }

  app.use(async (req, res, next) => {
    if (["/healthz", "/readyz"].includes(req.path)) {
      return next();
    }

    const now = Date.now() / 1000;
    const ip = clientIp(req);
    const limited =
      rateLimitBackend === "redis"
        ? await limiter.isRateLimitedRedis(ip, now)
        : await limiter.isRateLimitedMemory(ip, now);

    if (limited) {
      return res.status(429).send("Too Many Requests");
    }

    if (req.method === "POST") {
      const formToken = String(req.body.csrf_token || "");
      const sessionToken = String(req.session.csrfToken || "");
      if (!formToken || !sessionToken) {
        return res.status(400).send("Bad Request");
      }

      const a = Buffer.from(formToken);
      const b = Buffer.from(sessionToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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
      rateLimiterStatus.backend === "redis"
        ? rateLimiterStatus.usingRedis && (await limiter.ping())
        : true;

    let sessionRedisHealthy = sessionStoreBackend !== "redis";
    if (sessionStoreBackend === "redis") {
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
        backend: sessionStore && sessionStoreBackend === "redis" ? "redis" : "memory",
        usingRedis: Boolean(sessionRedisClient),
        healthy: sessionStoreBackend === "redis" ? sessionRedisHealthy : true,
      },
    };

    let ready = true;
    let degraded = false;

    if (rateLimiterStatus.backend === "redis") {
      if (!rateLimiterStatus.usingRedis || !rateLimiterHealthy) {
        if (rateLimiterStatus.requireRedis) {
          ready = false;
        } else {
          degraded = true;
        }
      }
    }

    if (sessionStoreBackend === "redis") {
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
    const values = {
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

    res.render("index", {
      values,
      result: null,
      error: null,
      csrfToken: getCsrfToken(req),
      money,
      pct,
    });
  });

  app.post("/", (req, res) => {
    const defaults = {
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

    const values = {};
    Object.keys(defaults).forEach((key) => {
      values[key] = req.body[key] !== undefined ? req.body[key] : defaults[key];
    });

    let result = null;
    let error = null;

    try {
      const fireInputs = validateFireInputs({
        age: asInt(req.body, "age", defaults.age),
        annualSpend: asFloat(req.body, "spend", defaults.spend),
        currentInvestments: asFloat(req.body, "investments", defaults.investments),
        expectedReturnRate: asPercent(req.body, "return_rate", defaults.return_rate),
        inflationRate: asPercent(req.body, "inflation_rate", defaults.inflation_rate),
        annualIncome: asFloat(req.body, "income", defaults.income),
        withdrawalRate: asPercent(req.body, "withdrawal_rate", defaults.withdrawal_rate),
        maxAge: asInt(req.body, "max_age", defaults.max_age),
        incomeGrowthRate: asOptionalPercent(req.body, "income_growth_rate"),
      });

      const mcParams = validateMonteCarloParams({
        iterations: asInt(req.body, "iterations", defaults.iterations),
        returnStdDev: asPercent(req.body, "return_std_dev", defaults.return_std_dev),
        inflationStdDev: asPercent(req.body, "inflation_std_dev", defaults.inflation_std_dev),
        seed: String(req.body.seed || "").trim() ? asInt(req.body, "seed", 0) : null,
      });

      const projection = projectRetirement(fireInputs);
      const deterministicRows = deterministicProjectionRows(fireInputs);
      const monteCarlo = runMonteCarlo(fireInputs, mcParams, projection);

      result = {
        projection,
        deterministicRows,
        monteCarlo,
      };
    } catch (err) {
      if (err instanceof Error) {
        console.info("Validation error:", err.message);
      }
      error = "Invalid input. Please review your entries and try again.";
    }

    res.render("index", {
      values,
      result,
      error,
      csrfToken: getCsrfToken(req),
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
