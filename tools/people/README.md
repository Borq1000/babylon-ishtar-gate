# Сборка людей (Blender 5.2 + MPFB 2)

Скрипты, которыми собраны `public/models/people/*`. В веб-сборку не входят.

## Что делают

| Файл | Назначение |
|---|---|
| `mh_common.py` | Создание тела MakeHuman через MPFB (макро-параметры, скелет `cmu_mb`, запекание shape keys). |
| `retarget.py` | Перенос мокапа CMU (BVH) на скелет MakeHuman в мировом пространстве, поиск цикла шага, бесшовные петли, аналитическая IK рук для предметов. |
| `garments.py` | Одежда, подогнанная по сечениям тела: туника (длинная или короткая), рукава, нарисованные на руке, веса скининга, удаление скрытого тела. |
| `props.py` | Копья, щиты, штандарты, барабаны, лиры, курильницы, посохи, корзины и кувшины. Также IK-позы рук, чтобы их держать. |
| `build_people.py` | Сборка архетипов одного типа тела (`male`, `elder`, `female`), LOD0–LOD3, клипы, экспорт GLB со сжатием Draco. |
| `collect_textures.py` | Атлас текстур кожи, глаз, бровей, ресниц, волос и бород (`people_atlas.webp`). |

## Подготовка рабочей папки

```
work/
  scripts/        ← эти файлы
  blender-user/   ← отдельный профиль Blender (BLENDER_USER_RESOURCES)
  bvh/            ← 08_01, 08_04, 20_06, 111_28, 18_08, 111_37 .bvh (CMU, github.com/una-dinosauria/cmu-mocap)
  out/
```

1. Установите MPFB в отдельный профиль:
   ```
   BLENDER_USER_RESOURCES=work/blender-user blender --command extension install-file -r user_default -e add-on-mpfb-v2.0.18.zip
   ```
2. Распакуйте CC0-паки `makehuman_system_assets`, `hair01` и `bodyparts05` в `blender-user/extensions/.user/user_default/mpfb/data/`.
3. Соберите типы тел и атлас:
   ```
   ./run.sh scripts/build_people.py -- male
   ./run.sh scripts/build_people.py -- elder
   ./run.sh scripts/build_people.py -- female
   python scripts/collect_textures.py <проект>/public/models/people
   ```
4. Скопируйте `out/people_*.glb` и `out/people_*.json` в `public/models/people/`.

`run.sh` кладётся в корень рабочей папки. Он ожидает Blender по пути `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe` и берёт профиль из `blender-user/` рядом с собой.

## Лицензия

Скрипты вызывают API аддона MPFB (GPL-3.0-or-later), поэтому распространяются под **GPL-3.0-or-later** (см. `LICENSE` в этой папке). Остальной код проекта — MIT.
