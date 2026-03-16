exports.handler = async (event) => {
  const { ticker, period1, period2 } = event.queryStringParameters || {};
  if (!ticker || !period1 || !period2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
  }

  const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}&includePrePost=false`;

  try {
    const res = await fetch(yfUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ETFChef/1.0)' }
    });
    if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
