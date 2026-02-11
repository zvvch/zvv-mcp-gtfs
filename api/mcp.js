const { createApp } = require('../server.js');

// Express-App als Vercel Serverless Function exportieren
const app = createApp();

module.exports = app;
