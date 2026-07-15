# Admin Thin Connector Lines Design

## Цель

Убрать визуальное слияние topology routes на общих стволах и пересечениях: длинные кабельные участки должны читаться как тонкие нейтральные трассы, а состояние соединения должно быть сосредоточено в выразительной паре female/male штекеров и тонких цветных status-lanes.

## Принятое решение

- Основной route и target stub рисуются непрерывной нейтральной линией `#596273` шириной `1.75` topology units.
- Общий source trunk использует ту же нейтральную основу. Для каждого уникального состояния поверх него рисуется отдельная непрозрачная lane шириной `1`, смещённая по вертикали; максимум три lanes для demo topology: healthy, warning и degraded.
- Одиночный route сохраняет одну нейтральную основу. Warning/degraded добавляют тонкую цветную status-lane поверх основы, но не превращают весь кабель в толстую цветную полосу.
- Female/male корпуса остаются прямыми и сохраняют существующие notch/tongue и gap semantics. Корпус окрашен по статусу, получает тёмную обводку, внутренний световой штрих и умеренный state-colored glow.
- Внешние торцы штекеров точно совпадают с окончаниями route geometry. Dragging, reset layout, диагностические badge, клики и keyboard activation остаются без изменений.
- Reduced motion продолжает отключать warning spark. Новые трассы не требуют анимации.

## Визуальные инварианты

- Ни один длинный кабельный участок не имеет ширину `6`.
- Пересечение веток не образует непрозрачный цветной блок: нейтральные основы совпадают, а status-lanes остаются тонкими и раздельными.
- Все линии полностью непрозрачны; смешивание через alpha не используется.
- Plug body остаётся визуально толще route и является главным индикатором статуса.
- Status-lanes используют фиксированный порядок `healthy`, `warning`, `degraded`, чтобы цвета не меняли вертикальное положение между render cycles.

## Проверка

- Component tests фиксируют ширину/цвет основы, число и смещение status-lanes, выразительные plug details и отсутствие старых шестипиксельных routes.
- Полный admin regression, typecheck и production build должны пройти.
- Codex in-app browser проверяет desktop и mobile topology, drag/reset, warning/error evidence, отсутствие перекрытий и console warnings/errors.

## Вне области

- Геометрия маршрутизации и module positions.
- API, heartbeat adapter, Docker/Compose и Android APK.
- HomeNode, Coolify, Caddy, UFW и доменные записи.
