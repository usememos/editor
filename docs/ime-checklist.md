# Manual IME checklist

Automated tests (`e2e/ime.spec.ts`) simulate IME input in Chromium only: composition goes through the Chrome DevTools Protocol, and the events mobile keyboards send are dispatched by the test. They cannot show the candidate window, the order in which other browsers send events, or what a real keyboard does. Before a release, run this checklist by hand with real input methods.

## Setups

Run every check on each setup. Record pass or fail with the browser version.

| OS | Browser | Input methods |
| --- | --- | --- |
| macOS | Safari, Chrome, Firefox | Chinese Pinyin (Simplified), Japanese Kana (Romaji), Korean 2-Set |
| Windows 11 | Edge, Chrome, Firefox | Microsoft Pinyin, Microsoft IME (Japanese), Microsoft IME (Korean) |
| iOS | Safari | Pinyin, Japanese Romaji, Korean, English with autocorrect and dictation |
| Android | Chrome | Gboard with Pinyin, Japanese, Korean, and English with autocorrect |

Open the playground (`npm run dev`, then the "Empty" link) and watch the Markdown output under the editor. The output updates while you compose.

## Checks

The last column names the automated test that covers the same behavior in Chromium, if any. A covered check still needs a real device: the test proves the editor's handling, not the browser's or the keyboard's.

| # | Check | Automated in Chromium |
| --- | --- | --- |
| 1 | Type a full sentence and commit it. The output shows exactly the committed text. | a composition is one undo step |
| 2 | While composing, the candidate window appears next to the caret, the underlined composition text is visible, and the placeholder is gone. | Placeholder only (the model follows the composed text) |
| 3 | Compose in the middle of existing text. Text after the caret is not duplicated or lost. | composing in the middle of text |
| 4 | Compose inside bold text, and after Mod+B in an empty spot. The committed text is bold in the output. | composition inside bold text; marks chosen before composing |
| 5 | Select text across two paragraphs, then start composing. The selection is replaced and the two paragraphs join. | composition over a selection spanning blocks |
| 6 | Compose in an empty paragraph, a heading, a list item, a quote, a code block, and a table cell. | composition starting in an empty block; in a list item and a table cell; in a heading, a quote and a code block |
| 7 | Korean: type a syllable, then a second one that takes the final consonant of the first (가, then ㄴ, then ㅏ). Both syllables are correct, and fast typing does not drop or double a syllable. | Korean: a syllable that takes the next consonant |
| 8 | Press Enter to commit a composition. No new block is created by that same Enter (on macOS Japanese, Enter commits; a second Enter splits). Repeat with the slash menu open: the commit does not pick an item. | Enter that commits a composition |
| 9 | Press Backspace during a composition. Only the composition text changes. | No (the keyboard handles it) |
| 10 | Undo right after a commit removes the committed text in one step. | a composition is one undo step |
| 11 | Japanese: type a full-width slash (`／`). The slash menu opens. Keep composing: the menu filters. | full-width slash; an open suggestion menu filters by the composed text |
| 12 | Select text: the formatting toolbar shows. Start composing: it hides. | the formatting toolbar hides while composing |
| 13 | Android: type with autocorrect on, accept a suggestion, then backspace through it. The output matches the screen. | autocorrect and word suggestions replace the word (events only) |
| 14 | Android: type a word and, while it is still underlined, tap Save. The saved text includes the word. | saving while composing keeps the composed text |
| 15 | Android: type `/` and then `tab` (underlined), then Enter. The table is inserted and no empty line is added. Repeat with `#` and a tag if the tag menu is on. | an open suggestion menu filters; Enter from a keyboard that sends keyCode 229 |
| 16 | iOS: type with autocorrect on (for example "teh "), and tap a QuickType suggestion. The output matches the screen. | autocorrect and word suggestions replace the word (events only) |
| 17 | iOS: use dictation for one sentence. The output matches the screen. | No |
| 18 | macOS: hold a letter key and pick an accented letter from the menu (é). The output shows only the accented letter. | No |
| 19 | Firefox: compose and commit a word with a candidate that differs from the reading (Japanese かんじ → 漢字). Undo removes it in one step. | the last input after compositionend (Firefox order, events only) |

## Not handled yet

- A composition that starts over a selection inside one block deletes the selection first. Japanese reconversion (select text, then press the conversion key) may lose the selected text as the reading. Check on Windows (Microsoft IME, 変換 key) and macOS (Kana key twice).
- Chinese IMEs type `、` for `/` by default. It does not open the slash menu.
