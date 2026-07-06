const serverless = require("serverless-http");
const { createApp } = require("../../src/app");

let cachedHandlerPromise = null;

async function getHandler() {
  if (!cachedHandlerPromise) {
    cachedHandlerPromise = createApp().then((app) => serverless(app));
  }
  return cachedHandlerPromise;
}

exports.handler = async (event, context) => {
  const handler = await getHandler();
  return handler(event, context);
};
