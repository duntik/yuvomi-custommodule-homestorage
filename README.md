# Хозяйство: модуль для Yuvomi

Сторонний модуль для [Yuvomi](https://github.com/ulsklyc/yuvomi): отдельная страница для хозяйственных запасов. Зубная паста, туалетная бумага, таблетки для посудомойки и всё, что расходуется.

*English summary below.*

## Что умеет

- Отдельный пункт «Хозяйство» в меню, не внутри «Кухни».
- Партии с одинаковым названием и единицей собираются в один товар: «Паста 9 шт.: ванная 1, чердак 8».
- Минимум и цель на уровне товара. Минимум сравнивается с суммой всех партий.
- Кнопки −1 и +1 прямо в списке. −1 берёт из партии, которая раньше портится, затем из самой маленькой.
- Когда запас опускается до минимума, модуль предлагает докупить до цели: «Осталось 3. Добавить 9 в покупки?».
- Переключатель «Хозяйство / Еда / Все» и фильтр «Заканчивается».
- Интерфейс на русском и английском.

## Где хранятся данные

Модуль ничего не хранит сам. Каждая позиция это обычная запись в разделе «Запасы» Yuvomi. Поэтому данные общие для всей семьи, видны в обычных «Запасах» и остаются, даже если модуль удалить.

Минимум и цель записываются в конец заметки одной из партий в виде `[stock min=3 target=12]`. Эту метку не надо трогать руками.

На устройстве запоминаются только личные настройки: выбранный вид, какие категории считать хозяйственными, какой список покупок использовать.

## Установка

**Через настройки Yuvomi**, если ваша версия умеет ставить модули из интерфейса: «Настройки → Модули → Добавить свой модуль», вставьте ссылку

```
https://github.com/duntik/yuvomi-custommodule-homestorage
```

Модуль установится выключенным. Включите его в «Настройки → Модули → Активные модули».

**Вручную**: скопируйте папку `modules/household-supplies` в папку модулей Yuvomi на сервере. Для Docker Compose это `./modules/` рядом с `docker-compose.yml`. Перезапуск не нужен: через полминуты модуль появится в «Активных модулях».

Участникам семьи нужен доступ к разделу «Запасы», а для кнопки «В покупки» ещё и к разделу «Покупки».

## Структура

```
modules/household-supplies/   сам модуль, только это попадает в Yuvomi
  module.json                 описание модуля
  index.js                    страница
  logic.js                    расчёты без интерфейса и сети
  style.css                   стили на токенах дизайна Yuvomi
  locales/                    переводы
test/                         тесты логики
```

## Проверка логики

```
npm test
```

---

## English summary

A third-party module for Yuvomi that gives household consumables their own page. It groups pantry batches with the same name and unit into one product, keeps a minimum and a target per product, offers one-tap −1/+1, and suggests adding "target minus current" to the shopping list when stock reaches the minimum. It stores nothing of its own: every item is a regular Yuvomi pantry row, and the product minimum and target live in a `[stock min=N target=M]` marker at the end of one batch's notes.

Install by copying `modules/household-supplies` into Yuvomi's modules folder, or, where supported, from Settings → Modules → Add custom module with this repository's URL.
