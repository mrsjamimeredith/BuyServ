const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const scraper = require('../src/scraper');

function startServer(html) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('scrapes og:title/og:image/og:description', async () => {
  const server = await startServer(`<!doctype html>
    <html><head>
      <meta property="og:title" content="Cozy Linen Throw">
      <meta property="og:image" content="https://cdn.example.com/throw.jpg">
      <meta property="og:description" content="A soft linen throw blanket.">
    </head><body>hi</body></html>`);
  const { port } = server.address();
  const data = await scraper.scrape(`http://127.0.0.1:${port}/product`);
  server.close();
  assert.strictEqual(data.title, 'Cozy Linen Throw');
  assert.strictEqual(data.image_url, 'https://cdn.example.com/throw.jpg');
  assert.strictEqual(data.description, 'A soft linen throw blanket.');
});

test('falls back to <title> when og:title missing', async () => {
  const server = await startServer(`<html><head><title>Fallback Title</title></head><body></body></html>`);
  const { port } = server.address();
  const data = await scraper.scrape(`http://127.0.0.1:${port}/`);
  server.close();
  assert.strictEqual(data.title, 'Fallback Title');
});

test('resolves relative og:image against page URL', async () => {
  const server = await startServer(`<html><head>
    <meta property="og:image" content="/img/x.jpg">
    <title>X</title>
  </head></html>`);
  const { port } = server.address();
  const data = await scraper.scrape(`http://127.0.0.1:${port}/some/path`);
  server.close();
  assert.strictEqual(data.image_url, `http://127.0.0.1:${port}/img/x.jpg`);
});

test('decodes HTML entities', async () => {
  const server = await startServer(`<html><head>
    <meta property="og:title" content="Tom &amp; Jerry&#39;s">
  </head></html>`);
  const { port } = server.address();
  const data = await scraper.scrape(`http://127.0.0.1:${port}/`);
  server.close();
  assert.strictEqual(data.title, "Tom & Jerry's");
});
