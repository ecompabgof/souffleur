'use strict';
const Anthropic = require('@anthropic-ai/sdk');

let client = null;
// Key comes from ANTHROPIC_API_KEY (loaded from .env by main/index.js).
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 30_000 });
  return client;
}

module.exports = { getClient, Anthropic };
