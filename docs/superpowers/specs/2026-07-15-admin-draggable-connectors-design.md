# Admin Draggable Unified Connectors Design

## Goal

Сделать topology connectors визуально цельными при любом масштабе и во время перетаскивания модулей: кабель, female/male штекер, target stub и module terminal должны читаться как одна физическая цепь без прозрачных наложений, случайного смешивания цветов и ступенчатых швов.

## Accepted Direction

- Использовать единый непрозрачный structural conductor вместо нескольких полупрозрачных route layers.
- `healthy` отображать как полностью слитый зелёный проводник: cable, обе половины штекера и terminal не имеют видимого шва.
- `warning` и `degraded` рисовать поверх structural conductor непрозрачным жёлтым или красным status layer. Alpha blending и чередование цветных dash fragments не используются.
- Состояние соединения читается по цвету и геометрии штекера: connected замкнут, warning имеет малый зазор, degraded имеет явный разрыв. Код остаётся в evidence label и журнале.
- Модули свободно перетаскиваются в пределах topology canvas. Позиции существуют только в текущей сессии страницы и не записываются в API, browser storage или HomeNode.
- Отдельная команда возвращает автоматическую dagre-раскладку.

## Connector Geometry

- Structural cable имеет стабильную высоту `6` topology units на route, plug body и terminal junction.
- Status overlay полностью непрозрачен. На отдельной ветке он занимает всю высоту проводника; на общем source trunk несколько статусов представлены тонкими параллельными lanes внутри одного base conductor.
- Все внешние окончания cable/plug совпадают координатами. Отдельный route-cover поверх полного `BaseEdge` больше не является источником геометрии соединителя.
- Route разбивается на физические участки: source route заканчивается на outer female edge, male half продолжается target stub до terminal. Под центральным разрывом warning/degraded скрытой линии нет.
- Filled plug bodies используются для всех состояний. Notch и tongue остаются прямыми, одного размера и без сужения по длине.
- Line caps на стыках `butt`; corner joins и smooth-step bends не создают выступов за пределы проводника.
- Module terminal совпадает по высоте с conductor и не создаёт отдельный высокий цветной блок. Edge входит в terminal с минимальным перекрытием, устойчивым к zoom.

## Shared Routes

- Для нескольких edges с одним source рисуется один base trunk, а не несколько совпадающих полноразмерных routes.
- `healthy` остаётся зелёной основой. Warning/degraded lanes рисуются непрозрачными жёлтым и красным цветами в фиксированном порядке без alpha blending.
- После точки разведения каждый status lane расширяется в самостоятельную полноразмерную ветку и входит в собственный штекер.
- При drag маршруты и точка разведения пересчитываются из актуальных React Flow coordinates; соединитель не хранит абсолютную экранную геометрию.

## Drag And Reset Behavior

- React Flow nodes становятся draggable; интерактивная карточка модуля остаётся доступной для pointer и keyboard selection.
- Controlled node positions применяют только position changes. Snapshot refresh обновляет module data/status, но не сбрасывает уже перемещённые позиции существующих nodes.
- Новые или удалённые modules синхронизируются с актуальной dagre-раскладкой без потери overrides остальных nodes.
- `Сбросить раскладку` очищает session overrides и возвращает все nodes к dagre positions. Существующая команда сброса выбора сохраняет своё назначение.
- Перезагрузка страницы автоматически возвращает dagre layout.

## Accessibility And Interaction

- Drag не отключает Enter/Space и pointer selection карточки.
- Incident contacts сохраняют pointer, Enter и Space activation и открывают точный журнал.
- Status overlay декоративен; accessible edge label остаётся единственным описанием состояния.
- Evidence labels и traffic values следуют за edge geometry и не перекрываются module cards.
- Постоянная motion-анимация не добавляется; `prefers-reduced-motion` продолжает отключать warning spark.

## Testing And Validation

- RED/GREEN component tests фиксируют непрерывность outer cable/plug coordinates, отсутствие route под разрывом и непрозрачные status layers.
- Shared-route tests фиксируют один base trunk, стабильный порядок lanes и отсутствие нескольких overlapping full routes.
- Topology tests фиксируют применение position changes, сохранение session overrides при data refresh и reset к dagre layout.
- Browser QA перетаскивает как минимум middle и outer-row modules, проверяет пересчёт всех связанных routes, отсутствие швов/ступеней на fit и zoom, а затем проверяет reset layout.
- Browser QA повторно открывает `DLW-E502`, проверяет evidence labels, console warnings/errors и отсутствие module overlap.
- Полный admin test suite, typecheck, production build и `git diff --check` обязательны до merge в `main`.

## Out Of Scope

- Сохранение пользовательской раскладки между перезагрузками.
- Backend API для layout preferences.
- Изменения Coolify, HomeNode, Caddy, UFW или provider containers.
- Создание или удаление topology edges пользователем.
