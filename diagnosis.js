// Распознавание типовых страниц "аккаунт приостановлен" — актуально для
// бесплатных хостингов (InfinityFree и подобных), которые вместо ошибки
// показывают HTTP 200 с генерической страницей-заглушкой. Без этой проверки
// такие падения выглядели бы как "сайт работает".
const SUSPENSION_SIGNATURES = [
  'account has been suspended',
  'this account has been suspended',
  'account suspended',
  'website has been suspended',
  'hosting account is disabled',
  'domain has expired',
  'this domain has expired',
  'suspected malicious activity',
  'account associated with this website has been suspended',
];

function detectSuspensionSignature(bodyText) {
  if (!bodyText) return null;
  const lower = bodyText.toLowerCase();
  for (const phrase of SUSPENSION_SIGNATURES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

// Переводит сырую ошибку/статус-код в ОДНУ итоговую машиночитаемую категорию
// причины падения (для программной обработки — например, в Incident lifecycle
// на будущих этапах) + человеко-понятное объяснение и рекомендацию на русском.
//
// Категории (единый список, не расширять точечными случаями — только
// через явное добавление сюда):
const CATEGORY = {
  DNS_PROBLEM: 'DNS_PROBLEM',
  SSL_PROBLEM: 'SSL_PROBLEM',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  TIMEOUT: 'TIMEOUT',
  HTTP_ERROR: 'HTTP_ERROR',
  CONTENT_MISMATCH: 'CONTENT_MISMATCH',
  HOSTING_PROBLEM: 'HOSTING_PROBLEM',
  SUSPENDED: 'SUSPENDED',
  NETWORK_PROBLEM: 'NETWORK_PROBLEM',
  UNKNOWN: 'UNKNOWN',
};

// Название хостинга для персонализации рекомендаций в suggestion.
// Поддерживаемые значения (задаются в monitors.json как "hosting"):
// "render" | "infinityfree" | "vps" | "hidden_cloud" | "other" (по умолчанию)
const HOSTING_LABELS = {
  render: 'Render',
  infinityfree: 'InfinityFree',
  vps: 'VPS',
  hidden_cloud: 'Hidden Cloud',
  other: 'хостинге',
};

function hostingName(hosting) {
  return HOSTING_LABELS[hosting] || HOSTING_LABELS.other;
}

function diagnose({ error, statusCode, responseMs, timeoutMs, hosting }) {
  const err = (error || '').toLowerCase();
  const hostLabel = hostingName(hosting);

  // Обнаружена типовая страница "аккаунт приостановлен" — проверяем первым,
  // так как статус-код при этом обычно 200 (страница технически загрузилась)
  if (err.includes('suspension_page_detected')) {
    return {
      category: CATEGORY.SUSPENDED,
      label: 'Похоже на страницу приостановки аккаунта',
      explanation: 'Сервер отвечает 200, но содержимое страницы похоже на типовую заглушку "аккаунт приостановлен", которую показывают хостинги вместо реального сайта.',
      suggestion: hosting === 'infinityfree'
        ? 'Зайди в панель InfinityFree и проверь статус аккаунта — возможно, превышены лимиты бесплатного тарифа.'
        : hosting === 'hidden_cloud'
        ? 'Проверь, не истёк ли бесплатный тариф на Hidden Cloud — требуется ручное продление.'
        : `Проверь статус аккаунта в панели ${hostLabel} — похоже, сервис приостановлен.`,
    };
  }

  // Найдена запрещённая фраза (expectedContentAbsent) — например, страница
  // ошибки БД, техработы, или своя специфичная строка вроде "Account suspended"
  if (err.includes('forbidden_content_detected')) {
    const phrase = error.split(': ').slice(1).join(': ');
    return {
      category: CATEGORY.CONTENT_MISMATCH,
      label: 'Обнаружена запрещённая фраза на странице',
      explanation: `Сервер отвечает, но на странице найден текст "${phrase}" — он указан как запрещённый (expectedContentAbsent), что обычно означает ошибку приложения, техработы или другую нежелательную страницу вместо нормального контента.`,
      suggestion: 'Открой сайт в браузере и посмотри, что именно показывается — вероятно, приложение работает некорректно даже при "живом" сервере.',
    };
  }

  // Контент не совпал с ожидаемым (expectedContent) — сайт технически
  // отвечает (обычно 200), но нужного текста на странице нет.
  // Проверяем это ПЕРВЫМ, до статус-кодов — иначе перекроется веткой HTTP_ERROR.
  if (err.includes('ожидаемый текст')) {
    return {
      category: CATEGORY.CONTENT_MISMATCH,
      label: 'Содержимое страницы не совпадает',
      explanation: 'Сайт технически отвечает (HTTP-статус в норме), но ожидаемый текст на странице не найден — вероятно, показывается не та страница (ошибка, заглушка, редирект на другой контент).',
      suggestion: 'Открой сайт в браузере руками и сравни с тем, что ожидалось — возможно, приложение работает некорректно даже при "живом" сервере.',
    };
  }

  // DNS не резолвится — домен не существует или указывает не туда
  if (err.includes('enotfound') || err.includes('getaddrinfo')) {
    return {
      category: CATEGORY.DNS_PROBLEM,
      label: 'Проблема с DNS',
      explanation: 'Домен не резолвится — либо адрес указан неверно, либо DNS-записи ещё не настроены/не распространились.',
      suggestion: 'Проверь правильность домена в настройках монитора и DNS-записи у регистратора.',
    };
  }

  // Сервер отказал в подключении — процесс не запущен, порт закрыт
  if (err.includes('econnrefused')) {
    return {
      category: CATEGORY.CONNECTION_REFUSED,
      label: 'Сервер отказал в подключении',
      explanation: 'Порт закрыт или процесс не запущен на сервере — соединение отклонено сразу.',
      suggestion: hosting === 'render'
        ? `Проверь логи сервиса в панели Render — процесс, скорее всего, упал при старте или крашнулся. Если настроен автоперезапуск через Deploy Hook — он должен сработать сам.`
        : hosting === 'infinityfree'
        ? `На InfinityFree это часто означает, что сайт временно отключён за превышение лимитов бесплатного тарифа. Проверь панель управления на предмет предупреждений.`
        : hosting === 'hidden_cloud'
        ? `Проверь, не истёк ли бесплатный тариф на Hidden Cloud — сервис требует ручного еженедельного продления, иначе автоматически приостанавливается.`
        : `Проверь, запущен ли сам процесс (бот/сайт) на ${hostLabel}, не упал ли он.`,
    };
  }

  // Соединение сброшено на середине
  if (err.includes('econnreset') || err.includes('socket hang up')) {
    return {
      category: CATEGORY.NETWORK_PROBLEM,
      label: 'Соединение оборвалось',
      explanation: 'Сервер начал отвечать, но неожиданно разорвал соединение — часто при падении процесса во время запроса.',
      suggestion: 'Смотри логи хостинга на предмет краша процесса в это время.',
    };
  }

  // Таймаут — сервер не успел ответить
  if (err.includes('таймаут') || err.includes('timeout') || err.includes('etimedout')) {
    const nearLimit = responseMs && timeoutMs && responseMs >= timeoutMs * 0.9;
    return {
      category: CATEGORY.TIMEOUT,
      label: 'Сервер не отвечает вовремя',
      explanation: nearLimit
        ? 'Запрос завис и не уложился в лимит времени — сервер перегружен, завис в бесконечном цикле, или ушёл в спящий режим (актуально для бесплатных хостингов).'
        : 'Не удалось установить соединение за отведённое время.',
      suggestion: (hosting === 'render' || hosting === 'infinityfree')
        ? `${hostLabel} на бесплатном тарифе "усыпляет" сервис при простое. Настрой внешний пинг (например, через cron-job.org) каждые 5 минут, чтобы сервис не засыпал.`
        : 'Если хостинг бесплатный и "засыпает" при простое — рассмотри внешний пинг (cron-job.org) или платный тариф без сна.',
    };
  }

  // SSL/TLS проблемы
  if (err.includes('certificate') || err.includes('ssl') || err.includes('tls') || err.includes('sertifikat')) {
    return {
      category: CATEGORY.SSL_PROBLEM,
      label: 'Проблема с SSL-сертификатом',
      explanation: 'Не удалось установить защищённое соединение — сертификат просрочен, самоподписанный, или не соответствует домену.',
      suggestion: 'Проверь срок действия сертификата в разделе SSL на дашборде.',
    };
  }

  // HTTP статус-коды
  if (statusCode) {
    if (statusCode === 401 || statusCode === 403) {
      return {
        category: CATEGORY.HTTP_ERROR,
        label: 'Доступ запрещён',
        explanation: `Сервер вернул ${statusCode} — либо не хватает авторизации, либо сайт блокирует запросы без "человеческих" заголовков браузера (антибот-защита).`,
        suggestion: 'Если это защита от ботов (Cloudflare и т.п.) — попробуй проверять не корневую страницу, а health-эндпоинт без такой защиты.',
      };
    }
    if (statusCode === 404) {
      return {
        category: CATEGORY.HTTP_ERROR,
        label: 'Страница не найдена',
        explanation: 'Сервер работает и отвечает, но по указанному пути ничего нет (404).',
        suggestion: 'Проверь правильность URL в настройках монитора — возможно, путь изменился.',
      };
    }
    if (statusCode === 429) {
      return {
        category: CATEGORY.HTTP_ERROR,
        label: 'Слишком много запросов',
        explanation: 'Сервер ограничивает частоту запросов (rate limit) — мониторинг стучится слишком часто для его лимитов.',
        suggestion: 'Увеличь интервал проверки (intervalSec) в monitors.json для этого монитора.',
      };
    }
    if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return {
        category: CATEGORY.HOSTING_PROBLEM,
        label: 'Сервер за прокси недоступен',
        explanation: `Код ${statusCode} обычно означает, что сам процесс (бот/приложение) упал или не запущен, а прокси/балансировщик хостинга работает, но не может до него достучаться.`,
        suggestion: hosting === 'render'
          ? 'Проверь логи в панели Render — процесс, скорее всего, крашнулся или ещё не поднялся после деплоя. Если настроен автоперезапуск — он должен сработать сам.'
          : `Проверь логи ${hostLabel} — скорее всего, процесс приложения крашнулся или ещё не поднялся после деплоя.`,
      };
    }
    if (statusCode === 402) {
      return {
        category: CATEGORY.SUSPENDED,
        label: 'Хостинг приостановлен',
        explanation: 'Код 402 (Payment Required) часто означает, что сервис заблокирован из-за неоплаты или истёкшего бесплатного тарифа.',
        suggestion: hosting === 'hidden_cloud'
          ? 'На Hidden Cloud бесплатный тариф требует ручного продления раз в неделю через Dashboard → Renew → Create Invoice. Автоматическое восстановление недоступно — API для этого у них нет.'
          : hosting === 'infinityfree'
          ? 'Проверь панель InfinityFree — бесплатные аккаунты могут блокироваться за превышение лимитов, требуется ручное вмешательство.'
          : `Проверь баланс/статус подписки на ${hostLabel}.`,
      };
    }
    if (statusCode >= 500) {
      return {
        category: CATEGORY.HOSTING_PROBLEM,
        label: 'Внутренняя ошибка сервера',
        explanation: `Сервер вернул ошибку ${statusCode} — проблема в самом коде приложения, а не в сети.`,
        suggestion: 'Смотри логи приложения на хостинге в момент падения — там будет стектрейс ошибки.',
      };
    }
    if (statusCode >= 400) {
      return {
        category: CATEGORY.HTTP_ERROR,
        label: `Ошибка запроса (${statusCode})`,
        explanation: `Сервер вернул код ${statusCode} — запрос отклонён по какой-то причине на стороне клиента.`,
        suggestion: 'Проверь настройки монитора (URL, ожидаемый статус) и логи сервера.',
      };
    }
  }

  // Общий случай — не удалось классифицировать
  return {
    category: CATEGORY.UNKNOWN,
    label: 'Неизвестная ошибка',
    explanation: error || 'Причина не определена автоматически.',
    suggestion: 'Проверь логи хостинга вручную за это время.',
  };
}

module.exports = { diagnose, CATEGORY, detectSuspensionSignature };
