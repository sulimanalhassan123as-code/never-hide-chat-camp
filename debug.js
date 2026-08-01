// Debug endpoint addition — append to index.js
app.get('/debug', async (req, res) => {
  const results = {
    node_version: process.version,
    fetch_available: typeof fetch !== 'undefined',
    bot_token: BOT_TOKEN ? 'SET (length: ' + BOT_TOKEN.length + ')' : 'NOT SET',
    groq_key: GROQ_API_KEY ? 'SET' : 'NOT SET',
    admin_chat_id: ADMIN_CHAT_ID,
    last_update_id: lastUpdateId,
    telegram_test: null,
    error: null
  };
  
  try {
    const tgRes = await fetch(`${TELEGRAM_API}/getMe`);
    const tgData = await tgRes.json();
    results.telegram_test = tgData.ok ? `OK - @${tgData.result.username}` : `FAIL - ${tgData.description}`;
  } catch (e) {
    results.telegram_test = `ERROR: ${e.message}`;
    results.error = e.stack;
  }
  
  res.json(results);
});
