// Скачивает Chrome для Puppeteer (нужен только для режима "обход через
// headless-браузер" в слежке за изменениями на сайте). Запускается сам
// через npm postinstall — так это работает на любом хостинге без ручной
// правки Build Command, и не зависит от того, честно ли хостинг
// перевыполняет команду сборки при повторных деплоях с закэшированными
// node_modules.
//
// Puppeteer — optionalDependency: если её не установили (или установка
// самого пакета не удалась на хостинге, который это не поддерживает) —
// просто тихо выходим, ничего не ломая. Обычный HTTP-обход продолжит
// работать как обычно, без браузерного режима.

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('[ensure-chrome] puppeteer не установлен — пропускаю (браузерный режим обхода будет недоступен)');
  process.exit(0);
}

(async () => {
  try {
    // Если Chrome уже скачан и путь рабочий — ничего делать не нужно.
    const existingPath = puppeteer.executablePath();
    const fs = require('fs');
    if (existingPath && fs.existsSync(existingPath)) {
      console.log(`[ensure-chrome] Chrome уже на месте: ${existingPath}`);
      return;
    }
  } catch (e) {
    // executablePath() бросает исключение, если бинарник не найден — это
    // ожидаемо при первой установке, просто идём качать ниже.
  }

  console.log('[ensure-chrome] скачиваю Chrome для Puppeteer (может занять минуту)...');
  try {
    const { execSync } = require('child_process');
    execSync('npx --yes puppeteer browsers install chrome', { stdio: 'inherit' });
    console.log('[ensure-chrome] готово');
  } catch (e) {
    console.log(`[ensure-chrome] не удалось скачать Chrome автоматически: ${e.message}`);
    console.log('[ensure-chrome] браузерный режим обхода будет недоступен, пока не установишь Chrome вручную: npx puppeteer browsers install chrome');
  }
})();
