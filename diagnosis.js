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

function diagnose({ error, statusCode, responseMs, timeoutMs }) {
  const err = (error || '').toLowerCase();

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
      suggestion: 'Проверь, запущен ли сам процесс (бот/сайт) на хостинге, не упал ли он.',
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
      suggestion: 'Если хостинг бесплатный и "засыпает" при простое — рассмотри внешний пинг (cron-job.org) или платный тариф без сна.',
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
        suggestion: 'Проверь логи хостинга — скорее всего, процесс приложения крашнулся или ещё не поднялся после деплоя.',
      };
    }
    if (statusCode === 402) {
      return {
        category: CATEGORY.SUSPENDED,
        label: 'Хостинг приостановлен',
        explanation: 'Код 402 (Payment Required) часто означает, что сервис заблокирован из-за неоплаты или истёкшего бесплатного тарифа.',
        suggestion: 'Проверь баланс/статус подписки на хостинге.',
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

module.exports = { diagnose, CATEGORY };
