# Languages: English, then French, then Hebrew

The app can be shown in French and Hebrew, but only English is switched on
until a fluent person has read each translation.

## How it works

- All translated text lives in `apps/web/src/i18n/`: `en.ts` (the source),
  `fr.ts` and `he.ts`. Each language must have every English key and no
  others; `src/test/i18n.test.ts` fails otherwise, and also fails on empty
  strings, raw keys and mismatched `{placeholders}`.
- A screen that has not been translated yet stays in English. A raw key is
  never shown.
- Hebrew is shown right to left (`<html dir="rtl">`); the side menu and the
  main column use logical sides so they mirror.
- Dates and times follow the chosen language, in Montreal time.
- People choose their language on the sign-in page and in Settings. The
  choice is saved on their account (`users.locale`, which already existed)
  and follows them to other devices.

## What is translated so far

Sign-in page, main menu and bottom bar, the More / Admin / My profile hub
pages, the language setting, and shared messages. Other screens are still
English; they are converted screen by screen, each with its keys added to
all three catalogs. Messages sent by text or email are not translated yet.

## Switching a language on

1. A fluent speaker reads `fr.ts` (or `he.ts`) in full, ideally with the app
   open in that language on staging (`LANGUAGES_ENABLED=en,fr,he`), and fixes
   anything wrong.
2. They write their name on the `Reviewed by:` line at the top of the file.
3. Only then set `LANGUAGES_ENABLED=en,fr` (or `en,fr,he`) on rvc-api.

The French and Hebrew text in this branch is a machine-assisted draft. It has
not been reviewed.
