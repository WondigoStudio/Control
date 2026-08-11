const fetch = require('node-fetch');

// Несколько нод из разных регионов мира (полный список — https://check-host.net/about/api)
const DEFAULT_NODES = [
  'us1.node.check-host.net', // Los Angeles, USA
  'de4.node.check-host.net', // Frankfurt, Germany
  'hk1.node.check-host.net', // Hong Kong
  'br1.node.check-host.net', // Sao Paulo, Brazil
  'fr2.node.check-host.net', // Paris, France
  'sg1.node.check-host.net', // Singapore
];

const NODE_LABELS = {
  'us1.node.check-host.net': '🇺🇸 Лос-Анджелес, США',
  'de4.node.check-host.net': '🇩🇪 Франкфурт, Германия',
  'hk1.node.check-host.net': '🇭🇰 Гонконг',
  'br1.node.check-host.net': '🇧🇷 Сан-Паулу, Бразилия',
  'fr2.node.check-host.net': '🇫🇷 Париж, Франция',
  'sg1.node.check-host.net': '🇸🇬 Сингапур',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkMultiLocation(url) {
  const nodeParams = DEFAULT_NODES.map((n) => `node=${n}`).join('&');
  const checkUrl = `https://check-host.net/check-http?host=${encodeURIComponent(url)}&${nodeParams}`;

  const startRes = await fetch(checkUrl, { headers: { Accept: 'application/json' } });
  const startData = await startRes.json();

  if (!startData.ok || !startData.request_id) {
    throw new Error('Не удалось запустить проверку через check-host.net');
  }

  const requestId = startData.request_id;

  // Результаты появляются не мгновенно — опрашиваем несколько раз с паузой
  let results = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    const resultRes = await fetch(`https://check-host.net/check-result/${requestId}`, {
      headers: { Accept: 'application/json' },
    });
    const resultData = await resultRes.json();

    const allNodesResponded = Object.values(resultData).every((v) => v !== null);
    if (allNodesResponded) {
      results = resultData;
      break;
    }
    results = resultData; // сохраняем частичный результат на случай, если не все ноды успеют ответить
  }

  return DEFAULT_NODES.map((node) => {
    const nodeResult = results ? results[node] : null;
    const label = NODE_LABELS[node] || node;

    if (!nodeResult || !nodeResult[0]) {
      return { node, label, ok: null, responseMs: null, statusCode: null, error: 'Нет ответа от ноды проверки' };
    }

    const [ok, time, statusText, statusCode] = nodeResult[0];
    return {
      node,
      label,
      ok: ok === 1,
      responseMs: time ? Math.round(time * 1000) : null,
      statusCode: statusCode || null,
      error: ok === 1 ? null : (statusText || 'Ошибка проверки'),
    };
  });
}

module.exports = { checkMultiLocation };
