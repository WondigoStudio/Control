// Inactivity-based дайджест: вместо отчёта по расписанию (который может
// прийти, пока ты как раз сидишь в дашборде и всё видишь сам) — отчёт
// шлётся один раз, когда система замечает, что дашбордом никто не
// пользовался дольше порога (по умолчанию 6 часов). Типичный случай — ночь:
// последнее действие было вечером, а отчёт придёт при следующей проверке
// после того, как порог пройден, и не повторится, пока не появится новая
// активность и снова не пройдёт достаточно тишины.
//
// "Активность" — это не факт открытой вкладки (автообновление раз в 15с не
// считается), а осознанное действие: логин, ручная проверка, переключение
// обслуживания, изменение конфига монитора. Регистрируется через
// touchActivity() из server.js на соответствующих POST/PUT/DELETE роутах.

const { getActivityState, touchActivity, markReportSent, getAllIncidentsSince, getState } = require('./db');
const { notify } = require('./notifier');

const INACTIVITY_THRESHOLD_MS = (Number(process.env.INACTIVITY_REPORT_HOURS) || 6) * 60 * 60 * 1000;

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} мин`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

async function buildReportText(monitors, sinceTs, now) {
  const httpAndBotMonitors = monitors.filter((m) => m.type !== 'reminder');
  const incidents = await getAllIncidentsSince(sinceTs);

  const byMonitor = new Map(httpAndBotMonitors.map((m) => [m.id, m]));
  const resolved = incidents.filter((i) => i.status === 'recovered');
  const ongoing = incidents.filter((i) => i.status !== 'recovered');

  const lines = [];
  const periodLabel = `${new Date(sinceTs).toLocaleString('ru-RU')} — ${new Date(now).toLocaleString('ru-RU')}`;
  lines.push(`Период: ${periodLabel}`);
  lines.push('');

  if (incidents.length === 0) {
    lines.push('За это время падений не было — все мониторы стабильно отвечали.');
  } else {
    if (resolved.length) {
      lines.push(`Разрешено инцидентов: ${resolved.length}`);
      for (const inc of resolved) {
        const m = byMonitor.get(inc.monitor_id);
        const duration = inc.ended_at ? fmtDuration(inc.ended_at - inc.started_at) : '—';
        lines.push(`  • ${m ? m.name : inc.monitor_id}: простой ${duration}${inc.cause_label ? ` (${inc.cause_label})` : ''}`);
      }
      lines.push('');
    }
    if (ongoing.length) {
      lines.push(`⚠️ Всё ещё недоступно (${ongoing.length}):`);
      for (const inc of ongoing) {
        const m = byMonitor.get(inc.monitor_id);
        const duration = fmtDuration(now - inc.started_at);
        lines.push(`  • ${m ? m.name : inc.monitor_id}: не отвечает уже ${duration}${inc.cause_label ? ` (${inc.cause_label})` : ''}`);
      }
      lines.push('');
    }
  }

  // Явно перечисляем текущий статус всех мониторов внизу — даже если
  // инцидентов не было, полезно одним взглядом увидеть "всё зелёное",
  // а не только отсутствие плохих новостей.
  const statuses = await Promise.all(
    httpAndBotMonitors.map(async (m) => {
      const state = await getState(m.id);
      return { name: m.name, status: state ? state.last_status : 'unknown' };
    })
  );
  const downNow = statuses.filter((s) => s.status === 'down');
  lines.push(`Сейчас: ${statuses.length - downNow.length}/${statuses.length} мониторов в норме.`);

  return lines.join('\n');
}

// Вызывается периодически (раз в 15-30 минут) из server.js. Сама решает,
// нужно ли что-то слать — не полагается на то, что её дёргают точно по
// расписанию.
async function maybeSendInactivityReport(monitors) {
  const state = await getActivityState();
  const now = Date.now();
  const gapMs = now - state.last_activity_ts;

  if (gapMs < INACTIVITY_THRESHOLD_MS) return; // ещё не достаточно долгая тишина

  // Отчёт для ЭТОГО периода тишины уже отправлен (последняя активность была
  // раньше, чем последний отчёт) — не дублируем, пока не появится новая
  // активность и порог не пройдёт заново.
  if (state.last_report_sent_ts && state.last_report_sent_ts >= state.last_activity_ts) return;

  const sinceTs = state.last_report_covers_from || state.last_activity_ts;
  const text = await buildReportText(monitors, sinceTs, now);

  await notify('🌙 Отчёт за время неактивности', text);
  await markReportSent(now, now);
}

module.exports = { maybeSendInactivityReport, touchActivity };
