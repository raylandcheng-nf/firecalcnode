const dotenv = require("dotenv");

const dotenvResult = dotenv.config();
if (
  process.env.SECRET_KEY !== undefined
  && String(process.env.SECRET_KEY).trim() === ""
  && dotenvResult.parsed
  && dotenvResult.parsed.SECRET_KEY
) {
  process.env.SECRET_KEY = dotenvResult.parsed.SECRET_KEY;
}

const { createApp } = require("./app");

async function main() {
  const host = process.env.HOST || "0.0.0.0";
  const port = parseInt(process.env.PORT || "8080", 10);

  const app = await createApp();
  const server = app.listen(port, host, () => {
    console.log(`Server listening on http://${host}:${port}`);
  });

  function shutdown() {
    if (app.locals._closeRateLimiter) {
      app.locals._closeRateLimiter();
    }
    if (app.locals._closeSessionStore) {
      app.locals._closeSessionStore();
    }
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
