# Admin Connector Ports Design

## Goal

Сделать стык topology edge с модулем визуально цельным в выбранном варианте 3: короткая линия входит в тонкий статусный терминал на границе карточки, без стрелки и круглого React Flow handle.

## Accepted Direction

- Сохранить прямые male/female штекеры с выемкой и ответным выступом.
- Сдвинуть пару штекеров от target module так, чтобы между male half и модулем оставался короткий прямой участок.
- Удалить `ArrowClosed`: направление уже читается left-to-right, а стрелка конфликтует со штекером и портом.
- Заменить видимую круглую точку handle двумя узкими прямоугольными терминалами на боковых гранях модуля.
- Цвет терминала определяется статусом самого модуля. Это не создаёт конфликтующих цветов, когда несколько edges используют один source handle.
- Edge сохраняет собственный status color; короткий участок физически входит в terminal с небольшим перекрытием, исключающим визуальный зазор на разных zoom levels.

## Geometry

- Сохранить contact length `32` topology units.
- Добавить target-side line stub `12` topology units между male plug и target module.
- Terminal занимает `6 x 16` topology units, наполовину утоплен в границу module card.
- Default React Flow handles остаются в DOM для route geometry, но становятся прозрачными.
- Терминалы принадлежат `ServiceNode`, поэтому не дублируются при нескольких edges и всегда остаются поверх edge layer.

## States And Motion

- Terminal использует существующие health colors: healthy, warning, degraded, unknown.
- Дополнительная постоянная анимация терминала не добавляется.
- Существующая warning spark и disconnected contact motion остаются без изменений и продолжают учитывать `prefers-reduced-motion`.

## Accessibility

- Терминалы декоративные и получают `aria-hidden="true"`.
- Существующие accessible edge labels, keyboard activation и incident journal behavior не меняются.

## Validation

- Unit test фиксирует отсутствие marker, новый target stub offset и сохранение straight final segment для bent edges.
- Component/config test фиксирует два terminal элемента и прозрачные React Flow handles.
- Admin test suite, typecheck и production build должны пройти.
- In-app browser QA проверяет desktop и mobile: отсутствие зазоров, стрелок, наложений и console warnings; incident edge остаётся интерактивным.
